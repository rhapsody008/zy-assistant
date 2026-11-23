// Slack: the DM channel the assistant talks in, the ping messages with their
// buttons, and the DM commands. Bolt over socket mode, so no public URL.
//
// The two handlers are plain functions over HandlerDeps (a Slack client, the
// store, the board), so they can be tested without Bolt and without network.

import { App, LogLevel } from "@slack/bolt";
import type { BoardSource } from "./github.ts";
import { plan, type ActionId, type Ping } from "./rules.ts";
import type { PingRecord, PingStore } from "./store.ts";
import { addDays, fmtDate, localNow, nextWorkday, TZ } from "./time.ts";

export interface Sent {
  channel: string;
  ts: string;
}

export interface Sender {
  sendDm(text: string): Promise<Sent>;
  sendPing(ping: Ping): Promise<Sent>;
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
}

/** Slack rejects a section block over 3000 characters. */
const MAX_SECTION_TEXT = 2900;

const LABELS: Record<ActionId, string> = {
  ack: "👍 On it",
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

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function truncate(text: string, max = MAX_SECTION_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text) } };
}

function context(text: string): ContextBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function actions(key: string, ids: ActionId[]): ActionsBlock {
  return {
    type: "actions",
    elements: ids.map((id) => ({
      type: "button",
      action_id: `zy_${id}`,
      text: { type: "plain_text", text: LABELS[id] },
      value: key,
    })),
  };
}

/** The buttons of a message we sent, so a failed click can keep them. */
function keptActions(blocks: unknown, key: string): ActionsBlock | null {
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
  return ids.length > 0 ? actions(key, ids) : null;
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
  const key = click.value;
  if (!actionId || !key || !click.channel || !click.ts) return;

  const ping = deps.store.findByKey(key);
  if (!ping) {
    deps.log(`button ${actionId}: unknown ping ${key}`);
    return;
  }

  const text = originalText(click.blocks, click.text);
  let result: string;
  try {
    result = await applyAction(deps, actionId, ping);
  } catch (err) {
    // The board write failed: say so and keep the buttons so the click can be retried.
    const failure = `→ failed: ${reason(err)}`;
    deps.log(`button ${actionId} on ${key} failed: ${reason(err)}`);
    const kept = keptActions(click.blocks, key);
    await updateMessage(deps, click.channel, click.ts, `${text}\n${failure}`, [section(text), ...(kept ? [kept] : []), context(failure)]);
    return;
  }

  deps.store.markAcked(key, deps.now().toISOString());
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
    deps.log(`chat.update failed for message ${ts}: ${reason(err)}`);
  }
}

/** Performs the board write behind a button and returns the result line. */
async function applyAction(deps: HandlerDeps, actionId: ActionId, ping: PingRecord): Promise<string> {
  if (actionId === "ack") return "acked";
  const board = await deps.board.fetchBoard(deps.owner, deps.number);
  if (actionId === "done") {
    const field = board.fields.get("Status");
    const option = field?.options?.get("Done");
    if (!field || !option) throw new Error('the board has no "Status" field with a "Done" option');
    await deps.board.setSingleSelect(board.projectId, ping.itemId, field.id, option);
    return "marked Done on the board";
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

  async sendPing(ping: Ping): Promise<Sent> {
    const channel = await this.#dmChannel();
    const text = truncate(ping.text);
    const res = await this.app.client.chat.postMessage({
      channel,
      text,
      blocks: [section(text), actions(ping.key, ping.actions)],
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
