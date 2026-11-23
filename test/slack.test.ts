// The Slack side without Bolt and without network: the two handlers over a fake
// client, a fake board and the fake store, plus the button date rule.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, BoardSource } from "../src/github.ts";
import { DEFAULT_POLICY, type Item, type Ping } from "../src/rules.ts";
import type { AskInput, AskUi } from "../src/ask.ts";
import {
  askBlocks,
  dictationText,
  handleAction,
  helpRequest,
  isTodayCommand,
  selectFolders,
  handleMessage,
  handleMoveSubmit,
  pingBlocks,
  touchDate,
  type ActionClick,
  type Block,
  type HandlerDeps,
  type MoveSubmit,
  type AskDispatch,
  type PostMessageArgs,
  type ScribeDispatch,
  type SlackClient,
  type UpdateMessageArgs,
  type ViewsOpenArgs,
} from "../src/slack.ts";
import type { ManualSettings } from "../src/manual.ts";
import type { ScribeDictation, ScribeUi } from "../src/scribe-handler.ts";
import { FakeStore } from "./fakes.ts";

class FakeClient implements SlackClient {
  readonly posts: PostMessageArgs[] = [];
  readonly updates: UpdateMessageArgs[] = [];
  readonly modals: ViewsOpenArgs[] = [];
  failUpdate = false;
  failViews = false;
  /** Called after every post: a test waits on the reply it expects. */
  onPost: (() => void) | null = null;

  readonly chat = {
    postMessage: async (args: PostMessageArgs): Promise<{ ts?: string }> => {
      this.posts.push(args);
      this.onPost?.();
      return { ts: `ts-${this.posts.length}` };
    },
    update: async (args: UpdateMessageArgs): Promise<unknown> => {
      this.updates.push(args);
      if (this.failUpdate) throw new Error("message_not_found");
      return { ok: true };
    },
  };

  readonly views = {
    open: async (args: ViewsOpenArgs): Promise<unknown> => {
      this.modals.push(args);
      if (this.failViews) throw new Error("trigger_expired");
      return { ok: true };
    },
  };
}

class FakeBoard implements BoardSource {
  readonly board: Board = {
    projectId: "PVT_1",
    title: "Board",
    fields: new Map([
      ["Status", { id: "F_STATUS", options: new Map([["Done", "O_DONE"]]) }],
      ["Next touch", { id: "F_TOUCH" }],
      ["Target date", { id: "F_TARGET" }],
    ]),
    items: [],
  };
  readonly singleSelects: Array<{ projectId: string; itemId: string; fieldId: string; optionId: string }> = [];
  readonly dates: Array<{ projectId: string; itemId: string; fieldId: string; date: string }> = [];
  readonly comments: Array<{ subjectId: string; body: string }> = [];
  reads = 0;
  failWrites = false;
  failDates = false;
  failComments = false;

  async fetchBoard(): Promise<Board> {
    this.reads += 1;
    return this.board;
  }

  async setDate(projectId: string, itemId: string, fieldId: string, date: string): Promise<void> {
    if (this.failWrites) throw new Error("board is down");
    if (this.failDates) throw new Error("date write refused");
    this.dates.push({ projectId, itemId, fieldId, date });
  }

  async setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    if (this.failWrites) throw new Error("board is down");
    this.singleSelects.push({ projectId, itemId, fieldId, optionId });
  }

  async addComment(subjectId: string, body: string): Promise<void> {
    if (this.failWrites) throw new Error("board is down");
    if (this.failComments) throw new Error("comment is down");
    this.comments.push({ subjectId, body });
  }
}

const KEY = "2026-11-25:M:ITEM_1";
const PING_TEXT = "notes#52 A: due today";
const MESSAGE_TEXT = `${PING_TEXT}`;
const TARGET = "2026-11-25";

// What a button of the ping carries: the key, and the target date it was sent
// with, so the move modal can open on it without a board read.
const VALUE = JSON.stringify({ key: KEY, target: TARGET });

// The ping message as Slack hands it back in a block action: a section and the
// buttons of that ping.
const MESSAGE_BLOCKS: Block[] = [
  { type: "section", text: { type: "mrkdwn", text: PING_TEXT } },
  {
    type: "actions",
    elements: [
      { type: "button", action_id: "zy_ack", text: { type: "plain_text", text: "👍 On it" }, value: VALUE },
      { type: "button", action_id: "zy_done", text: { type: "plain_text", text: "✅ Done" }, value: VALUE },
    ],
  },
];

/** A ping sent before the button value carried the target: the key alone. */
const OLD_MESSAGE_BLOCKS: Block[] = [
  { type: "section", text: { type: "mrkdwn", text: PING_TEXT } },
  {
    type: "actions",
    elements: [{ type: "button", action_id: "zy_move", text: { type: "plain_text", text: "Move date" }, value: KEY }],
  },
];

function boardItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "ITEM_1",
    ref: "notes#52",
    title: "A",
    url: "https://github.com/rhapsody008/notes/issues/52",
    status: "In progress",
    target: "2026-11-25",
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
    type: null,
    stage: null,
    track: null,
    account: null,
    cadence: null,
    parentUrl: null,
    contentId: "I_52",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function harness(item: Item | null = null) {
  const client = new FakeClient();
  const board = new FakeBoard();
  if (item) board.board.items.push(item);
  const store = new FakeStore();
  const logs: string[] = [];
  const manual: ManualSettings = {
    briefTime: "09:00",
    eodTime: "17:30",
    notesRepo: null,
    ask: false,
    policy: DEFAULT_POLICY,
  };
  const deps: HandlerDeps = {
    client,
    board,
    store,
    owner: "rhapsody008",
    number: 1,
    userId: "U_ZY",
    now: () => new Date("2026-11-27T01:00:00Z"), // Friday 09:00 in Singapore
    log: (line) => logs.push(line),
    manual,
  };
  store.recordPing({
    key: KEY,
    itemId: "ITEM_1",
    date: "2026-11-25",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-25T01:00:00.000Z",
    channel: "D",
    ts: "111.1",
  });
  return { deps, client, board, store, logs, manual };
}

function click(overrides: Partial<ActionClick> = {}): ActionClick {
  return {
    actionId: "zy_done",
    value: VALUE,
    userId: "U_ZY",
    channel: "D",
    ts: "111.1",
    blocks: MESSAGE_BLOCKS,
    text: MESSAGE_TEXT,
    triggerId: "TRIGGER_1",
    ...overrides,
  };
}

const hasButtons = (blocks: Block[] | undefined): boolean => (blocks ?? []).some((b) => b.type === "actions");

test("a Done click writes the Status field with the Done option for that item", async () => {
  const { deps, client, board, store } = harness();
  await handleAction(deps, click({ actionId: "zy_done" }));

  assert.deepEqual(board.singleSelects, [
    { projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_STATUS", optionId: "O_DONE" },
  ]);
  assert.equal(client.updates.length, 1);
  assert.match(client.updates[0].text, /→ marked Done on the board/);
  assert.equal(hasButtons(client.updates[0].blocks), false, "the buttons are dropped");
  assert.match(client.updates[0].text, /notes#52 A: due today/, "the ping text is kept");
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("a +7 days click writes Next touch a week out (Friday -> Friday)", async () => {
  const { deps, client, board } = harness();
  await handleAction(deps, click({ actionId: "zy_touch7" }));

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TOUCH", date: "2026-12-04" }]);
  assert.match(client.updates[0].text, /→ next touch Fri 4 Dec/);
});

test("a successful click is logged with the action and the item, and a failed one is not", async () => {
  const { deps, logs } = harness();
  await handleAction(deps, click({ actionId: "zy_ack" }));
  assert.deepEqual(logs, ["button ack on ITEM_1 by U_ZY"]);

  const failed = harness();
  failed.board.failWrites = true;
  await handleAction(failed.deps, click({ actionId: "zy_done" }));
  assert.deepEqual(failed.logs, ["button done on 2026-11-25:M:ITEM_1 failed: board is down"], "the failure line, not a success one");
});

test("a thread reply that acks a ping is logged with the item", async () => {
  const { deps, logs } = harness();
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: "111.1", text: "shipped it" });

  assert.deepEqual(logs, ["reply ack ITEM_1"]);
});

test("a click from anyone but ZY does nothing", async () => {
  const { deps, client, board, store } = harness();
  await handleAction(deps, click({ userId: "U_OTHER" }));

  assert.deepEqual(board.singleSelects, []);
  assert.deepEqual(board.dates, []);
  assert.equal(client.updates.length, 0);
  assert.equal(store.findByKey(KEY)?.ackedAt, null);
});

test("a board write failure keeps the buttons and reports failed", async () => {
  const { deps, client, board, store } = harness();
  board.failWrites = true;
  await handleAction(deps, click({ actionId: "zy_done" }));

  assert.equal(client.updates.length, 1);
  assert.match(client.updates[0].text, /→ failed: board is down/);
  assert.equal(hasButtons(client.updates[0].blocks), true, "the buttons stay for a retry");
  assert.equal(store.findByKey(KEY)?.ackedAt, null, "nothing was written, so nothing is acked");
});

test("a failed chat.update after a successful write is not reported as a failed write", async () => {
  const { deps, client, board, store, logs } = harness();
  client.failUpdate = true;
  await handleAction(deps, click({ actionId: "zy_done" }));

  assert.deepEqual(board.singleSelects, [
    { projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_STATUS", optionId: "O_DONE" },
  ]);
  assert.equal(client.updates.length, 1, "the update was attempted once");
  assert.doesNotMatch(client.updates[0].text, /failed/);
  assert.match(logs.join("\n"), /chat.update failed for message 111\.1: message_not_found/);
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("a thread reply to a recorded ping acks it and answers in the parent thread", async () => {
  const { deps, client, store } = harness();
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: "111.1", text: "shipped it" });

  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].text, "Noted.");
  assert.equal(client.posts[0].thread_ts, "111.1", "the reply goes to the ping, not the user's message");
});

test("a reply from anyone but ZY is ignored", async () => {
  const { deps, client, store } = harness();
  await handleMessage(deps, { userId: "U_OTHER", channel: "D", ts: "222.2", threadTs: "111.1", text: "hi" });

  assert.equal(store.findByKey(KEY)?.ackedAt, null);
  assert.equal(client.posts.length, 0);
});

test("touch1 on a Friday moves to Monday", () => {
  assert.equal(touchDate("2026-11-27", "touch1"), "2026-11-30");
});

test("touch1 on a Thursday is the Friday", () => {
  assert.equal(touchDate("2026-11-26", "touch1"), "2026-11-27");
});

test("touch7 on a Friday is the next Friday", () => {
  assert.equal(touchDate("2026-11-27", "touch7"), "2026-12-04");
});

test("touch7 from a Saturday, if it ever fires then, still lands on a weekday", () => {
  assert.equal(touchDate("2026-11-28", "touch7"), "2026-12-07");
});

const META = JSON.stringify({ channel: "D", ts: "111.1", key: KEY, text: PING_TEXT });

function submit(overrides: Partial<MoveSubmit> = {}): MoveSubmit {
  return { userId: "U_ZY", metadata: META, date: "2026-12-02", reason: "the Acme workshop moved", ...overrides };
}

/** The modal as Slack receives it, so the test reads blocks without the types. */
const asSent = (args: ViewsOpenArgs): Record<string, any> => JSON.parse(JSON.stringify(args.view));

test("a Move date click opens the modal with the current date and a required reason", async () => {
  const { deps, client, board, store } = harness(boardItem());
  await handleAction(deps, click({ actionId: "zy_move" }));

  assert.equal(client.modals.length, 1, "a modal, not a board write");
  assert.equal(client.modals[0].trigger_id, "TRIGGER_1", "the click's own trigger_id");
  assert.equal(board.reads, 0, "the board is not read before views.open: the trigger_id is short lived");
  const view = asSent(client.modals[0]);
  assert.equal(view.type, "modal");
  assert.equal(view.callback_id, "zy_move");
  assert.equal(view.private_metadata, META, "the ping rides along, text and all");
  assert.equal(view.blocks[0].element.type, "datepicker");
  assert.equal(view.blocks[0].element.initial_date, TARGET, "the date the ping was sent with");
  assert.equal(view.blocks[1].block_id, "reason");
  assert.equal(view.blocks[1].element.type, "plain_text_input");
  assert.equal(view.blocks[1].element.optional, undefined, "a reason is required");

  assert.deepEqual(board.dates, [], "opening the modal writes nothing");
  assert.equal(store.findByKey(KEY)?.ackedAt, null, "and it acks nothing");
});

test("a button from before the value carried the date opens the modal with no date", async () => {
  const { deps, client, board } = harness(boardItem());
  await handleAction(deps, click({ actionId: "zy_move", blocks: OLD_MESSAGE_BLOCKS, value: KEY }));

  assert.equal(client.modals.length, 1, "the bare key still finds its ping");
  assert.equal(board.reads, 0);
  assert.equal(asSent(client.modals[0]).blocks[0].element.initial_date, undefined, "nothing to fill in, ZY picks");
});

test("the buttons sent with a ping carry the target date and open the modal on it", async () => {
  const ping: Ping = { key: KEY, itemId: "ITEM_1", kind: "ping", text: PING_TEXT, actions: ["ack", "move"] };
  const blocks = pingBlocks(ping, "2026-12-04");
  const sent = JSON.parse(JSON.stringify(blocks)) as Array<Record<string, any>>;
  const value = sent[1].elements[1].value as string;

  const { deps, client, board } = harness(boardItem());
  await handleAction(deps, click({ actionId: "zy_move", blocks, value }));

  assert.equal(client.modals.length, 1);
  assert.equal(board.reads, 0);
  assert.equal(asSent(client.modals[0]).blocks[0].element.initial_date, "2026-12-04");
});

test("a click without a trigger_id opens no modal", async () => {
  const { deps, client, logs } = harness(boardItem());
  await handleAction(deps, click({ actionId: "zy_move", triggerId: null }));

  assert.deepEqual(client.modals, []);
  assert.match(logs.join("\n"), /move .*: the click carries no trigger_id/);
});

test("a submitted move sets the date, comments on the issue, then closes the ping", async () => {
  const { deps, client, board, store } = harness(boardItem());
  await handleMoveSubmit(deps, submit());

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.deepEqual(board.comments, [
    { subjectId: "I_52", body: "Target date moved 2026-11-25 → 2026-12-02 by zy-assistant: the Acme workshop moved" },
  ]);
  assert.equal(client.updates.length, 1);
  assert.match(client.updates[0].text, /notes#52 A: due today[\s\S]*→ Moved to Wed 2 Dec \(the Acme workshop moved\)/);
  assert.equal(hasButtons(client.updates[0].blocks), false, "the buttons are gone");
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
  assert.deepEqual(client.posts, [], "an issue gets a comment, not a thread reply");
});

test("a draft has no issue to comment on: the note goes in the ping's thread", async () => {
  const draft = boardItem({ ref: "draft", title: "Draft: Kilo follow-up", contentId: null });
  const { deps, client, board, store } = harness(draft);
  await handleMoveSubmit(deps, submit({ reason: "waiting on Globex" }));

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.deepEqual(board.comments, []);
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "111.1", "the ping's own thread");
  assert.match(client.posts[0].text, /^Target date moved 2026-11-25 → 2026-12-02 by zy-assistant: waiting on Globex$/);
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("a move is logged as the old and the new date, and never the reason", async () => {
  const { deps, board, logs } = harness(boardItem());
  await handleMoveSubmit(deps, submit({ date: "2026-12-02", reason: "the Acme workshop moved" }));

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.deepEqual(logs, ["move ITEM_1: 2026-11-25 -> 2026-12-02"]);
});

test("a move submit from anyone but ZY is ignored", async () => {
  const { deps, client, board, store } = harness(boardItem());
  await handleMoveSubmit(deps, submit({ userId: "U_OTHER" }));

  assert.deepEqual(board.dates, []);
  assert.deepEqual(client.updates, []);
  assert.equal(store.findByKey(KEY)?.ackedAt, null);
});

test("a move without a reason writes nothing", async () => {
  const { deps, client, board, store, logs } = harness(boardItem());
  await handleMoveSubmit(deps, submit({ reason: "   " }));

  assert.deepEqual(board.dates, []);
  assert.deepEqual(client.updates, []);
  assert.equal(store.findByKey(KEY)?.ackedAt, null);
  assert.match(logs.join("\n"), /both a date and a reason are required/);
});

test("a failed board write says so in the thread and leaves the ping alone", async () => {
  const { deps, client, board, store, logs } = harness(boardItem());
  board.failWrites = true;
  await handleMoveSubmit(deps, submit());

  assert.equal(client.updates.length, 0, "the ping keeps its buttons for another try");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "111.1");
  assert.match(client.posts[0].text, /→ move failed: board is down/);
  assert.equal(store.findByKey(KEY)?.ackedAt, null);
  assert.match(logs.join("\n"), /move .* failed: board is down/);
});

test("a refused setDate writes nothing, leaves the buttons and says so", async () => {
  const { deps, client, board, store, logs } = harness(boardItem());
  board.failDates = true;
  await handleMoveSubmit(deps, submit());

  assert.deepEqual(board.dates, [], "the date did not move");
  assert.deepEqual(board.comments, [], "and no note was written for a move that did not happen");
  assert.equal(client.updates.length, 0, "the ping keeps its buttons for another try");
  assert.equal(client.posts.length, 1);
  assert.match(client.posts[0].text, /→ move failed: date write refused/);
  assert.equal(store.findByKey(KEY)?.ackedAt, null, "nothing moved, nothing is acked");
  assert.doesNotMatch(logs.join("\n"), /comment failed/);
});

test("a failed comment after the date is set still counts the move", async () => {
  const { deps, client, board, store, logs } = harness(boardItem());
  board.failComments = true;
  await handleMoveSubmit(deps, submit());

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.deepEqual(board.comments, [], "the comment did not land");
  assert.equal(client.posts.length, 1, "the reason is not lost: it goes in the thread");
  assert.equal(client.posts[0].thread_ts, "111.1");
  assert.match(
    client.posts[0].text,
    /^Target date moved 2026-11-25 → 2026-12-02 by zy-assistant: the Acme workshop moved \(comment failed: comment is down\)$/,
  );
  assert.equal(client.updates.length, 1);
  assert.match(client.updates[0].text, /→ Moved to Wed 2 Dec \(the Acme workshop moved\)/);
  assert.equal(hasButtons(client.updates[0].blocks), false, "the ping is closed either way");
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z", "the date moved, so the move counts");
  assert.match(logs.join("\n"), /move .*: comment failed: comment is down/);
});

test("a second submit of the same move is answered and changes nothing", async () => {
  const { deps, client, board, store } = harness(boardItem());
  await handleMoveSubmit(deps, submit());
  await handleMoveSubmit(deps, submit({ date: "2026-12-09", reason: "trying again" }));

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.equal(board.comments.length, 1, "no second comment");
  assert.equal(client.updates.length, 1, "no second update");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "111.1");
  assert.match(client.posts[0].text, /already handled/);
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("a metadata that points at no ping is logged, not thrown", async () => {
  const { deps, client, board, logs } = harness(boardItem());
  await handleMoveSubmit(deps, submit({ metadata: "not json" }));

  assert.deepEqual(board.dates, []);
  assert.deepEqual(client.updates, []);
  assert.match(logs.join("\n"), /private_metadata holds no ping/);
});

/** A scribe that only records: what it was asked to do, and the ui it was given. */
function recordScribe() {
  const calls: ScribeDictation[] = [];
  const uis: ScribeUi[] = [];
  let resolve = (): void => {};
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  const dispatch: ScribeDispatch = async (dictation, ui) => {
    calls.push(dictation);
    uis.push(ui);
    resolve();
  };
  return { calls, uis, settled, dispatch };
}

/** An ask that only records: what it was asked, and the ui it was given. */
function recordAsk() {
  const calls: AskInput[] = [];
  const uis: AskUi[] = [];
  let resolve = (): void => {};
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  const dispatch: AskDispatch = async (input, ui) => {
    calls.push(input);
    uis.push(ui);
    resolve();
  };
  return { calls, uis, settled, dispatch };
}

/** Resolves once the fake client has posted one more message: no timers. */
function nextPost(client: FakeClient): Promise<void> {
  return new Promise<void>((resolve) => {
    client.onPost = resolve;
  });
}

test("only a message that starts with note: is a dictation", () => {
  assert.equal(dictationText("note: ten nodes"), "ten nodes");
  assert.equal(dictationText("  Note :  ten nodes  "), "ten nodes");
  assert.equal(dictationText("note:no space"), "no space");
  assert.equal(dictationText("note:  "), null, "a bare note: is not a dictation");
  assert.equal(dictationText("notes: ten nodes"), null);
  assert.equal(dictationText("please note: ten nodes"), null, "the prefix is the first thing in the message");
  assert.equal(dictationText("briefing"), null);
});

test("a note: DM reaches the scribe in the background, without the prefix", async () => {
  const { deps, client } = harness();
  const scribe = recordScribe();
  deps.scribe = scribe.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "  Note:  ten nodes is enough  " });
  await scribe.settled;

  assert.deepEqual(scribe.calls, [{ ts: "222.2", text: "ten nodes is enough", hint: null }]);
  assert.deepEqual(client.posts, [], "the handler returns at once: the flow does the talking");
});

test("a note: in a ping's thread is about that item, and is not an ack", async () => {
  const { deps, store } = harness(boardItem({ title: "Acme VPC sizing" }));
  const scribe = recordScribe();
  deps.scribe = scribe.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: "111.1", text: "note: ten nodes is enough" });
  await scribe.settled;

  assert.deepEqual(scribe.calls, [{ ts: "222.2", text: "ten nodes is enough", hint: "Acme VPC sizing" }]);
  assert.equal(store.findByKey(KEY)?.ackedAt, null, "a dictated note is not a quiet ack");
});

test("a note: from anyone but ZY does nothing at all", async () => {
  const { deps, client } = harness(boardItem());
  const scribe = recordScribe();
  deps.scribe = scribe.dispatch;

  await handleMessage(deps, { userId: "U_OTHER", channel: "D", ts: "222.2", threadTs: null, text: "note: ten nodes" });

  assert.deepEqual(scribe.calls, []);
  assert.deepEqual(client.posts, []);
});

test("a DM that is no command gets one hint naming today and help", async () => {
  const { deps, client } = harness();

  // With no scribe, "note:" is no dictation either: it gets the same hint.
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "note: ten nodes" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: null, text: "ping:" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.4", threadTs: null, text: "how does the Acme deck look?" });

  assert.deepEqual(client.posts.map((post) => post.text), [
    "I didn't catch that. Type `today` or `help`.",
    "I didn't catch that. Type `today` or `help`.",
    "I didn't catch that. Type `today` or `help`.",
  ]);
});

test("with the scribe on, the unknown-DM hint offers note: too", async () => {
  const { deps, client } = harness();
  deps.scribe = async () => {};

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "ping" });

  assert.deepEqual(client.posts.map((post) => post.text), ["I didn't catch that. Type `today`, `note: …`, or `help`."]);
});

test("a plain DM is a question when a model is set, and the handler returns at once", async () => {
  const { deps, client, logs } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "how is the Acme POC going?" });
  await ask.settled;

  assert.deepEqual(ask.calls, [{ ts: "222.2", question: "how is the Acme POC going?", threadTs: "222.2" }], "answered in a thread of its own");
  assert.deepEqual(client.posts, [], "the pipeline does the talking, off the handler's path");
  assert.deepEqual(logs, []);
});

test("a message from anyone but ZY is never a question either", async () => {
  const { deps } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_OTHER", channel: "D", ts: "222.2", threadTs: null, text: "how is the Acme POC going?" });

  assert.deepEqual(ask.calls, []);
});

test("the commands are still commands with a model set: today, help, and note:", async () => {
  const { deps, client } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;
  deps.scribe = async () => {};

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "today" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: null, text: "help" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.4", threadTs: null, text: "note: ten nodes" });

  assert.deepEqual(ask.calls, [], "none of the three is a question");
  assert.equal(client.posts.length, 2, "the preview and the manual");
});

test("a reply in a ping's thread still acks it, and is never a question", async () => {
  const { deps, client, store } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: "111.1", text: "how is the Acme POC going?" });

  assert.deepEqual(ask.calls, []);
  assert.equal(store.findByKey(KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
  assert.equal(client.posts[0].text, "Noted.");
});

test("a reply in a dictation's thread is a question, not an ack", async () => {
  const { deps, client } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;
  deps.scribe = async () => {};

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.9", threadTs: "222.2", text: "what did we decide about Acme?" });
  await ask.settled;

  assert.deepEqual(ask.calls, [{ ts: "222.9", question: "what did we decide about Acme?", threadTs: "222.2" }], "answered in the scribe thread");
  assert.deepEqual(client.posts, [], "and nothing is acked: a dictation thread is nobody's ping");
});

test("a reply under a briefing or a today preview is a question too", async () => {
  const { deps } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.4", threadTs: "111.7", text: "what's waiting on others?" });
  await ask.settled;

  assert.deepEqual(ask.calls, [{ ts: "222.4", question: "what's waiting on others?", threadTs: "111.7" }]);
  assert.equal(deps.store.findByKey(KEY)?.ackedAt, null, "no ping is acked by it");
});

test("a reply in the thread of an answer is a follow-up in that same thread", async () => {
  const { deps } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: "222.2", text: "and the Globex one?" });
  await ask.settled;

  assert.deepEqual(ask.calls, [{ ts: "222.3", question: "and the Globex one?", threadTs: "222.2" }], "the thread of the answer, not the question");
});

test("an empty DM text is no question: it gets the hint even with a model set", async () => {
  const { deps, client } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "   " });

  assert.deepEqual(ask.calls, []);
  assert.deepEqual(client.posts.map((post) => post.text), ["I didn't catch that. Type `today` or `help`."]);
});

test("an ask that throws is logged and answered in the thread, never thrown out", async () => {
  const { deps, client, logs } = harness();
  deps.ask = async () => {
    throw new Error("the ask blew up");
  };
  const posted = nextPost(client);

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "how is the Acme POC going?" });
  await posted;

  assert.equal(client.posts[0].thread_ts, "222.2");
  assert.equal(client.posts[0].text, "couldn't answer: the ask blew up");
  assert.match(logs.join("\n"), /ask 222\.2 failed: the ask blew up/);
});

test("the pipeline gets the bot's Slack side of the thread it answers in", async () => {
  const { deps, client } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: null, text: "what's waiting on others?" });
  await ask.settled;
  const ui = ask.uis[0];

  assert.equal(await ui.reply("🔎 looking…"), "ts-1");
  assert.deepEqual(client.posts[0], { channel: "D", text: "🔎 looking…", thread_ts: "222.3" }, "the answer lands in the question's thread");
  await ui.edit("ts-1", "the answer");
  assert.deepEqual(client.updates[0], { channel: "D", ts: "ts-1", text: "the answer" });
});

test("today sends the morning preview, and briefing still does the same", async () => {
  const { deps, client, board, logs } = harness();

  for (const text of ["today", "  TODAY ", "briefing", "Briefing"]) {
    await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text });
  }

  assert.equal(board.reads, 4, "each command reads the board");
  assert.equal(client.posts.length, 4);
  for (const post of client.posts) {
    assert.match(post.text, /^\(preview\)\n\n\*Morning briefing, Fri 27 Nov\*/);
    assert.equal(post.blocks, undefined, "the preview is plain text, not the manual");
  }
  assert.deepEqual(logs, [], "neither command is logged: nothing was asked of the manual");
});

test("help, ? and manual all answer the overview, and with the scribe off it never mentions notes", async () => {
  const { deps, client } = harness();

  for (const text of ["help", "?", "  Manual  ", "HELP"]) {
    await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text });
  }

  assert.equal(client.posts.length, 4);
  for (const post of client.posts) {
    assert.ok(post.blocks !== undefined && post.blocks.length > 1, `${post.text} is a manual, not a line`);
    assert.match(post.text, /More: `help pings`, `help buttons`, `help updates`, `help today`$/);
    assert.doesNotMatch(post.text, /note:|`note`/);
  }
});

test("help <topic> answers that page, and an unknown topic keeps the overview with the miss on top", async () => {
  const { deps, client, logs } = harness();

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "help buttons" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: null, text: "help Pings" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.4", threadTs: null, text: "help horoscope" });

  assert.match(client.posts[0].text, /^\*Buttons\*\n\nEvery ping has buttons under it/, "the page, not the overview");
  assert.doesNotMatch(client.posts[0].text, /More: `help pings`/);
  assert.match(client.posts[1].text, /^\*Pings\*/, "the topic is matched however it is typed");
  assert.match(client.posts[2].text, /^No topic `horoscope`\. Here is the overview\./);
  assert.match(client.posts[2].text, /More: `help pings`/);
  assert.deepEqual(logs, ["help buttons", "help Pings", "help horoscope"], "ids only: what was asked for");
});

test("a help request is read from the command words alone", () => {
  assert.equal(helpRequest("help"), "");
  assert.equal(helpRequest("  HELP "), "");
  assert.equal(helpRequest("?"), "");
  assert.equal(helpRequest("manual"), "");
  assert.equal(helpRequest("help buttons"), "buttons");
  assert.equal(helpRequest("Help   Pings "), "Pings");
  assert.equal(helpRequest("helpful"), null);
  assert.equal(helpRequest("today"), null, "today is its own command");
  assert.equal(helpRequest("briefing"), null, "and so is its old name");
  assert.equal(helpRequest("note: ten nodes"), null);
  assert.equal(helpRequest(""), null);
});

test("with the scribe on, the manual has the note topic and its page says how to dictate", async () => {
  const { deps, client } = harness();
  deps.scribe = async () => {};

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "help" });
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: null, text: "help note" });

  assert.match(client.posts[0].text, /`note: <text>`: `note: Acme call/);
  assert.match(client.posts[0].text, /`help note`/);
  assert.match(client.posts[1].text, /^\*Notes\*/);
  assert.match(client.posts[1].text, /`note:` and then the dictation/);
});

test("a scribe that throws says so in the thread instead of failing silently", async () => {
  const { deps, client, logs } = harness();
  deps.scribe = async () => {
    throw new Error("the notes repo is down");
  };
  const posted = nextPost(client);

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "note: ten nodes" });
  await posted;

  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "222.2", "the dictation's own thread");
  assert.equal(client.posts[0].text, "⚠️ the scribe failed: the notes repo is down");
  assert.match(logs.join("\n"), /scribe 222\.2 failed: the notes repo is down/);
});

test("the folder question offers Create, Cancel and the existing folders", () => {
  const blocks = askBlocks({
    ts: "1700.1",
    text: "New folder `Accounts/Initech`?",
    folders: ["Accounts/Acme"],
    create: "Initech",
    retry: false,
  });
  const sent = JSON.parse(JSON.stringify(blocks)) as Array<Record<string, any>>;

  assert.equal(sent[0].type, "section");
  assert.equal(sent[0].text.text, "New folder `Accounts/Initech`?");
  assert.equal(sent[1].block_id, "zy_scribe_1700.1", "the select's block carries the dictation");
  const elements = sent[1].elements as Array<Record<string, any>>;
  assert.deepEqual(elements.map((e) => e.action_id), ["zy_scribe_create", "zy_scribe_cancel", "zy_scribe_folder"]);
  assert.equal(elements[0].value, "1700.1", "the button carries the dictation");
  assert.equal(elements[1].value, "1700.1");
  assert.equal(elements[2].options[0].text.text, "Accounts/Acme");
  assert.equal(elements[2].options[0].value, "Accounts/Acme", "an option is the folder alone");

  // No name to create: there is only an existing folder to pick, or Cancel.
  const bare = JSON.parse(JSON.stringify(askBlocks({ ts: "t", text: "Where should the raw dictation go?", folders: [], create: null, retry: false })));
  assert.deepEqual(bare[1].elements.map((e: Record<string, any>) => e.action_id), ["zy_scribe_cancel"]);

  // A failed write: a Retry button that carries the dictation, and no folders.
  const retry = JSON.parse(JSON.stringify(askBlocks({ ts: "t", text: "Try writing it again?", folders: [], create: null, retry: true })));
  assert.deepEqual(retry[1].elements.map((e: Record<string, any>) => e.action_id), ["zy_scribe_retry", "zy_scribe_cancel"]);
  assert.equal(retry[1].elements[0].value, "t");
});

test("the folder select is capped at 100 options with short values, Accounts first", () => {
  const folders: string[] = [];
  for (let i = 0; i < 75; i += 1) {
    folders.push(`Partners/Globex-${i}`);
    folders.push(`Accounts/Acme-${i}`);
  }
  assert.equal(folders.length, 150);

  const blocks = askBlocks({ ts: "1700.1", text: "Where should this note go?", folders, create: null, retry: false });
  const sent = JSON.parse(JSON.stringify(blocks)) as Array<Record<string, any>>;
  const select = (sent[1].elements as Array<Record<string, any>>).find((e) => e.action_id === "zy_scribe_folder");
  assert.ok(select !== undefined);

  const options = select.options as Array<{ text: { text: string }; value: string }>;
  assert.equal(options.length, 100, "Slack takes at most 100 options");
  for (const option of options) {
    assert.equal(option.value, option.text.text);
    assert.ok(option.value.length <= 150, `${option.value} is one short value`);
  }
  const values = options.map((option) => option.value);
  assert.equal(values[0].valueOf(), "Accounts/Acme-0", "Accounts first");
  assert.deepEqual(values.slice(0, 75).every((value) => value.startsWith("Accounts/")), true);
  assert.deepEqual(values.slice(0, 75), [...values.slice(0, 75)].sort(), "and sorted");
  assert.equal(values[75], "Partners/Globex-0", "then the rest, sorted");
  assert.equal(sent[1].block_id, "zy_scribe_1700.1", "the ts rides in the block_id, not in 100 values");

  assert.deepEqual(selectFolders(["Partners/B", "Accounts/B", "Accounts/A"]), ["Accounts/A", "Accounts/B", "Partners/B"]);
  assert.equal(selectFolders(Array.from({ length: 150 }, (_, i) => `Accounts/A${i}`)).length, 100);
});
