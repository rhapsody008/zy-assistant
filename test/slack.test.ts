// The Slack side without Bolt and without network: the two handlers over a fake
// client, a fake board and the fake store, plus the button date rule.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, BoardSource } from "../src/github.ts";
import {
  handleAction,
  handleMessage,
  touchDate,
  type ActionClick,
  type Block,
  type HandlerDeps,
  type PostMessageArgs,
  type SlackClient,
  type UpdateMessageArgs,
} from "../src/slack.ts";
import { FakeStore } from "./fakes.ts";

class FakeClient implements SlackClient {
  readonly posts: PostMessageArgs[] = [];
  readonly updates: UpdateMessageArgs[] = [];
  failUpdate = false;

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
}

class FakeBoard implements BoardSource {
  readonly board: Board = {
    projectId: "PVT_1",
    title: "Board",
    fields: new Map([
      ["Status", { id: "F_STATUS", options: new Map([["Done", "O_DONE"]]) }],
      ["Next touch", { id: "F_TOUCH" }],
    ]),
    items: [],
  };
  readonly singleSelects: Array<{ projectId: string; itemId: string; fieldId: string; optionId: string }> = [];
  readonly dates: Array<{ projectId: string; itemId: string; fieldId: string; date: string }> = [];
  failWrites = false;

  async fetchBoard(): Promise<Board> {
    return this.board;
  }

  async setDate(projectId: string, itemId: string, fieldId: string, date: string): Promise<void> {
    if (this.failWrites) throw new Error("board is down");
    this.dates.push({ projectId, itemId, fieldId, date });
  }

  async setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    if (this.failWrites) throw new Error("board is down");
    this.singleSelects.push({ projectId, itemId, fieldId, optionId });
  }
}

const KEY = "2026-11-25:M:ITEM_1";
const PING_TEXT = "notes#52 A: due today";
const MESSAGE_TEXT = `${PING_TEXT}`;

// The ping message as Slack hands it back in a block action: a section and the
// buttons of that ping.
const MESSAGE_BLOCKS: Block[] = [
  { type: "section", text: { type: "mrkdwn", text: PING_TEXT } },
  {
    type: "actions",
    elements: [
      { type: "button", action_id: "zy_ack", text: { type: "plain_text", text: "👍 On it" }, value: KEY },
      { type: "button", action_id: "zy_done", text: { type: "plain_text", text: "✅ Done" }, value: KEY },
    ],
  },
];

function harness() {
  const client = new FakeClient();
  const board = new FakeBoard();
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
    value: KEY,
    userId: "U_ZY",
    channel: "D",
    ts: "111.1",
    blocks: MESSAGE_BLOCKS,
    text: MESSAGE_TEXT,
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
