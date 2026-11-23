// Slack: the DM channel the assistant talks in, the ping messages with their
// buttons, and the DM commands. Bolt over socket mode, so no public URL.
//
// The two handlers are plain functions over HandlerDeps (a Slack client, the
// store, the board), so they can be tested without Bolt and without network.

import { App, LogLevel } from "@slack/bolt";
import { errMessage } from "./errors.ts";
import type { BoardSource } from "./github.ts";
import { plan, type ActionId, type Ping } from "./rules.ts";
import { STATUS } from "./schema.ts";
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

interface ActionsBlock {
  type: "actions";
  elements: Array<{ type: "button"; action_id: string; text: { type: "plain_text"; text: string }; value: string }>;
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

const HELP = [
  "zy-assistant: I DM you the board plan in the morning and at end of day.",
  'Reply "briefing" for a preview of the morning plan.',
  "A button, or a reply in a ping's thread, marks the ping acked.",
].join("\n");

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
}

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
  // The write is done: if the message update fails it is only cosmetic.
  await updateMessage(deps, click.channel, click.ts, `${text}\n→ ${result}`, [section(text), context(`→ ${result}`)]);
}

/** A DM from ZY: a thread reply acks that ping, "briefing" previews, else help. */
export async function handleMessage(deps: HandlerDeps, message: DmMessage): Promise<void> {
  if (message.userId !== deps.userId) return;

  if (message.threadTs) {
    const parent = deps.store.findByMessage(message.channel, message.threadTs);
    if (parent) {
      deps.store.markAcked(parent.key, deps.now().toISOString());
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

  await postMessage(deps, { channel: message.channel, text: HELP });
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
}

export class SlackBot implements Sender {
  readonly app: App;
  #userId: string;
  #deps: Omit<HandlerDeps, "client">;

  constructor(options: SlackBotOptions) {
    this.#userId = options.userId;
    this.#deps = {
      store: options.store,
      board: options.board,
      owner: options.owner,
      number: options.number,
      userId: options.userId,
      now: options.now,
      log: options.log,
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
