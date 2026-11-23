// Slack: the DM channel the assistant talks in, the ping messages with their
// buttons, and the DM commands. Bolt over socket mode, so no public URL.
//
// The two handlers are plain functions over HandlerDeps (a Slack client, the
// store, the board), so they can be tested without Bolt and without network.

import { App, LogLevel } from "@slack/bolt";
import { errMessage } from "./errors.ts";
import type { BoardSource } from "./github.ts";
import { helpReply, type ManualSettings } from "./manual.ts";
import { plan, type ActionId, type Ping } from "./rules.ts";
import { STATUS } from "./schema.ts";
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

export interface Sender {
  sendDm(text: string): Promise<Sent>;
  /** target: the item's Target date now, so the move modal opens on it. */
  sendPing(ping: Ping, target: string | null): Promise<Sent>;
}

interface SectionBlock {
  type: "section";
  text: { type: "mrkdwn"; text: string };
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

/** The only two blocks the move modal needs, spelled out for the Slack types. */
type ModalBlock =
  | {
      type: "input";
      block_id: string;
      label: { type: "plain_text"; text: string };
      element: { type: "datepicker"; action_id: string; initial_date?: string };
    }
  | {
      type: "input";
      block_id: string;
      label: { type: "plain_text"; text: string };
      element: { type: "plain_text_input"; action_id: string };
    };

/** Slack rejects a section block over 3000 characters. */
const MAX_SECTION_TEXT = 2900;

/** Its private_metadata has a hard cap too, and the ping text rides in it. */
const MAX_METADATA_TEXT = 2000;

/** The callback_id of the move-date modal. */
const MOVE_CALLBACK = "zy_move";

const LABELS: Record<ActionId, string> = {
  ack: "👍 On it",
  move: "Move date",
  done: "✅ Done",
  touch1: "Tomorrow",
  touch7: "+7 days",
};

/** Slack rejects a select with more than 100 options. */
const MAX_SELECT_OPTIONS = 100;

/** A DM that is no command at all: one line, so a stray message is not read as a feature. */
const UNKNOWN_DM = "I didn't catch that. Reply `help` for what I can do.";

/**
 * What a DM asks the manual for: "" for the overview, the topic word for a page,
 * and null when the message is no help request. Case and spacing do not matter.
 */
export function helpRequest(text: string): string | null {
  const match = /^(?:help|\?|manual)(?:\s+([\s\S]+))?$/i.exec(text.trim());
  if (!match) return null;
  return (match[1] ?? "").trim();
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
  /** The scribe, when LLM_BASE_URL and friends are set: null turns "note: ..." off. */
  scribe?: ScribeDispatch | null;
}

/** The scribe, called without being awaited: Slack wants its three seconds. */
export type ScribeDispatch = (dictation: ScribeDictation, ui: ScribeUi) => Promise<void>;

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

/** True when a dictation would be scribed: the note topic and the note: line. */
const scribeOn = (deps: HandlerDeps): boolean => deps.scribe !== null && deps.scribe !== undefined;

/** A button click. Only ZY's clicks do anything; ZY's click is the board approval. */
export async function handleAction(deps: HandlerDeps, click: ActionClick): Promise<void> {
  if (click.userId !== deps.userId) return;
  const actionId = parseActionId(click.actionId);
  const button = parseButtonValue(click.value);
  if (!actionId || !button || !click.channel || !click.ts) return;

  const ping = deps.store.findByKey(button.key);
  if (!ping) {
    deps.log(`button ${actionId}: unknown ping ${button.key}`);
    return;
  }

  // Moving a date needs a date and a reason: the modal collects both, and the
  // ping is only acked when its own view is submitted.
  if (actionId === "move") {
    await openMoveModal(deps, click, ping, button.target);
    return;
  }

  const text = originalText(click.blocks, click.text);
  let result: string;
  try {
    result = await applyAction(deps, actionId, ping);
  } catch (err) {
    // The board write failed: say so and keep the buttons so the click can be retried.
    const failure = `→ failed: ${errMessage(err)}`;
    deps.log(`button ${actionId} on ${button.key} failed: ${errMessage(err)}`);
    const kept = keptActions(click.blocks, button);
    await updateMessage(deps, click.channel, click.ts, `${text}\n${failure}`, [section(text), ...(kept ? [kept] : []), context(failure)]);
    return;
  }

  deps.store.markAcked(button.key, deps.now().toISOString());
  deps.log(`button ${actionId} on ${ping.itemId} by ${click.userId}`);
  // The write is done: if the message update fails it is only cosmetic.
  await updateMessage(deps, click.channel, click.ts, `${text}\n→ ${result}`, [section(text), context(`→ ${result}`)]);
}

/** "note: the workshop settled on x" -> "the workshop settled on x"; else null. */
export function dictationText(text: string): string | null {
  const match = /^note\s*:\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const body = match[1].trim();
  return body === "" ? null : body; // a bare "note:" is not a dictation
}

/** A DM from ZY: a dictation is scribed, a thread reply acks that ping, then the commands. */
export async function handleMessage(deps: HandlerDeps, message: DmMessage): Promise<void> {
  if (message.userId !== deps.userId) return;

  // A dictation wins over the thread-ack: dictated under a ping, it is about the ping.
  const note = dictationText(message.text);
  if (note !== null && deps.scribe) {
    void runScribe(deps, message, note);
    return;
  }

  if (message.threadTs) {
    const parent = deps.store.findByMessage(message.channel, message.threadTs);
    if (parent) {
      deps.store.markAcked(parent.key, deps.now().toISOString());
      deps.log(`reply ack ${parent.itemId}`);
      await postMessage(deps, { channel: message.channel, text: "Noted.", thread_ts: message.threadTs });
      return;
    }
  }

  if (message.text.trim().toLowerCase() === "briefing") {
    const board = await deps.board.fetchBoard(deps.owner, deps.number);
    const today = localNow(deps.now(), TZ).date;
    const preview = plan(board.items, today, "M", []);
    await postMessage(deps, { channel: message.channel, text: ["(preview)", preview.briefing ?? ""].join("\n\n").trim() });
    for (const ping of preview.pings) await postMessage(deps, { channel: message.channel, text: ping.text });
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

  await postMessage(deps, { channel: message.channel, text: UNKNOWN_DM });
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
  if (!message.threadTs) return null;
  const parent = deps.store.findByMessage(message.channel, message.threadTs);
  if (!parent) return null;
  try {
    const board = await deps.board.fetchBoard(deps.owner, deps.number);
    return board.items.find((item) => item.id === parent.itemId)?.title ?? null;
  } catch (err) {
    // The hint is a nicety: a board the bot cannot read must not stop the note.
    deps.log(`scribe ${message.ts}: no hint, the board read failed: ${errMessage(err)}`);
    return null;
  }
}

/** The scribe's Slack side: everything replies in the dictation's own thread. */
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
  return { channel, ts, key, text };
}

/**
 * Opens the move modal over the click's trigger_id. This is the first call after
 * ack(): a trigger_id is good for three seconds, so there is no board read in
 * front of it: the date it opens on rides in the button's value.
 */
async function openMoveModal(deps: HandlerDeps, click: ActionClick, ping: PingRecord, target: string | null): Promise<void> {
  const triggerId = click.triggerId;
  const channel = click.channel;
  const ts = click.ts;
  if (!triggerId || !channel || !ts) {
    deps.log(`move ${ping.key}: the click carries no trigger_id`);
    return;
  }
  const meta: MoveMetadata = { channel, ts, key: ping.key, text: truncate(originalText(click.blocks, click.text), MAX_METADATA_TEXT) };
  try {
    await deps.client.views.open({ trigger_id: triggerId, view: moveView(meta, target) });
  } catch (err) {
    deps.log(`move ${ping.key}: views.open failed: ${errMessage(err)}`);
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
    const field = board.fields.get("Target date");
    if (!field) throw new Error('the board has no "Target date" field');
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
  await updateMessage(deps, meta.channel, meta.ts, `${meta.text}\n→ ${line}`, [section(meta.text), context(`→ ${line}`)]);
}

/** Performs the board write behind a button and returns the result line. */
async function applyAction(deps: HandlerDeps, actionId: Exclude<ActionId, "move">, ping: PingRecord): Promise<string> {
  if (actionId === "ack") return "acked";
  const board = await deps.board.fetchBoard(deps.owner, deps.number);
  if (actionId === "done") {
    const field = board.fields.get("Status");
    const option = field?.options?.get(STATUS.done);
    if (!field || !option) throw new Error(`the board has no "Status" field with a "${STATUS.done}" option`);
    await deps.board.setSingleSelect(board.projectId, ping.itemId, field.id, option);
    return `marked ${STATUS.done} on the board`;
  }
  const field = board.fields.get("Next touch");
  if (!field) throw new Error('the board has no "Next touch" field');
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
}

export class SlackBot implements Sender {
  readonly app: App;
  #userId: string;
  #scribe: ScribeDeps | null;
  #deps: Omit<HandlerDeps, "client">;

  constructor(options: SlackBotOptions) {
    this.#userId = options.userId;
    const scribe = options.scribe ?? null;
    this.#scribe = scribe;
    this.#deps = {
      store: options.store,
      board: options.board,
      owner: options.owner,
      number: options.number,
      userId: options.userId,
      now: options.now,
      log: options.log,
      manual: options.manual,
      scribe: scribe === null ? null : (dictation, ui) => scribeHandler(scribe, dictation, ui),
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
