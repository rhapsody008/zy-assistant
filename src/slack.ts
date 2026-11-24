// Slack: the DM channel the assistant talks in, the ping messages with their
// buttons, and the DM commands. Bolt over socket mode, so no public URL.
//
// The two handlers are plain functions over HandlerDeps (a Slack client, the
// store, the board), so they can be tested without Bolt and without network.

import { App, LogLevel } from "@slack/bolt";
import { addHandler, addSpec, proposalId, type AddDeps, type AddInput, type AddUi } from "./add-handler.ts";
import { askQuestion, type AskDeps, type AskInput, type AskUi } from "./ask.ts";
import { errMessage } from "./errors.ts";
import type { BoardSource } from "./github.ts";
import { helpReply, type ManualSettings } from "./manual.ts";
import {
  cardText,
  parseProposalValue,
  proposalClick,
  proposalEdited,
  proposalValue,
  type Card,
  type EditField,
  type ProposalButton,
  type ProposalDeps,
  type ProposalUi,
} from "./proposals.ts";
import { plan, type ActionId, type Briefing, type Item, type Ping } from "./rules.ts";
import { FIELD, STATUS } from "./schema.ts";
import {
  FOLDER_BLOCK_PREFIX,
  parseScribeChoice,
  scribeChoice,
  scribeHandler,
  type ScribeAsk,
  type ScribeDeps,
  type ScribeDictation,
  type ScribeUi,
} from "./scribe-handler.ts";
import type { PingRecord, PingStore } from "./store.ts";
import { addDays, fmtDate, localNow, nextWorkday, TZ } from "./time.ts";

export interface Sent {
  channel: string;
  ts: string;
}

/** A briefing's message, and the rows the scheduler has to record. */
export interface BriefingSent extends Sent {
  /**
   * The ping keys to record: the rows whose row carries a ⋯ menu, and only
   * those, since a row nobody can click has nothing to handle. A message whose
   * blocks were refused carries every row here instead (see sendBriefing).
   */
  menuKeys: string[];
}

export interface Sender {
  sendDm(text: string): Promise<Sent>;
  /** target: the item's Target date now, so the move modal opens on it. */
  sendPing(ping: Ping, target: string | null): Promise<Sent>;
  /** targets: itemId -> the item's Target date now, for the rows' move menu. */
  sendBriefing(briefing: Briefing, targets: ReadonlyMap<string, string | null>): Promise<BriefingSent>;
}

/** The ⋯ menu of a row: one section with an overflow on it, nothing more. */
interface OverflowElement {
  type: "overflow";
  action_id: string;
  options: Array<{ text: { type: "plain_text"; text: string }; value: string }>;
}

interface SectionBlock {
  type: "section";
  text: { type: "mrkdwn"; text: string };
  block_id?: string;
  accessory?: OverflowElement;
}

interface ContextBlock {
  type: "context";
  elements: Array<{ type: "mrkdwn"; text: string }>;
}

interface ButtonElement {
  type: "button";
  action_id: string;
  text: { type: "plain_text"; text: string };
  value: string;
  style?: "primary" | "danger";
}

interface SelectElement {
  type: "static_select";
  action_id: string;
  placeholder: { type: "plain_text"; text: string };
  options: Array<{ text: { type: "plain_text"; text: string }; value: string }>;
}

interface ActionsBlock {
  type: "actions";
  block_id?: string;
  elements: Array<ButtonElement | SelectElement>;
}

export type Block = SectionBlock | ContextBlock | ActionsBlock;

export interface PostMessageArgs {
  channel: string;
  text: string;
  blocks?: Block[];
  thread_ts?: string;
}

export interface UpdateMessageArgs {
  channel: string;
  ts: string;
  text: string;
  blocks?: Block[];
}

/** The part of Slack's WebClient the handlers use. */
export interface SlackClient {
  chat: {
    postMessage(args: PostMessageArgs): Promise<{ ts?: string }>;
    update(args: UpdateMessageArgs): Promise<unknown>;
  };
  views: {
    open(args: ViewsOpenArgs): Promise<unknown>;
  };
}

export interface ViewsOpenArgs {
  trigger_id: string;
  view: {
    type: "modal";
    callback_id: string;
    private_metadata: string;
    title: { type: "plain_text"; text: string };
    submit: { type: "plain_text"; text: string };
    close: { type: "plain_text"; text: string };
    blocks: ModalBlock[];
  };
}

/** One option of a modal's select: the words a person reads, and what the submit carries. */
interface ModalOption {
  text: { type: "plain_text"; text: string };
  value: string;
}

/** The three elements a modal input can hold: a date, a line of text, or one of a list. */
type ModalElement =
  | { type: "datepicker"; action_id: string; initial_date?: string }
  | { type: "plain_text_input"; action_id: string; initial_value?: string; max_length?: number }
  | { type: "static_select"; action_id: string; options: ModalOption[]; initial_option?: ModalOption };

/** The block a modal is built from: a label, whether it may be left empty, and its element. */
type ModalBlock = {
  type: "input";
  block_id: string;
  label: { type: "plain_text"; text: string };
  optional?: boolean;
  element: ModalElement;
};

/** Slack rejects a section block over 3000 characters. */
const MAX_SECTION_TEXT = 2900;

/** Its private_metadata has a hard cap too, and the ping text rides in it. */
const MAX_METADATA_TEXT = 2000;

/** The action_id of a row's ⋯ menu, and the prefix of the block that carries its key. */
export const ROW_ACTION = "zy_row";
const ROW_PREFIX = "zy_row:";

/** Slack takes at most 50 blocks in a message. */
const MAX_BLOCKS = 50;

/**
 * The most rows that can carry a menu. Head, tail and the rest of the rows have
 * to fit in the same 50 blocks, so how many rows really get one is worked out
 * from what those leave over, and is never more than this.
 */
const MAX_MENU_ROWS = 30;

/** The callback_id of the move-date modal, and of a proposal's Edit modal. */
const MOVE_CALLBACK = "zy_move";
const PROP_EDIT_VIEW = "zy_prop_edit_view";

/** A card's actions block is zy_prop:<proposal id>; its buttons are zy_prop_<button>. */
const PROP_PREFIX = "zy_prop:";
const PROP_ACTION_PREFIX = "zy_prop_";

/** The order a card's buttons are drawn in, and the words they carry. */
const PROPOSAL_LABELS: Record<ProposalButton, string> = {
  create: "Create",
  edit: "Edit",
  cancel: "Cancel",
  retry: "Retry",
};

/** The buttons that are the approval: they are the ones drawn as the card's primary action. */
const PROPOSAL_PRIMARY: ProposalButton[] = ["create", "retry"];

const LABELS: Record<ActionId, string> = {
  ack: "👍 On it",
  move: "Move date",
  done: "✅ Done",
  touch1: "Tomorrow",
  touch7: "+7 days",
};

/**
 * The row menu's labels, one per action. A menu is a list, not a row of buttons,
 * so the words are the plain ones; the buttons under an evening ping keep theirs.
 * A new ActionId has to be added here, and the five-option limit in the tests
 * then fails until it is dealt with.
 */
export const ROW_LABELS: Record<ActionId, string> = {
  ack: "Got it",
  done: "Done",
  touch1: "+1 day",
  touch7: "+7 days",
  move: "Move date…",
};

/** Slack rejects a select with more than 100 options. */
const MAX_SELECT_OPTIONS = 100;

/**
 * What a DM that is no command gets when there is no model to ask: the ask takes
 * such a DM whenever the LLM is set. `note:` is only offered when the scribe is
 * on, and `add:` only when ADD_REPO and the model are both set.
 */
export function unknownDmHint(scribe: boolean, add = false): string {
  if (add) {
    return scribe
      ? "I didn't catch that. Type `today`, `add: …`, `note: …`, or `help`."
      : "I didn't catch that. Type `today`, `add: …`, or `help`.";
  }
  return scribe
    ? "I didn't catch that. Type `today`, `note: …`, or `help`."
    : "I didn't catch that. Type `today` or `help`.";
}

/**
 * What a DM asks the manual for: "" for the overview, the topic word for a page,
 * and null when the message is no help request. Case and spacing do not matter.
 */
export function helpRequest(text: string): string | null {
  const match = /^(?:help|\?|manual)(?:\s+([\s\S]+))?$/i.exec(text.trim());
  if (!match) return null;
  return (match[1] ?? "").trim();
}

/**
 * True for the command that previews today's plan: `today`, or `briefing`, the
 * name it had before 0.4.2. Case and spacing do not matter.
 */
export function isTodayCommand(text: string): boolean {
  const word = text.trim().toLowerCase();
  return word === "today" || word === "briefing";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * A ping button's value: the ping key, and the Target date the item has now, so
 * the move modal can open on it without a board read (a trigger_id lives for
 * three seconds).
 */
interface ButtonValue {
  key: string;
  target: string | null;
}

const buttonValue = (key: string, target: string | null): ButtonValue => ({ key, target });

/** A button value; a button from before the value carried a date is a bare key. */
function parseButtonValue(raw: string | null): ButtonValue | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.key === "string") {
      return { key: parsed.key, target: typeof parsed.target === "string" ? parsed.target : null };
    }
  } catch {
    // Not JSON: an old button, whose value is the ping key alone.
  }
  return { key: raw, target: null };
}

export function truncate(text: string, max = MAX_SECTION_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text) } };
}

function context(text: string): ContextBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function actions(value: ButtonValue, ids: ActionId[]): ActionsBlock {
  return {
    type: "actions",
    elements: ids.map((id) => ({
      type: "button",
      action_id: `zy_${id}`,
      text: { type: "plain_text", text: LABELS[id] },
      value: JSON.stringify(value),
    })),
  };
}

/** The blocks of a ping: its text, and its buttons carrying the date it has now. */
export function pingBlocks(ping: Ping, target: string | null): Block[] {
  return [section(truncate(ping.text)), actions(buttonValue(ping.key, target), ping.actions)];
}

/** One entry of a row's ⋯ menu: the words a person reads, and what the click carries. */
export interface RowOption {
  label: string;
  value: string;
}

/**
 * A section with a ⋯ menu on it. It knows nothing about items: the caller gives
 * the words, the block_id it wants back, and the options. The briefing is its
 * first use; the proposal cards will be its next one.
 */
export function rowBlock(text: string, blockId: string, options: readonly RowOption[]): SectionBlock {
  return {
    type: "section",
    block_id: blockId,
    text: { type: "mrkdwn", text },
    // Slack takes five, and a sixth would make the whole message invalid: the
    // options come from the ActionIds, and the labels test fails on a sixth one
    // long before a menu can be built from it.
    accessory: {
      type: "overflow",
      action_id: ROW_ACTION,
      options: options.map((option) => ({
        text: { type: "plain_text", text: option.label },
        value: option.value,
      })),
    },
  };
}

/**
 * A row's menu, in the order its actions came in. The values are short and fixed:
 * `ack`, `done`, `touch1`, `touch7`, and `move|<the date the modal opens on>`.
 */
export function rowOptions(actionIds: readonly ActionId[], target: string | null): RowOption[] {
  return actionIds.map((id) => ({ label: ROW_LABELS[id], value: id === "move" ? `move|${target ?? ""}` : id }));
}

/**
 * A proposal card: the head and the thing it is about in one section, its one
 * line of context, and the buttons the row still offers. The block_id names the
 * proposal so a click finds it, and the rev rides in every button's value: a
 * click on a card that has moved on is the rev's business, not the renderer's.
 */
export function cardBlocks(id: string, rev: number, card: Card): Block[] {
  const blocks: Block[] = [section([card.head, ...card.lines].join("\n")), context(card.context)];
  if (card.buttons.length === 0) return blocks;
  blocks.push({
    type: "actions",
    block_id: `${PROP_PREFIX}${id}`,
    elements: card.buttons.map((button) => ({
      type: "button",
      action_id: `${PROP_ACTION_PREFIX}${button}`,
      text: { type: "plain_text", text: PROPOSAL_LABELS[button] },
      value: proposalValue(id, rev),
      // The approval is the one a person is meant to reach for.
      ...(PROPOSAL_PRIMARY.includes(button) ? { style: "primary" as const } : {}),
    })),
  });
  return blocks;
}

/**
 * The blocks of a briefing: the sections above it, one block per row, the rows
 * that got no menu, then the sections under it.
 *
 * A menu costs a block and Slack takes 50, so only as many rows carry one as the
 * sections above and below leave room for, at most MAX_MENU_ROWS. The rest are
 * listed as text: a row nobody can click is still a row to read.
 */
export function briefingBlocks(briefing: Briefing, targets: ReadonlyMap<string, string | null>): Block[] {
  const head: Block[] = [];
  for (const text of briefing.head) pushSections(head, text);
  const tail: Block[] = [];
  for (const text of briefing.tail) pushSections(tail, text);

  for (let menus = Math.min(MAX_MENU_ROWS, briefing.rows.length); ; menus -= 1) {
    const blocks = [
      ...head,
      ...briefing.rows
        .slice(0, menus)
        .map((row) => rowBlock(truncate(row.text), `${ROW_PREFIX}${row.key}`, rowOptions(row.actions, targets.get(row.itemId) ?? null))),
      ...restBlocks(briefing.rows.slice(menus)),
      ...tail,
    ];
    // At no menu at all there is nothing left to give up: head and tail over 50
    // blocks are a message Slack refuses before any row is in it.
    if (blocks.length <= MAX_BLOCKS || menus === 0) return blocks;
  }
}

/** The rows that got no menu: a heading, then their own lines at a section's length. */
function restBlocks(rows: readonly Ping[]): Block[] {
  if (rows.length === 0) return [];
  const blocks: Block[] = [section(`…${rows.length} more (no menu: message limit)`)];
  for (const chunk of splitLines(rows.map((row) => `• ${row.text}`).join("\n"))) blocks.push(section(chunk));
  return blocks;
}

/** The ping keys whose row carries a menu: the rows that can be clicked at all. */
export function menuKeys(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "section" && block.block_id?.startsWith(ROW_PREFIX) ? [block.block_id.slice(ROW_PREFIX.length)] : [],
  );
}

/** Sections of at most `max` characters, split at a line break: no text is dropped. */
function pushSections(blocks: Block[], text: string): void {
  for (const chunk of splitLines(text)) blocks.push(section(chunk));
}

/** `text` in chunks of at most `max` characters, cut at line breaks where it can. */
export function splitLines(text: string, max = MAX_SECTION_TEXT): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const piece of text.split("\n").flatMap((line) => (line.length <= max ? [line] : sliceLine(line, max)))) {
    if (chunk !== "" && chunk.length + 1 + piece.length > max) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk = chunk === "" ? piece : `${chunk}\n${piece}`;
  }
  if (chunk !== "" || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

/** A line longer than a section takes, cut anywhere: nothing is lost. */
function sliceLine(line: string, max: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < line.length; at += max) pieces.push(line.slice(at, at + max));
  return pieces;
}

/** The buttons of a message we sent, so a failed click can keep them. */
function keptActions(blocks: unknown, value: ButtonValue): ActionsBlock | null {
  const ids: ActionId[] = [];
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "actions" || !Array.isArray(block.elements)) continue;
      for (const element of block.elements) {
        const id = isRecord(element) && typeof element.action_id === "string" ? parseActionId(element.action_id) : null;
        if (id) ids.push(id);
      }
    }
  }
  return ids.length > 0 ? actions(value, ids) : null;
}

/** The text of a ping message we sent, so an update can keep it. */
function originalText(blocks: unknown, fallback: unknown): string {
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (isRecord(block) && block.type === "section" && isRecord(block.text) && typeof block.text.text === "string") {
        return block.text.text;
      }
    }
  }
  return typeof fallback === "string" ? fallback : "";
}

function parseActionId(actionId: string): ActionId | null {
  switch (actionId) {
    case "zy_ack":
      return "ack";
    case "zy_move":
      return "move";
    case "zy_done":
      return "done";
    case "zy_touch1":
      return "touch1";
    case "zy_touch7":
      return "touch7";
    default:
      return null;
  }
}

export interface HandlerDeps {
  client: SlackClient;
  store: PingStore;
  board: BoardSource;
  owner: string;
  number: number;
  userId: string; // ZY: the only person the bot obeys
  now: () => Date;
  log: (line: string) => void;
  /** What the manual quotes: the two slot times, the notes repo, the live policy. */
  manual: ManualSettings;
  /** The last blocks of each briefing we still edit, and one edit at a time per message. */
  rows: RowEdits;
  /** The scribe, when LLM_BASE_URL and friends are set: null turns "note: ..." off. */
  scribe?: ScribeDispatch | null;
  /** The ask, when the LLM is set: null answers a question with the hint again. */
  ask?: AskDispatch | null;
  /** The add: pipeline, when ADD_REPO and the model are set: null answers like any other DM. */
  add?: AddDispatch | null;
  /** The proposal machinery the cards route into: absent means no card can be clicked. */
  proposals?: ProposalDeps | null;
}

/**
 * A briefing's rows are edited in place, so the blocks of the message have to be
 * kept: `blocks` is the last state written per message ts (the last
 * CACHED_MESSAGES of them, oldest dropped), and `queues` serializes the updates
 * of one message so two quick clicks cannot each write a stale copy.
 * It is in memory only: after a restart the click's own copy is the fallback, and
 * a move submitted from a menu it cannot place is said in the thread instead.
 */
export interface RowEdits {
  blocks: Map<string, Block[]>;
  queues: Map<string, Promise<void>>;
}

/** How many messages have their blocks kept: one edit each, and no unbounded map. */
const CACHED_MESSAGES = 20;

export function rowEdits(): RowEdits {
  return { blocks: new Map(), queues: new Map() };
}

/** The scribe, called without being awaited: Slack wants its three seconds. */
export type ScribeDispatch = (dictation: ScribeDictation, ui: ScribeUi) => Promise<void>;

/** The ask, called without being awaited for the same reason. */
export type AskDispatch = (input: AskInput, ui: AskUi) => Promise<void>;

/** The add: pipeline, called without being awaited: a model draft takes a while. */
export type AddDispatch = (input: AddInput, ui: AddUi) => Promise<void>;

export interface ActionClick {
  actionId: string; // raw action_id, e.g. "zy_done"
  value: string | null; // the ping key
  userId: string;
  channel: string | null;
  ts: string | null;
  blocks: unknown; // the message as Slack sent it, for its text and buttons
  text: string | null;
  triggerId: string | null; // needed to open a modal from the click
}

export interface DmMessage {
  userId: string;
  channel: string;
  ts: string;
  threadTs: string | null;
  text: string;
}

/** The day a "Tomorrow" / "+7 days" button sets Next touch to, rolled off the weekend. */
export function touchDate(today: string, action: "touch1" | "touch7"): string {
  return nextWorkday(addDays(today, action === "touch1" ? 1 : 7));
}

/** True when a model is set: a DM that is no command is a question. */
const askOn = (deps: HandlerDeps): boolean => deps.ask !== null && deps.ask !== undefined;

/** True when a dictation would be scribed: the note topic and the note: line. */
const scribeOn = (deps: HandlerDeps): boolean => deps.scribe !== null && deps.scribe !== undefined;

/** True when a sentence would be drafted into an item: ADD_REPO and the model are both set. */
const addOn = (deps: HandlerDeps): boolean => deps.add !== null && deps.add !== undefined;

/**
 * What a click has in common with a menu pick once it is parsed: the action and
 * the ping it is about, and where the message is. `row` says which of the two it
 * is, since only a row has a menu to keep and a row to edit.
 */
interface Pick {
  action: ActionId;
  key: string;
  target: string | null; // the date a move modal opens on
  userId: string;
  channel: string;
  ts: string;
  blocks: unknown; // the message as Slack sent it
  text: string | null; // the message's own text, for a button's move modal
  triggerId: string | null;
  row: boolean;
}

/** How a pick's outcome is shown: a button redraws its message, a row edits itself. */
interface PickUi {
  /** The board write is done: `result` is the line it earned. */
  done(result: string): Promise<void>;
  /** The board write failed: the buttons stay for a retry, or the thread says so. */
  failed(error: string): Promise<void>;
}

/**
 * The work behind a button and behind a menu pick: whose click it is, which ping
 * it is about, the move modal, the board write, the ack and the log line. Only
 * how the outcome is shown differs (PickUi).
 *
 * A pick on a row already handled writes nothing: the first pick is what counts.
 * The buttons path predates that guard and keeps its old behaviour: a second
 * press writes the board again, which is idempotent for all five actions.
 */
async function runPick(deps: HandlerDeps, pick: Pick, ui: PickUi): Promise<void> {
  if (pick.userId !== deps.userId) return;
  const what = pick.row ? "row" : "button";

  const ping = deps.store.findByKey(pick.key);
  if (!ping) {
    deps.log(`${what} ${pick.action}: unknown ping ${pick.key}`);
    return;
  }

  if (pick.row && ping.ackedAt) {
    deps.log(`row ${pick.action} on ${pick.key}: already handled, this pick does nothing`);
    await replyInThread(deps, pick.channel, pick.ts, "already handled");
    return;
  }

  // Moving a date needs a date and a reason: the modal collects both, and the
  // ping is only acked when its own view is submitted.
  if (pick.action === "move") {
    await openMoveModal(deps, {
      triggerId: pick.triggerId,
      channel: pick.channel,
      ts: pick.ts,
      key: ping.key,
      target: pick.target,
      // A row carries its own words; a button's message carries its text.
      text: pick.row ? rowText(deps.rows, pick.ts, pick.key, pick.blocks) : truncate(originalText(pick.blocks, pick.text), MAX_METADATA_TEXT),
      ...(pick.row ? { row: true } : {}),
    });
    return;
  }

  let result: string;
  try {
    result = await applyAction(deps, pick.action, ping);
  } catch (err) {
    deps.log(`${what} ${pick.action} on ${pick.key} failed: ${errMessage(err)}`);
    await ui.failed(errMessage(err));
    return;
  }

  deps.store.markAcked(pick.key, deps.now().toISOString());
  deps.log(`button ${pick.action} on ${ping.itemId} by ${pick.userId}`);
  await ui.done(result);
}

/** A button click. Only ZY's clicks do anything; ZY's click is the board approval. */
export async function handleAction(deps: HandlerDeps, click: ActionClick): Promise<void> {
  const actionId = parseActionId(click.actionId);
  const button = parseButtonValue(click.value);
  const { channel, ts } = click;
  if (!actionId || !button || !channel || !ts) return;
  const text = originalText(click.blocks, click.text);

  await runPick(
    deps,
    { action: actionId, key: button.key, target: button.target, userId: click.userId, channel, ts, blocks: click.blocks, text: click.text, triggerId: click.triggerId, row: false },
    {
      async done(result) {
        // The write is done: if the message update fails it is only cosmetic.
        await updateMessage(deps, channel, ts, `${text}\n→ ${result}`, [section(text), context(`→ ${result}`)]);
      },
      async failed(error) {
        // Say so and keep the buttons, so the click can be retried.
        const failure = `→ failed: ${error}`;
        const kept = keptActions(click.blocks, button);
        await updateMessage(deps, channel, ts, `${text}\n${failure}`, [section(text), ...(kept ? [kept] : []), context(failure)]);
      },
    },
  );
}

/**
 * A pick from a row's ⋯ menu. The ping key rides in the block_id, the action and
 * the date a move opens on in the option's value. The row is replaced in place,
 * so the rest of the briefing keeps its menus.
 */
export async function handleRowAction(deps: HandlerDeps, click: RowClick): Promise<void> {
  const pick = parseRowValue(click.value);
  const key = rowKeyOf(click.blockId);
  const { channel, ts } = click;
  if (!pick || key === null || !channel || !ts) return;

  await runPick(
    deps,
    { action: pick.action, key, target: pick.target, userId: click.userId, channel, ts, blocks: click.blocks, text: null, triggerId: click.triggerId, row: true },
    {
      async done(result) {
        // The row is edited where it stands. Without the blocks (a restart in
        // between) the row is left as it is and the thread carries the line.
        if (!(await markRow(deps, channel, ts, key, `→ ${result}`, click.blocks))) {
          await replyInThread(deps, channel, ts, `→ ${result}`);
        }
      },
      async failed(error) {
        // The board write failed: the menu stays, so the pick can be made again.
        await replyInThread(deps, channel, ts, `→ failed: ${error}`);
      },
    },
  );
}

/** What a menu pick carries: the ping key is in the block, the rest in the value. */
export interface RowClick {
  value: string | null; // selected_option.value: "ack", "move|2026-12-02"
  blockId: string | null; // "zy_row:<ping key>"
  userId: string;
  channel: string | null;
  ts: string | null;
  blocks: unknown; // the message as Slack sent it, for a row the cache has forgotten
  triggerId: string | null; // needed to open the move modal from the menu
}

interface RowValue {
  action: ActionId;
  target: string | null;
}

/** "ack" -> ack, "move|2026-12-02" -> move on that date, anything else -> null. */
function parseRowValue(raw: string | null): RowValue | null {
  if (!raw) return null;
  const [word, date = ""] = raw.split("|");
  if (!isActionId(word)) return null;
  return { action: word, target: date === "" ? null : date };
}

const isActionId = (word: string): word is ActionId => Object.prototype.hasOwnProperty.call(ROW_LABELS, word);

/** The ping key in a row's block_id, or null when the block is no row of ours. */
function rowKeyOf(blockId: string | null): string | null {
  if (!blockId || !blockId.startsWith(ROW_PREFIX)) return null;
  const key = blockId.slice(ROW_PREFIX.length);
  return key === "" ? null : key;
}

/**
 * Replaces one row of a message with its text and `line` under it, and leaves the
 * other rows alone. The blocks come from the last state we wrote, or from the
 * click when the cache has none (a restarted bot still gets the click's copy).
 * Updates of one message are serialized: two quick clicks cannot each write over
 * the other's edit with a copy that has forgotten it.
 */
async function markRow(
  deps: HandlerDeps,
  channel: string,
  ts: string,
  key: string,
  line: string,
  fallback: unknown,
): Promise<boolean> {
  const previous = deps.rows.queues.get(ts) ?? Promise.resolve();
  const edit = previous.then(() => replaceRow(deps, channel, ts, key, line, fallback));
  // The queue holds one entry per message while an edit is in flight, and no
  // entry once it is done: a bot that runs for weeks would otherwise keep a
  // settled promise for every message it ever edited.
  const entry: Promise<void> = edit.then(
    () => {},
    () => {},
  );
  deps.rows.queues.set(ts, entry);
  void entry.finally(() => {
    if (deps.rows.queues.get(ts) === entry) deps.rows.queues.delete(ts);
  });
  return edit;
}

/** One row's edit, unless that row is not in the blocks we can see. */
async function replaceRow(
  deps: HandlerDeps,
  channel: string,
  ts: string,
  key: string,
  line: string,
  fallback: unknown,
): Promise<boolean> {
  const blocks = cachedBlocks(deps.rows, ts, fallback);
  if (!blocks) return false;
  const at = blocks.findIndex((block) => block.type === "section" && block.block_id === `${ROW_PREFIX}${key}`);
  const before = blocks[at];
  if (at < 0 || before?.type !== "section") return false;

  const next = blocks.slice();
  next[at] = section(`${before.text.text}\n${line}`);
  try {
    await deps.client.chat.update({ channel, ts, text: blocksText(next), blocks: next });
  } catch (err) {
    // The board write is done; a failed edit only leaves the menu showing. The
    // cache keeps the message as it is: an edit Slack never took must not be
    // built on, and the next pick finds its row where it was.
    deps.log(`chat.update failed for message ${ts}: ${errMessage(err)}`);
    return false;
  }
  keepBlocks(deps.rows, ts, next);
  return true;
}

/** The blocks last written for a message, or the click's own copy the first time. */
function cachedBlocks(rows: RowEdits, ts: string, fallback: unknown): Block[] | null {
  const cached = rows.blocks.get(ts);
  if (cached) return cached;
  if (!Array.isArray(fallback)) return null;
  // Slack's own blocks: the platform checked them, so only the shape is asserted.
  const blocks = fallback as Block[];
  keepBlocks(rows, ts, blocks);
  return blocks;
}

/** Keeps a message's blocks, and forgets the oldest message once there are too many. */
function keepBlocks(rows: RowEdits, ts: string, blocks: Block[]): void {
  rows.blocks.set(ts, blocks);
  for (const oldest of rows.blocks.keys()) {
    if (rows.blocks.size <= CACHED_MESSAGES) break;
    if (oldest !== ts) rows.blocks.delete(oldest);
  }
}

/** A row's own words, for a modal that has to carry them. "" when it is not there. */
function rowText(rows: RowEdits, ts: string, key: string, fallback: unknown): string {
  const blocks = cachedBlocks(rows, ts, fallback);
  const block = blocks?.find((entry) => entry.type === "section" && entry.block_id === `${ROW_PREFIX}${key}`);
  return block?.type === "section" ? truncate(block.text.text, MAX_METADATA_TEXT) : "";
}

/** A message's fallback text, rebuilt from its blocks: what a notification shows. */
const blocksText = (blocks: readonly Block[]): string =>
  truncate(blocks.flatMap((block) => (block.type === "section" ? [block.text.text] : [])).join("\n\n"));

/** "note: the workshop settled on x" -> "the workshop settled on x"; else null. */
export function dictationText(text: string): string | null {
  const match = /^note\s*:\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const body = match[1].trim();
  return body === "" ? null : body; // a bare "note:" is not a dictation
}

/** "add: call Dana about the renewal" -> the sentence; else null. */
export function addText(text: string): string | null {
  const match = /^add\s*:\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const body = match[1].trim();
  return body === "" ? null : body; // a bare "add:" is not an add
}

/**
 * A DM from ZY, in this order: a dictation is scribed and a sentence is drafted into
 * an item; a reply under an evening ping acks that ping; `today` and the manual
 * answer; anything else is a question when a model is set, and the one-line hint
 * when it is not.
 */
export async function handleMessage(deps: HandlerDeps, message: DmMessage): Promise<void> {
  if (message.userId !== deps.userId) return;

  // A dictation wins over the thread-ack: dictated under a ping, it is about the ping.
  const note = dictationText(message.text);
  if (note !== null && deps.scribe) {
    void runScribe(deps, message, note);
    return;
  }

  // An add: is the same way round, and for the same reason: typed under a ping it
  // drafts an item about that ping, says so itself, and never acks the ping.
  const add = addText(message.text);
  if (add !== null && addOn(deps)) {
    void runAdd(deps, message, add);
    return;
  }

  // A ping's thread is an ack, whatever the words: that is what "Noted." means.
  // Only the evening's pings are one: a briefing row is acked with its own menu,
  // so a reply under the briefing goes on to be a question like any other.
  if (message.threadTs) {
    const parent = deps.store.findByMessage(message.channel, message.threadTs);
    if (parent && parent.slot === "E") {
      deps.store.markAcked(parent.key, deps.now().toISOString());
      deps.log(`reply ack ${parent.itemId}`);
      await postMessage(deps, { channel: message.channel, text: "Noted.", thread_ts: message.threadTs });
      return;
    }
  }

  if (isTodayCommand(message.text)) {
    await sendToday(deps, message.channel);
    return;
  }

  // The manual: the overview, or the page behind "help <topic>".
  const asked = helpRequest(message.text);
  if (asked !== null) {
    deps.log(asked === "" ? "help" : `help ${asked}`);
    const reply = helpReply(deps.manual, scribeOn(deps), asked === "" ? null : asked);
    await postMessage(deps, { channel: message.channel, text: reply.text, blocks: reply.blocks });
    return;
  }

  // Anything else is a question, when there is a model to ask: a DM of its own,
  // or a follow-up in the thread of an answer.
  if (askOn(deps) && message.text.trim() !== "") {
    void runAsk(deps, message);
    return;
  }

  await postMessage(deps, { channel: message.channel, text: unknownDmHint(scribeOn(deps), addOn(deps)) });
}

/**
 * "today": the morning briefing as it would go out right now, text only: no
 * menu, nothing to click, nothing recorded.
 */
async function sendToday(deps: HandlerDeps, channel: string): Promise<void> {
  const board = await deps.board.fetchBoard(deps.owner, deps.number);
  const today = localNow(deps.now(), TZ).date;
  const preview = plan(board.items, today, "M", []);
  await postMessage(deps, { channel, text: ["(preview)", preview.briefing?.text ?? ""].join("\n\n").trim() });
}

/**
 * A question's work, off the handler's path: a model call takes longer than Slack
 * would wait. Every error ends in the thread; nothing is thrown out.
 */
async function runAsk(deps: HandlerDeps, message: DmMessage): Promise<void> {
  // A top-level question is answered in a thread of its own; a reply anywhere is
  // answered in the thread it was asked in. The pipeline looks that thread up: a
  // thread of answers carries its earlier questions, any other thread does not.
  const threadTs = message.threadTs ?? message.ts;
  const ui = threadUi(deps.client, message.channel, threadTs);
  try {
    await deps.ask?.({ ts: message.ts, question: message.text, threadTs }, ui);
  } catch (err) {
    deps.log(`ask ${message.ts} failed: ${errMessage(err)}`);
    try {
      await ui.reply(`couldn't answer: ${errMessage(err)}`);
    } catch (replyErr) {
      deps.log(`ask ${message.ts}: the error reply failed too: ${errMessage(replyErr)}`);
    }
  }
}

/**
 * The scribe's work, off the handler's path: the event is already acked, and a
 * commit takes longer than Slack would wait. Every error ends in the thread.
 */
async function runScribe(deps: HandlerDeps, message: DmMessage, text: string): Promise<void> {
  const ui = threadUi(deps.client, message.channel, message.ts);
  try {
    const hint = await pingHint(deps, message);
    await deps.scribe?.({ ts: message.ts, text, hint }, ui);
  } catch (err) {
    deps.log(`scribe ${message.ts} failed: ${errMessage(err)}`);
    try {
      await ui.reply(`⚠️ the scribe failed: ${errMessage(err)}`);
    } catch (replyErr) {
      deps.log(`scribe ${message.ts}: the error reply failed too: ${errMessage(replyErr)}`);
    }
  }
}

/** A note dictated under a ping is about that ping's item: its title is the hint. */
async function pingHint(deps: HandlerDeps, message: DmMessage): Promise<string | null> {
  return (await threadItem(deps, message))?.title ?? null;
}

/**
 * The item whose evening ping the message is a reply under, read from the board,
 * or null: this is the one board read both the scribe's hint and the add: hint are.
 * Only an evening ping's thread names one item: every row of a briefing is
 * recorded on the briefing's own ts, so that thread names no item in particular.
 */
async function threadItem(deps: HandlerDeps, message: DmMessage): Promise<Item | null> {
  if (!message.threadTs) return null;
  const parent = deps.store.findByMessage(message.channel, message.threadTs);
  if (!parent || parent.slot !== "E") return null;
  try {
    const board = await deps.board.fetchBoard(deps.owner, deps.number);
    return board.items.find((item) => item.id === parent.itemId) ?? null;
  } catch (err) {
    // The hint is a nicety: a board the bot cannot read must not stop the note or the add.
    deps.log(`hint ${message.ts}: none, the board read failed: ${errMessage(err)}`);
    return null;
  }
}

/**
 * The add: pipeline's work, off the handler's path like the scribe's: a model
 * draft takes longer than Slack would wait. Every error ends in the thread.
 */
async function runAdd(deps: HandlerDeps, message: DmMessage, text: string): Promise<void> {
  const ui = addUi(deps.client, message);
  try {
    const item = await threadItem(deps, message);
    const hint = item === null ? null : { ref: item.ref, title: item.title };
    await deps.add?.({ ts: message.ts, text, hint }, ui);
  } catch (err) {
    deps.log(`add ${message.ts} failed: ${errMessage(err)}`);
    try {
      await ui.reply(`⚠️ could not draft the item: ${errMessage(err)}`);
    } catch (replyErr) {
      deps.log(`add ${message.ts}: the error reply failed too: ${errMessage(replyErr)}`);
    }
  }
}

/** The add: pipeline's Slack side: the drafting reply, its failure, and the card on it. */
function addUi(client: SlackClient, message: DmMessage): AddUi {
  return {
    async reply(text: string): Promise<Sent> {
      const res = await client.chat.postMessage({ channel: message.channel, text, thread_ts: message.ts });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return { channel: message.channel, ts: res.ts };
    },
    async edit(channel: string, ts: string, text: string): Promise<void> {
      await client.chat.update({ channel, ts, text });
    },
    async card(channel: string, ts: string, card: Card, rev: number): Promise<void> {
      await client.chat.update({ channel, ts, text: cardText(card), blocks: cardBlocks(proposalId(message.ts), rev, card) });
    },
  };
}

/** The bot's Slack side of one thread: the replies, edits and questions of the
 * scribe and of the ask all land in the thread they belong to.
 */
export function threadUi(client: SlackClient, channel: string, threadTs: string): ScribeUi {
  return {
    async reply(text: string): Promise<string> {
      const res = await client.chat.postMessage({ channel, text, thread_ts: threadTs });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return res.ts;
    },
    async edit(ts: string, text: string): Promise<void> {
      await client.chat.update({ channel, ts, text });
    },
    async ask(ask: ScribeAsk): Promise<void> {
      await client.chat.postMessage({ channel, text: ask.text, thread_ts: threadTs, blocks: askBlocks(ask) });
    },
  };
}

/**
 * The folder question: the dictation's text, the buttons, and the folders. The
 * select holds at most Slack's 100 options (Accounts first, each sorted), its
 * options carry the folder alone, and the dictation rides in its block_id.
 */
export function askBlocks(ask: ScribeAsk): Block[] {
  const elements: Array<ButtonElement | SelectElement> = [];
  if (ask.create !== null) {
    elements.push({ type: "button", action_id: "zy_scribe_create", text: { type: "plain_text", text: "Create" }, value: ask.ts });
  }
  if (ask.retry) {
    elements.push({ type: "button", action_id: "zy_scribe_retry", text: { type: "plain_text", text: "Retry" }, value: ask.ts });
  }
  elements.push({ type: "button", action_id: "zy_scribe_cancel", text: { type: "plain_text", text: "Cancel" }, value: ask.ts });
  const folders = selectFolders(ask.folders);
  if (folders.length > 0) {
    elements.push({
      type: "static_select",
      action_id: "zy_scribe_folder",
      placeholder: { type: "plain_text", text: "…or put it in" },
      options: folders.map((folder) => ({ text: { type: "plain_text", text: folder }, value: folder })),
    });
  }
  return [section(ask.text), { type: "actions", block_id: `${FOLDER_BLOCK_PREFIX}${ask.ts}`, elements }];
}

/** The folders a select may offer: Accounts first, each group sorted, at most 100. Pure. */
export function selectFolders(folders: readonly string[]): string[] {
  const accounts = folders.filter((folder) => folder.startsWith("Accounts/")).sort();
  const others = folders.filter((folder) => !folder.startsWith("Accounts/")).sort();
  return [...accounts, ...others].slice(0, MAX_SELECT_OPTIONS);
}

/**
 * A folder choice. Only ZY's click counts, and the commit behind it is longer
 * than Slack's three seconds, so the caller acks first and does not wait.
 */
async function dispatchScribeChoice(deps: HandlerDeps, scribe: ScribeDeps, args: ScribeClick): Promise<void> {
  if (args.userId !== deps.userId || args.channel === null) return;
  const choice = parseScribeChoice(args.actionId, args.value, args.selected, args.blockId);
  if (!choice) {
    deps.log(`scribe: ${args.actionId} is not a choice the bot knows`);
    return;
  }
  const ui = threadUi(deps.client, args.channel, choice.ts);
  try {
    await scribeChoice(scribe, choice, ui);
  } catch (err) {
    deps.log(`scribe ${choice.ts}: the choice failed: ${errMessage(err)}`);
    try {
      await ui.reply(`⚠️ the scribe failed: ${errMessage(err)}`);
    } catch (replyErr) {
      deps.log(`scribe ${choice.ts}: the error reply failed too: ${errMessage(replyErr)}`);
    }
  }
}

/** A click on the folder question: the button's value, or the select's option and block. */
export interface ScribeClick {
  actionId: string;
  value: string | null;
  selected: string | null;
  blockId: string | null; // the select's block carries the dictation
  userId: string;
  channel: string | null;
}

async function postMessage(deps: HandlerDeps, args: PostMessageArgs): Promise<void> {
  await deps.client.chat.postMessage(args);
}

/** A failed update never turns a successful board write into a reported failure. */
async function updateMessage(deps: HandlerDeps, channel: string, ts: string, text: string, blocks: Block[]): Promise<void> {
  try {
    await deps.client.chat.update({ channel, ts, text, blocks });
  } catch (err) {
    deps.log(`chat.update failed for message ${ts}: ${errMessage(err)}`);
  }
}

/** A reply in a ping's thread, best effort: it is never the point of a click. */
async function replyInThread(deps: HandlerDeps, channel: string, ts: string, text: string): Promise<void> {
  try {
    await deps.client.chat.postMessage({ channel, text, thread_ts: ts });
  } catch (err) {
    deps.log(`thread reply to ${ts} failed: ${errMessage(err)}`);
  }
}

/** Everything the modal needs to come back to the right ping with its text intact. */
export interface MoveMetadata {
  channel: string;
  ts: string;
  key: string;
  text: string;
  /** True when the click came from a briefing row: the row is edited, not the message. */
  row?: boolean;
}

/** What opens the modal: the click's trigger_id, where the ping is, and what it says. */
interface MoveOpen {
  triggerId: string | null;
  channel: string | null;
  ts: string | null;
  key: string;
  target: string | null;
  text: string;
  row?: boolean;
}

/** The modal opened by a "Move date" click: a date, and a reason it cannot do without. */
export function moveView(meta: MoveMetadata, target: string | null): ViewsOpenArgs["view"] {
  return {
    type: "modal",
    callback_id: MOVE_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Move the target date" },
    submit: { type: "plain_text", text: "Move" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "date",
        label: { type: "plain_text", text: "Target date" },
        element: {
          type: "datepicker",
          action_id: "date",
          // A button from before the value carried the date opens on nothing.
          ...(target === null ? {} : { initial_date: target }),
        },
      },
      {
        // Not optional: Slack refuses the submit until it is filled in.
        type: "input",
        block_id: "reason",
        label: { type: "plain_text", text: "Reason" },
        element: { type: "plain_text_input", action_id: "reason" },
      },
    ],
  };
}

/**
 * One input of a proposal's Edit modal. Slack refuses a view whose initial_option
 * is not one of the select's options, so a value that is not there opens on
 * nothing: the field still holds its own option list.
 */
function editBlock(field: EditField): ModalBlock {
  const label = { type: "plain_text" as const, text: field.label };
  if (field.kind === "text") {
    return {
      type: "input",
      block_id: field.name,
      label,
      ...(field.required ? {} : { optional: true }),
      element: {
        type: "plain_text_input",
        action_id: "v",
        max_length: field.maxLength,
        ...(field.value === null ? {} : { initial_value: field.value }),
      },
    };
  }
  if (field.kind === "date") {
    return {
      type: "input",
      block_id: field.name,
      label,
      optional: true,
      element: { type: "datepicker", action_id: "v", ...(field.value === null ? {} : { initial_date: field.value }) },
    };
  }
  const options: ModalOption[] = field.options.map((option) => ({
    text: { type: "plain_text", text: option.label },
    value: option.value,
  }));
  // The same object from the list, never a copy: Slack compares an initial_option
  // with the options by value, and this is what the list itself holds.
  const chosen = field.value === null ? undefined : options.find((option) => option.value === field.value);
  return {
    type: "input",
    block_id: field.name,
    label,
    optional: true,
    element: {
      type: "static_select",
      action_id: "v",
      options,
      ...(chosen === undefined ? {} : { initial_option: chosen }),
    },
  };
}

/**
 * The Edit modal of a proposal: the kind's fields, one input each, in the order
 * the card reads them. The metadata carries the id and the rev alone: the values
 * come back from SQLite, so a modal held open for an hour still edits the draft.
 */
export function editView(id: string, rev: number, fields: readonly EditField[]): ViewsOpenArgs["view"] {
  return {
    type: "modal",
    callback_id: PROP_EDIT_VIEW,
    private_metadata: JSON.stringify({ id, rev }),
    title: { type: "plain_text", text: "Edit the new item" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    // Slack takes 100 blocks in a view and a proposal has 9 inputs: nothing here
    // has to be split, and a tenth field is still well inside the limit.
    blocks: fields.map(editBlock),
  };
}

/** One input's answer, whichever of the three elements it came from. */
interface ModalValue {
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value: string } | null;
}

/**
 * The modal's answers by block_id: a datepicker and a select each answer under
 * their own key, and a field nobody touched is null, which is the empty value.
 */
export function editValues(state: Record<string, Record<string, ModalValue>>): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const [name, inputs] of Object.entries(state)) {
    const input: ModalValue = inputs.v ?? {};
    values[name] = input.selected_date ?? input.selected_option?.value ?? input.value ?? null;
  }
  return values;
}

function parseMetadata(raw: string | null): MoveMetadata | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // a metadata we cannot read is a ping we cannot update
  }
  if (!isRecord(parsed)) return null;
  const { channel, ts, key, text } = parsed;
  if (typeof channel !== "string" || typeof ts !== "string" || typeof key !== "string" || typeof text !== "string") return null;
  return { channel, ts, key, text, ...(parsed.row === true ? { row: true } : {}) };
}

/**
 * Opens the move modal over the click's trigger_id. This is the first call after
 * ack(): a trigger_id is good for three seconds, so there is no board read in
 * front of it: the date it opens on rides in the button's value.
 */
async function openMoveModal(deps: HandlerDeps, args: MoveOpen): Promise<void> {
  const { triggerId, channel, ts } = args;
  if (!triggerId || !channel || !ts) {
    deps.log(`move ${args.key}: the click carries no trigger_id`);
    return;
  }
  const meta: MoveMetadata = {
    channel,
    ts,
    key: args.key,
    text: args.text,
    ...(args.row ? { row: true } : {}),
  };
  try {
    await deps.client.views.open({ trigger_id: triggerId, view: moveView(meta, args.target) });
  } catch (err) {
    deps.log(`move ${args.key}: views.open failed: ${errMessage(err)}`);
  }
}

/** What the move modal posts back: the two inputs and whose click it was. */
export interface MoveSubmit {
  userId: string;
  metadata: string | null;
  date: string | null; // YYYY-MM-DD from the datepicker
  reason: string | null; // the plain-text input
}

/**
 * The move modal's submit: write the date first (that is the move), then say why
 * (a comment on an issue, a thread reply for a draft), then close the ping and
 * record the ack. A failed comment is reported, never fatal: the date moved.
 */
export async function handleMoveSubmit(deps: HandlerDeps, submit: MoveSubmit): Promise<void> {
  if (submit.userId !== deps.userId) return;
  const meta = parseMetadata(submit.metadata);
  if (!meta) {
    deps.log("move submit: private_metadata holds no ping");
    return;
  }
  const ping = deps.store.findByKey(meta.key);
  if (!ping) {
    deps.log(`move submit: unknown ping ${meta.key}`);
    return;
  }
  // A second submit of the same modal (a double click, a retried request).
  if (ping.ackedAt) {
    deps.log(`move ${meta.key}: already handled, this submit does nothing`);
    await replyInThread(deps, meta.channel, meta.ts, "already handled");
    return;
  }
  const date = submit.date;
  const note = submit.reason?.trim() ?? "";
  if (!date || note === "") {
    deps.log(`move ${meta.key}: both a date and a reason are required`);
    return;
  }

  // The board is read before the write: the old date is what the note quotes,
  // and the write is the only thing that can fail into "nothing happened".
  let old: string | null;
  let contentId: string | null;
  try {
    const board = await deps.board.fetchBoard(deps.owner, deps.number);
    const field = board.fields.get(FIELD.target);
    if (!field) throw new Error(`the board has no "${FIELD.target}" field`);
    const item = board.items.find((i) => i.id === ping.itemId);
    old = item?.target ?? null;
    contentId = item?.contentId ?? null;
    await deps.board.setDate(board.projectId, ping.itemId, field.id, date);
  } catch (err) {
    // Nothing was written, so the ping keeps its buttons and can be retried.
    deps.log(`move ${meta.key} failed: ${errMessage(err)}`);
    await replyInThread(deps, meta.channel, meta.ts, `→ move failed: ${errMessage(err)}`);
    return;
  }

  // The date is on the board: the move counts from here whatever happens next.
  deps.log(`move ${ping.itemId}: ${old ?? "none"} -> ${date}`);
  const commentary = `Target date moved ${old ?? "none"} → ${date} by zy-assistant: ${note}`;
  // An Issue takes a comment; a draft has nowhere to put one, so the note goes
  // in the ping's thread, under the buttons it replaces.
  if (!contentId) {
    await replyInThread(deps, meta.channel, meta.ts, commentary);
  } else {
    try {
      await deps.board.addComment(contentId, commentary);
    } catch (err) {
      // Best effort: the reason is not lost, it goes in the thread instead.
      deps.log(`move ${meta.key}: comment failed: ${errMessage(err)}`);
      await replyInThread(deps, meta.channel, meta.ts, `${commentary} (comment failed: ${errMessage(err)})`);
    }
  }

  deps.store.markAcked(meta.key, deps.now().toISOString());
  const line = `Moved to ${fmtDate(date)} (${note})`;
  if (meta.row) {
    // A row: edit it where it stands. Without the blocks (a restart in between)
    // the row is left as it is and the thread carries the line instead.
    if (!(await markRow(deps, meta.channel, meta.ts, meta.key, `→ ${line}`, null))) {
      await replyInThread(deps, meta.channel, meta.ts, `→ ${line}`);
    }
    return;
  }
  await updateMessage(deps, meta.channel, meta.ts, `${meta.text}\n→ ${line}`, [section(meta.text), context(`→ ${line}`)]);
}

/** A click on one of a card's buttons. The ack is the caller's job: a write follows. */
export interface ProposalActionClick {
  actionId: string; // "zy_prop_create" | "zy_prop_edit" | "zy_prop_cancel" | "zy_prop_retry"
  value: string | null; // proposalValue(id, rev)
  userId: string;
  channel: string | null;
  ts: string | null; // the card's message
  triggerId: string | null;
}

/** What the Edit modal posts back. The values are the inputs, by block_id. */
export interface ProposalEditSubmit {
  userId: string;
  metadata: string | null; // the modal's private_metadata
  values: Record<string, string | null>;
}

/** Where a card is and what can be done to it: everything a ProposalUi is built from. */
interface CardAt {
  proposals: ProposalDeps;
  id: string;
  channel: string;
  ts: string;
  triggerId: string | null;
}

/**
 * A proposal's Slack side: the card is edited where it stands, and posted afresh
 * in its own thread when Slack will not take the edit (an old message cannot be
 * edited any more), which is the one the store then remembers.
 */
function proposalUi(deps: HandlerDeps, at: CardAt): ProposalUi {
  const { channel, ts } = at;
  return {
    async redraw(card: Card, rev: number): Promise<void> {
      await deps.client.chat.update({ channel, ts, text: cardText(card), blocks: cardBlocks(at.id, rev, card) });
    },
    async repost(card: Card, rev: number): Promise<void> {
      const res = await deps.client.chat.postMessage({
        channel,
        text: cardText(card),
        blocks: cardBlocks(at.id, rev, card),
        thread_ts: ts,
      });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      // The new card is the one later clicks and edits find.
      at.proposals.store.updateProposal(at.id, { channel, messageTs: res.ts });
    },
    async reply(text: string): Promise<void> {
      await deps.client.chat.postMessage({ channel, text, thread_ts: ts });
    },
    async openEdit(id: string, rev: number, fields: EditField[]): Promise<void> {
      if (at.triggerId === null) {
        deps.log(`proposal ${id}: the click carries no trigger_id, the modal cannot open`);
        return;
      }
      await deps.client.views.open({ trigger_id: at.triggerId, view: editView(id, rev, fields) });
    },
  };
}

/** "zy_prop_create" -> create; anything else -> null. */
function parseProposalAction(actionId: string): ProposalButton | null {
  if (!actionId.startsWith(PROP_ACTION_PREFIX)) return null;
  const word = actionId.slice(PROP_ACTION_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(PROPOSAL_LABELS, word) ? (word as ProposalButton) : null;
}

/**
 * A click on a card's buttons: the approval, the edit, the cancel or the retry.
 * The writes behind Create are longer than Slack's three seconds, so the caller
 * acks first; everything after that is the proposal machinery's.
 */
export async function handleProposalAction(deps: HandlerDeps, click: ProposalActionClick): Promise<void> {
  const proposals = deps.proposals;
  if (proposals === null || proposals === undefined) {
    deps.log(`proposal click ${click.actionId}: no proposals are set up, this click does nothing`);
    return;
  }
  const action = parseProposalAction(click.actionId);
  const target = parseProposalValue(click.value);
  const { channel, ts } = click;
  if (action === null || target === null || !channel || !ts) {
    deps.log(`proposal click ${click.actionId}: its value names no card, this click does nothing`);
    return;
  }
  await proposalClick(proposals, {
    action,
    id: target.id,
    rev: target.rev,
    userId: click.userId,
    triggerId: click.triggerId,
    ui: proposalUi(deps, { proposals, id: target.id, channel, ts, triggerId: click.triggerId }),
  });
}

/** The Edit modal's metadata: the proposal and the rev it was opened on, and nothing else. */
function parseEditMetadata(raw: string | null): { id: string; rev: number } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // a metadata we cannot read is a proposal we cannot edit
  }
  if (!isRecord(parsed)) return null;
  const { id, rev } = parsed;
  if (typeof id !== "string" || typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) return null;
  return { id, rev };
}

/**
 * The Edit modal's submit: the spec turns the values into a payload and the store
 * takes it. The card is redrawn where the row says it is, never where the modal
 * says: a modal carries no channel, and its rev is the card's own.
 */
export async function handleProposalEdit(deps: HandlerDeps, submit: ProposalEditSubmit): Promise<void> {
  const proposals = deps.proposals;
  if (proposals === null || proposals === undefined) {
    deps.log("proposal edit: no proposals are set up, this edit does nothing");
    return;
  }
  const meta = parseEditMetadata(submit.metadata);
  if (meta === null) {
    deps.log("proposal edit: private_metadata holds no proposal");
    return;
  }
  const row = proposals.store.findProposal(meta.id);
  if (row === null || row.channel === null || row.messageTs === null) {
    deps.log(`proposal ${meta.id}: no card to redraw, this edit does nothing`);
    return;
  }
  const ui = proposalUi(deps, { proposals, id: meta.id, channel: row.channel, ts: row.messageTs, triggerId: null });
  await proposalEdited(proposals, {
    id: meta.id,
    rev: meta.rev,
    userId: submit.userId,
    values: submit.values,
    // A submit opens nothing: there is no trigger_id in a view submission.
    ui: { ...ui, openEdit: async () => {} },
  });
}

/**
 * A card the process was restarted out from under: redrawn where the store says
 * it is, so its buttons come back (or, for a cancelled draft, so it says what
 * stopped it) instead of lying there in `creating…`. A failure is a log line:
 * nobody clicked, and there is no thread to say it in.
 */
export async function redrawProposalCard(deps: HandlerDeps, id: string): Promise<void> {
  const proposals = deps.proposals;
  if (proposals === null || proposals === undefined) {
    deps.log(`proposal ${id}: no proposals are set up, there is no card to redraw`);
    return;
  }
  const row = proposals.store.findProposal(id);
  if (row === null) {
    deps.log(`proposal ${id}: unknown, there is no card to redraw`);
    return;
  }
  const spec = proposals.specs[row.kind];
  if (spec === undefined) {
    deps.log(`proposal ${row.id}: kind ${row.kind} is not one this bot applies, there is no card to redraw`);
    return;
  }
  if (row.channel === null || row.messageTs === null) {
    deps.log(`proposal ${row.id}: the row names no card, there is nothing to redraw`);
    return;
  }
  const ui = proposalUi(deps, { proposals, id: row.id, channel: row.channel, ts: row.messageTs, triggerId: null });
  try {
    await ui.redraw(spec.card(row), row.rev);
  } catch (err) {
    deps.log(`proposal ${row.id}: the redraw failed: ${errMessage(err)}`);
  }
}

/**
 * A click or a submit that threw: the log line, and the thread, where a click's
 * failure belongs. Never thrown out: an unhandled rejection is a socket that dies
 * on a message nobody is watching.
 */
async function reportClickFailure(
  deps: HandlerDeps,
  channel: string | null,
  ts: string | null,
  what: string,
  err: unknown,
): Promise<void> {
  deps.log(`${what} failed: ${errMessage(err)}`);
  if (channel === null || ts === null) return;
  try {
    await deps.client.chat.postMessage({ channel, text: `⚠️ ${what} failed: ${errMessage(err)}`, thread_ts: ts });
  } catch (replyErr) {
    deps.log(`${what}: the error reply failed too: ${errMessage(replyErr)}`);
  }
}

/** Performs the board write behind a button and returns the result line. */
async function applyAction(deps: HandlerDeps, actionId: Exclude<ActionId, "move">, ping: PingRecord): Promise<string> {
  if (actionId === "ack") return "acked";
  const board = await deps.board.fetchBoard(deps.owner, deps.number);
  if (actionId === "done") {
    const field = board.fields.get(FIELD.status);
    const option = field?.options?.get(STATUS.done);
    if (!field || !option) throw new Error(`the board has no "${FIELD.status}" field with a "${STATUS.done}" option`);
    await deps.board.setSingleSelect(board.projectId, ping.itemId, field.id, option);
    return `marked ${STATUS.done} on the board`;
  }
  const field = board.fields.get(FIELD.nextTouch);
  if (!field) throw new Error(`the board has no "${FIELD.nextTouch}" field`);
  const date = touchDate(localNow(deps.now(), TZ).date, actionId);
  await deps.board.setDate(board.projectId, ping.itemId, field.id, date);
  return `next touch ${fmtDate(date)}`;
}

export interface SlackBotOptions {
  botToken: string;
  appToken: string;
  userId: string;
  owner: string;
  number: number;
  store: PingStore;
  board: BoardSource;
  now: () => Date;
  log: (line: string) => void;
  /** What "help" quotes: the slot times, NOTES_REPO and the live policy. */
  manual: ManualSettings;
  /** The scribe, or null: without it "note: ..." is answered like any other DM. */
  scribe?: ScribeDeps | null;
  /** The ask, or null: without it a question gets the hint instead of an answer. */
  ask?: AskDeps | null;
  /** The add: pipeline, or null: without it "add: ..." is answered like any other DM. */
  add?: AddDeps | null;
}

/** Slack's "the blocks you sent are no good", as Bolt throws it. */
const invalidBlocks = (err: unknown): boolean => isRecord(err) && isRecord(err.data) && err.data.error === "invalid_blocks";

export class SlackBot implements Sender {
  readonly app: App;
  #userId: string;
  #scribe: ScribeDeps | null;
  #rows: RowEdits;
  #deps: Omit<HandlerDeps, "client">;

  constructor(options: SlackBotOptions) {
    this.#userId = options.userId;
    const scribe = options.scribe ?? null;
    const ask = options.ask ?? null;
    const add = options.add ?? null;
    this.#scribe = scribe;
    this.#rows = rowEdits();
    this.#deps = {
      store: options.store,
      board: options.board,
      owner: options.owner,
      number: options.number,
      userId: options.userId,
      now: options.now,
      log: options.log,
      manual: options.manual,
      rows: this.#rows,
      scribe: scribe === null ? null : (dictation, ui) => scribeHandler(scribe, dictation, ui),
      ask: ask === null ? null : (input, ui) => askQuestion(ask, input, ui),
      add: add === null ? null : (input, ui) => addHandler(add, input, ui),
      // The cards are only clickable when there is a pipeline behind them.
      proposals:
        add === null
          ? null
          : { store: add.proposals, specs: { add: addSpec(add) }, userId: options.userId, now: options.now, log: options.log },
    };
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
      // The token check moves to init() (start()), where main can report it.
      deferInitialization: true,
      clientOptions: { retryConfig: { retries: 2 }, timeout: 30_000 },
    });

    this.app.action(/^zy_/, async ({ ack, body, action, client }) => {
      await ack();
      if (body.type !== "block_actions") return;
      if (!("action_id" in action) || typeof action.action_id !== "string") return;
      if (action.action_id === ROW_ACTION) {
        // A row's ⋯ menu: the key is in the block, the action in the option.
        const selected =
          "selected_option" in action && isRecord(action.selected_option) && typeof action.selected_option.value === "string"
            ? action.selected_option.value
            : null;
        await handleRowAction(
          { ...this.#deps, client },
          {
            value: selected,
            blockId: "block_id" in action && typeof action.block_id === "string" ? action.block_id : null,
            userId: body.user.id,
            channel: body.channel?.id ?? null,
            ts: body.message?.ts ?? null,
            blocks: body.message?.blocks,
            triggerId: body.trigger_id ?? null,
          },
        );
        return;
      }
      if (action.action_id.startsWith("zy_scribe_")) {
        // A folder choice: a GitHub commit follows, so it is not awaited here.
        if (this.#scribe === null) return;
        const selected =
          "selected_option" in action && action.selected_option !== null && typeof action.selected_option === "object" && "value" in action.selected_option && typeof action.selected_option.value === "string"
            ? action.selected_option.value
            : null;
        void dispatchScribeChoice(
          { ...this.#deps, client },
          this.#scribe,
          {
            actionId: action.action_id,
            value: "value" in action && typeof action.value === "string" ? action.value : null,
            selected,
            blockId: "block_id" in action && typeof action.block_id === "string" ? action.block_id : null,
            userId: body.user.id,
            channel: body.channel?.id ?? null,
          },
        );
        return;
      }
      const actionId = action.action_id;
      if (actionId.startsWith(PROP_ACTION_PREFIX)) {
        // A card's button: Create writes GitHub, so it is not awaited here.
        const channel = body.channel?.id ?? null;
        const ts = body.message?.ts ?? null;
        void handleProposalAction(
          { ...this.#deps, client },
          {
            actionId,
            value: "value" in action && typeof action.value === "string" ? action.value : null,
            userId: body.user.id,
            channel,
            ts,
            triggerId: body.trigger_id ?? null,
          },
        ).catch((err: unknown) => {
          // A click's failure ends in the card's thread, never in a rejection.
          void reportClickFailure({ ...this.#deps, client }, channel, ts, `proposal click ${actionId}`, err);
        });
        return;
      }
      await handleAction(
        { ...this.#deps, client },
        {
          actionId: action.action_id,
          value: "value" in action && typeof action.value === "string" ? action.value : null,
          userId: body.user.id,
          channel: body.channel?.id ?? null,
          ts: body.message?.ts ?? null,
          blocks: body.message?.blocks,
          text: body.message?.text ?? null,
          triggerId: body.trigger_id ?? null,
        },
      );
    });

    // The move-date modal. Acked first and then worked on: a board write takes
    // longer than Slack's three seconds.
    this.app.view(MOVE_CALLBACK, async ({ ack, body, view, client }) => {
      await ack();
      const values = view.state.values;
      await handleMoveSubmit(
        { ...this.#deps, client },
        {
          userId: body.user.id,
          metadata: view.private_metadata ?? null,
          date: values.date?.date?.selected_date ?? null,
          reason: values.reason?.reason?.value ?? null,
        },
      );
    });

    // A proposal's Edit modal: acked first, then saved. The card it redraws is
    // found in the store, so nothing here waits on a board read either.
    this.app.view(PROP_EDIT_VIEW, async ({ ack, body, view, client }) => {
      await ack();
      void handleProposalEdit(
        { ...this.#deps, client },
        {
          userId: body.user.id,
          metadata: view.private_metadata ?? null,
          values: editValues(view.state.values),
        },
      ).catch((err: unknown) => {
        void reportClickFailure({ ...this.#deps, client }, null, null, "proposal edit", err);
      });
    });

    this.app.message(async ({ message, client }) => {
      const m = message as {
        user?: string;
        text?: string;
        ts?: string;
        thread_ts?: string;
        bot_id?: string;
        subtype?: string;
        channel?: string;
      };
      if (m.bot_id || m.subtype || !m.user || !m.ts || !m.channel) return;
      await handleMessage(
        { ...this.#deps, client },
        {
          userId: m.user,
          channel: m.channel,
          ts: m.ts,
          threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
          text: m.text ?? "",
        },
      );
    });
  }

  /** Verifies the bot token and connects. A bad token rejects here, cleanly. */
  async start(): Promise<void> {
    await this.app.init();
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  /** auth.test, used by `check` to prove the token before the first DM. */
  async authTest(): Promise<{ user: string | undefined; team: string | undefined }> {
    await this.app.init();
    const res = await this.app.client.auth.test();
    return { user: res.user, team: res.team };
  }

  /**
   * A card a restart interrupted: redrawn through this bot's own Slack wiring, so
   * the row that names a channel and a ts gets the card it should be showing.
   */
  async redrawCard(id: string): Promise<void> {
    await redrawProposalCard({ ...this.#deps, client: this.app.client }, id);
  }

  async sendDm(text: string): Promise<Sent> {
    const channel = await this.#dmChannel();
    return this.#post(channel, text);
  }

  async sendPing(ping: Ping, target: string | null): Promise<Sent> {
    const channel = await this.#dmChannel();
    const text = truncate(ping.text);
    const res = await this.app.client.chat.postMessage({
      channel,
      text,
      blocks: pingBlocks(ping, target),
    });
    if (!res.ts) throw new Error("chat.postMessage returned no ts");
    return { channel, ts: res.ts };
  }

  async sendBriefing(briefing: Briefing, targets: ReadonlyMap<string, string | null>): Promise<BriefingSent> {
    const channel = await this.#dmChannel();
    const text = truncate(briefing.text);
    const blocks = briefingBlocks(briefing, targets);
    try {
      const res = await this.app.client.chat.postMessage({ channel, text, blocks });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      // Kept, so a row can be replaced later without rebuilding the message.
      keepBlocks(this.#rows, res.ts, blocks);
      return { channel, ts: res.ts, menuKeys: menuKeys(blocks) };
    } catch (err) {
      if (!invalidBlocks(err)) throw err;
      // Slack refused the blocks: the text alone is still the briefing, without
      // a menu to click. Every row is named all the same, so it is recorded on
      // this message's ts: the evening's re-ping, the ⚠ line and the chase
      // window all read the history, and a board update still acks a row.
      const res = await this.app.client.chat.postMessage({ channel, text });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return { channel, ts: res.ts, menuKeys: briefing.rows.map((row) => row.key) };
    }
  }

  async #dmChannel(): Promise<string> {
    const res = await this.app.client.conversations.open({ users: this.#userId });
    const channel = res.channel?.id;
    if (!channel) throw new Error("conversations.open returned no channel");
    return channel;
  }

  async #post(channel: string, text: string): Promise<Sent> {
    const res = await this.app.client.chat.postMessage({ channel, text });
    if (!res.ts) throw new Error("chat.postMessage returned no ts");
    return { channel, ts: res.ts };
  }
}
