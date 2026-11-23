// The Slack side without Bolt and without network: the two handlers over a fake
// client, a fake board and the fake store, plus the button date rule.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, BoardSource } from "../src/github.ts";
import type { Item, Ping } from "../src/rules.ts";
import {
  handleAction,
  handleMessage,
  handleMoveSubmit,
  pingBlocks,
  touchDate,
  type ActionClick,
  type Block,
  type HandlerDeps,
  type MoveSubmit,
  type PostMessageArgs,
  type SlackClient,
  type UpdateMessageArgs,
  type ViewsOpenArgs,
} from "../src/slack.ts";
import { FakeStore } from "./fakes.ts";

class FakeClient implements SlackClient {
  readonly posts: PostMessageArgs[] = [];
  readonly updates: UpdateMessageArgs[] = [];
  readonly modals: ViewsOpenArgs[] = [];
  failUpdate = false;
  failViews = false;

  readonly chat = {
    postMessage: async (args: PostMessageArgs): Promise<{ ts?: string }> => {
      this.posts.push(args);
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
  const deps: HandlerDeps = {
    client,
    board,
    store,
    owner: "rhapsody008",
    number: 1,
    userId: "U_ZY",
    now: () => new Date("2026-11-27T01:00:00Z"), // Friday 09:00 in Singapore
    log: (line) => logs.push(line),
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
  return { deps, client, board, store, logs };
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
