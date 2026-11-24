// The Slack side without Bolt and without network: the two handlers over a fake
// client, a fake board and the fake store, plus the button date rule.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddInput, AddUi } from "../src/add-handler.ts";
import type { Board, BoardSource } from "../src/github.ts";
import { DEFAULT_POLICY, type ActionId, type Briefing, type Item, type Ping } from "../src/rules.ts";
import type { AskInput, AskUi } from "../src/ask.ts";
import {
  addText,
  askBlocks,
  briefingBlocks,
  cardBlocks,
  dictationText,
  editValues,
  editView,
  handleAction,
  handleProposalAction,
  handleProposalEdit,
  handleRowAction,
  menuKeys,
  ROW_LABELS,
  rowEdits,
  splitLines,
  helpRequest,
  isTodayCommand,
  selectFolders,
  handleMessage,
  handleMoveSubmit,
  pingBlocks,
  redrawProposalCard,
  touchDate,
  type ActionClick,
  type AddDispatch,
  type Block,
  type HandlerDeps,
  type MoveSubmit,
  type ProposalActionClick,
  type ProposalEditSubmit,
  type RowClick,
  type AskDispatch,
  type PostMessageArgs,
  type ScribeDispatch,
  type SlackClient,
  type UpdateMessageArgs,
  type ViewsOpenArgs,
} from "../src/slack.ts";
import type { ManualSettings } from "../src/manual.ts";
import {
  cardText,
  proposalValue,
  type Card,
  type EditField,
  type ProposalDeps,
  type ProposalSpec,
} from "../src/proposals.ts";
import type { ScribeDictation, ScribeUi } from "../src/scribe-handler.ts";
import type { Proposal, ProposalStatus } from "../src/store.ts";
import { FakeProposals, FakeStore } from "./fakes.ts";

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
const ROW_KEY = "2026-11-27:M:ITEM_1";
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
    addRepo: null,
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
    rows: rowEdits(),
  };
  // An evening ping: a reply in its thread is an ack.
  store.recordPing({
    key: KEY,
    itemId: "ITEM_1",
    date: "2026-11-25",
    slot: "E",
    kind: "ping",
    sentAt: "2026-11-25T09:30:00.000Z",
    channel: "D",
    ts: "111.1",
  });
  // A morning briefing's row: recorded so its menu finds it, but a reply under
  // the briefing is no ack at all.
  store.recordPing({
    key: ROW_KEY,
    itemId: "ITEM_1",
    date: "2026-11-27",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-27T01:00:00.000Z",
    channel: "D",
    ts: "111.6",
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

test("a note: dictated under the briefing gets no item hint: that thread is every row's", async () => {
  const { deps } = harness(boardItem({ title: "Acme VPC sizing" }));
  const scribe = recordScribe();
  deps.scribe = scribe.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.6", threadTs: "111.6", text: "note: ten nodes is enough" });
  await scribe.settled;

  assert.deepEqual(scribe.calls, [{ ts: "222.6", text: "ten nodes is enough", hint: null }], "the briefing's ts names many rows, so it names no item");
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

  assert.match(client.posts[0].text, /^\*Buttons\*\n\nEvery evening ping has buttons under it/, "the page, not the overview");
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

// ---- the briefing's rows: their menus, and what a pick does ------------------

const rowPing = (itemId: string, actions: ActionId[] = ["ack", "move", "done"]): Ping => ({
  key: `2026-11-27:M:${itemId}`,
  itemId,
  kind: "ping",
  text: `notes#${itemId} Work ${itemId}: *due today*`,
  actions,
});

const briefingOf = (
  rows: Ping[],
  head: string[] = ["*Morning briefing, Fri 27 Nov*", "*Today*"],
  tail: string[] = ["*In progress:* 2"],
): Briefing => ({
  text: [...head, ...rows.map((row) => `• ${row.text}`), ...tail].join("\n\n"),
  head,
  rows,
  tail,
});

/** The blocks as Slack receives them, so a test reads them without the types. */
const asJson = (blocks: Block[]): Array<Record<string, any>> => JSON.parse(JSON.stringify(blocks)) as Array<Record<string, any>>;

/** A message as it stands now: one entry per section, in order, and its menu. */
const messageRows = (blocks: Block[] | undefined): Array<{ text: string; menu: boolean }> =>
  (blocks ?? []).flatMap((block) => (block.type === "section" ? [{ text: block.text.text, menu: block.accessory !== undefined }] : []));

/** The same, with the sections around the rows in place: nothing else may move. */
const BRIEFING_HEAD = [
  { text: "*Morning briefing, Fri 27 Nov*", menu: false },
  { text: "*Today*", menu: false },
];
const BRIEFING_TAIL = [{ text: "*In progress:* 2", menu: false }];

/** A briefing of two rows at ts 111.6, both recorded in the store. */
function twoRows() {
  const h = harness(boardItem());
  h.store.recordPing({
    key: "2026-11-27:M:ITEM_2",
    itemId: "ITEM_2",
    date: "2026-11-27",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-27T01:00:00.000Z",
    channel: "D",
    ts: "111.6",
  });
  const blocks = briefingBlocks(briefingOf([rowPing("ITEM_1"), rowPing("ITEM_2", ["ack", "done"])]), new Map([["ITEM_1", TARGET]]));
  return { ...h, blocks };
}

function rowClick(overrides: Partial<RowClick> = {}): RowClick {
  return {
    value: "ack",
    blockId: `zy_row:${ROW_KEY}`,
    userId: "U_ZY",
    channel: "D",
    ts: "111.6",
    blocks: null,
    triggerId: "TRIGGER_2",
    ...overrides,
  };
}

test("a row's menu carries short values and the labels a person reads", () => {
  const blocks = briefingBlocks(briefingOf([rowPing("52", ["ack", "move", "touch1", "touch7", "done"])]), new Map([["52", "2026-12-02"]]));
  const row = asJson(blocks).find((block) => block.block_id === "zy_row:2026-11-27:M:52");
  assert.ok(row !== undefined);

  assert.equal(row.type, "section");
  assert.equal(row.accessory.type, "overflow");
  assert.equal(row.accessory.action_id, "zy_row");
  assert.deepEqual(row.accessory.options.map((option: Record<string, any>) => option.value), [
    "ack",
    "move|2026-12-02",
    "touch1",
    "touch7",
    "done",
  ]);
  assert.deepEqual(row.accessory.options.map((option: Record<string, any>) => option.text.text), [
    "Got it",
    "Move date…",
    "+1 day",
    "+7 days",
    "Done",
  ]);
});

test("a row with no Target date still offers a move, with nothing to fill in", () => {
  const blocks = briefingBlocks(briefingOf([rowPing("53", ["ack", "move"])]), new Map());
  const row = asJson(blocks).find((block) => block.block_id === "zy_row:2026-11-27:M:53");
  assert.ok(row !== undefined);
  assert.equal(row.accessory.options[1].value, "move|");
});

test("the row menu has at most five options: a sixth action has to deal with this first", () => {
  assert.ok(Object.keys(ROW_LABELS).length <= 5, "Slack takes five overflow options");
  assert.deepEqual(Object.keys(ROW_LABELS).sort(), ["ack", "done", "move", "touch1", "touch7"]);
});

test("a briefing fits Slack: 50 blocks, 3000-character sections, five options a menu", () => {
  const many = Array.from({ length: 45 }, (_, at) => rowPing(`r${at}`));
  const blocks = briefingBlocks(briefingOf(many), new Map());

  assert.ok(blocks.length <= 50, `${blocks.length} blocks is over Slack's 50`);
  for (const block of blocks) {
    if (block.type !== "section") continue;
    assert.ok(block.text.text.length <= 3000, `a section of ${block.text.text.length} characters`);
    if (block.accessory) assert.ok(block.accessory.options.length <= 5, "a menu of more than five options");
  }
});

test("only the first thirty rows carry a menu, and the rest are listed as text", () => {
  const rows = Array.from({ length: 32 }, (_, at) => rowPing(`r${at}`));
  const blocks = briefingBlocks(briefingOf(rows), new Map());

  const menus = blocks.filter((block) => block.type === "section" && block.accessory !== undefined);
  assert.equal(menus.length, 30);
  assert.deepEqual(
    menuKeys(blocks),
    rows.slice(0, 30).map((row) => row.key),
    "the keys the scheduler records are the rows that got a menu, and only those",
  );

  const sections = blocks.flatMap((block) => (block.type === "section" ? [block.text.text] : []));
  const heading = sections.indexOf("…2 more (no menu: message limit)");
  assert.ok(heading >= 0, "a heading says what happened to the rest");
  assert.equal(
    sections[heading + 1],
    `• ${rows[30].text}\n• ${rows[31].text}`,
    "the rows nobody can click are still there to read",
  );
  assert.ok(blocks.length <= 50, `${blocks.length} blocks is over Slack's 50`);
});

test("a large head and tail shrink the menu cap, and the message still fits in 50 blocks", () => {
  const head = ["*Morning briefing, Fri 27 Nov*", ...Array.from({ length: 10 }, () => "h".repeat(2900))];
  const tail = Array.from({ length: 10 }, () => "t".repeat(2900));
  const rows = Array.from({ length: 40 }, (_, at) => rowPing(`r${at}`));
  const blocks = briefingBlocks(briefingOf(rows, head, tail), new Map());

  const menus = blocks.filter((block) => block.type === "section" && block.accessory !== undefined);
  assert.ok(blocks.length <= 50, `${blocks.length} blocks is over Slack's 50`);
  assert.ok(menus.length < 30, `the ten head and ten tail sections leave room for ${menus.length} menus, not 30`);
  assert.deepEqual(menuKeys(blocks), rows.slice(0, menus.length).map((row) => row.key));

  // Every row is still in the message: with a menu, or as text under the heading.
  const text = blocks.flatMap((block) => (block.type === "section" ? [block.text.text] : [])).join("\n");
  for (const row of rows) assert.ok(text.includes(rowPing(row.itemId).text), `${row.itemId} is in the message`);
  assert.ok(text.includes(`…${40 - menus.length} more (no menu: message limit)`), "the heading counts what it lists");
});

test("a head or a tail over a section's limit is split at a line break, never truncated", () => {
  const line = "x".repeat(1400);
  const head = ["*Morning briefing, Fri 27 Nov*", [line, line, line, line].join("\n")];
  const blocks = briefingBlocks(briefingOf([rowPing("52")], head, []), new Map());

  const sections = blocks.flatMap((block) => (block.type === "section" ? [block.text.text] : []));
  assert.deepEqual(sections.slice(1, -1), splitLines(head[1]), "one section per chunk, in order");
  assert.equal(splitLines(head[1]).join("\n"), head[1], "nothing was dropped");
  for (const section of sections) assert.ok(section.length <= 2900, `a section of ${section.length} characters`);
});

test("a menu pick of ack marks the ping handled and edits only its row", async () => {
  const { deps, client, store, logs, blocks } = twoRows();
  await handleRowAction(deps, rowClick({ value: "ack", blocks }));

  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
  assert.equal(store.findByKey("2026-11-27:M:ITEM_2")?.ackedAt, null, "the other row is untouched");
  assert.deepEqual(logs, ["button ack on ITEM_1 by U_ZY"]);

  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0].channel, "D");
  assert.equal(client.updates[0].ts, "111.6");
  assert.deepEqual(messageRows(client.updates[0].blocks), [
    ...BRIEFING_HEAD,
    { text: "notes#ITEM_1 Work ITEM_1: *due today*\n→ acked", menu: false },
    { text: "notes#ITEM_2 Work ITEM_2: *due today*", menu: true },
    ...BRIEFING_TAIL,
  ]);
});

test("a menu pick of Done writes the Status field and closes the row", async () => {
  const { deps, client, board, blocks } = twoRows();
  await handleRowAction(deps, rowClick({ value: "done", blocks }));

  assert.deepEqual(board.singleSelects, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_STATUS", optionId: "O_DONE" }]);
  assert.deepEqual(messageRows(client.updates[0].blocks)[2], {
    text: "notes#ITEM_1 Work ITEM_1: *due today*\n→ marked Done on the board",
    menu: false,
  });
});

test("a menu pick of +1 day moves to Monday, and +7 days a week out", async () => {
  const monday = twoRows();
  await handleRowAction(monday.deps, rowClick({ value: "touch1", blocks: monday.blocks }));
  assert.deepEqual(monday.board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TOUCH", date: "2026-11-30" }]);
  assert.match(messageRows(monday.client.updates[0].blocks)[2].text, /→ next touch Mon 30 Nov$/);

  const week = twoRows();
  await handleRowAction(week.deps, rowClick({ value: "touch7", blocks: week.blocks }));
  assert.deepEqual(week.board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TOUCH", date: "2026-12-04" }]);
});

test("two picks on two rows both persist: the second edit keeps the first", async () => {
  const { deps, client, store, blocks } = twoRows();
  await handleRowAction(deps, rowClick({ value: "ack", blocks }));
  // Slack hands the second click the message as it was before the first edit.
  await handleRowAction(deps, rowClick({ value: "done", blockId: "zy_row:2026-11-27:M:ITEM_2", blocks }));

  assert.equal(client.updates.length, 2);
  assert.deepEqual(messageRows(client.updates[1].blocks), [
    ...BRIEFING_HEAD,
    { text: "notes#ITEM_1 Work ITEM_1: *due today*\n→ acked", menu: false },
    { text: "notes#ITEM_2 Work ITEM_2: *due today*\n→ marked Done on the board", menu: false },
    ...BRIEFING_TAIL,
  ]);
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
  assert.equal(store.findByKey("2026-11-27:M:ITEM_2")?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("a failed chat.update leaves the cache alone, and the next pick still finds its row", async () => {
  const { deps, client, blocks } = twoRows();
  client.failUpdate = true;
  await handleRowAction(deps, rowClick({ value: "ack", blocks }));

  assert.deepEqual(messageRows(deps.rows.blocks.get("111.6")), [
    ...BRIEFING_HEAD,
    { text: "notes#ITEM_1 Work ITEM_1: *due today*", menu: true },
    { text: "notes#ITEM_2 Work ITEM_2: *due today*", menu: true },
    ...BRIEFING_TAIL,
  ], "the edit that never landed is not in the cache");

  client.failUpdate = false;
  // Slack hands the second click the message as it was before the failed edit.
  await handleRowAction(deps, rowClick({ value: "done", blockId: "zy_row:2026-11-27:M:ITEM_2", blocks }));

  assert.equal(client.updates.length, 2);
  assert.deepEqual(messageRows(client.updates[1].blocks), [
    ...BRIEFING_HEAD,
    { text: "notes#ITEM_1 Work ITEM_1: *due today*", menu: true },
    { text: "notes#ITEM_2 Work ITEM_2: *due today*\n→ marked Done on the board", menu: false },
    ...BRIEFING_TAIL,
  ], "the second pick found its row, and the lost edit is not carried along");
});

test("a row pick with no blocks to edit says its result in the thread", async () => {
  const { deps, client, store } = harness(boardItem());
  await handleRowAction(deps, rowClick({ value: "done", blocks: null }));

  assert.deepEqual(client.updates, [], "there is no message to edit");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "111.6", "the briefing's own thread");
  assert.equal(client.posts[0].text, "→ marked Done on the board");
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, "2026-11-27T01:00:00.000Z", "the board write happened, so it is acked");
});

test("a pick on a row already handled writes nothing and says so in the thread", async () => {
  const { deps, client, store, logs, blocks } = twoRows();
  store.markAcked(ROW_KEY, "2026-11-27T02:00:00.000Z");
  await handleRowAction(deps, rowClick({ value: "done", blocks }));

  assert.deepEqual(client.updates, [], "the row is left as it is");
  assert.deepEqual(client.posts.map((post) => post.text), ["already handled"], "the same words the move submit uses");
  assert.equal(client.posts[0].thread_ts, "111.6");
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, "2026-11-27T02:00:00.000Z", "the first ack stands");
  assert.deepEqual(logs, ["row done on 2026-11-27:M:ITEM_1: already handled, this pick does nothing"]);
});

test("the blocks cache keeps the last twenty messages, and forgets the oldest", async () => {
  const { deps, store } = harness(boardItem());
  for (let at = 0; at < 21; at += 1) {
    const ping = rowPing(`K${at}`);
    const ts = `ts-${at}`;
    store.recordPing({
      key: ping.key,
      itemId: "ITEM_1",
      date: "2026-11-27",
      slot: "M",
      kind: "ping",
      sentAt: "2026-11-27T01:00:00.000Z",
      channel: "D",
      ts,
    });
    await handleRowAction(deps, rowClick({ blockId: `zy_row:${ping.key}`, ts, blocks: briefingBlocks(briefingOf([ping]), new Map()) }));
  }

  assert.equal(deps.rows.blocks.size, 20, "no more than twenty messages are kept");
  assert.equal(deps.rows.blocks.has("ts-0"), false, "the oldest message is the one forgotten");
  assert.equal(deps.rows.blocks.has("ts-20"), true, "the message just edited is kept");
  assert.equal(deps.rows.queues.size, 0, "a settled edit leaves no queue entry behind");
});

test("a menu pick whose board write fails keeps the menu and says so in the thread", async () => {
  const { deps, client, board, store, logs, blocks } = twoRows();
  board.failWrites = true;
  await handleRowAction(deps, rowClick({ value: "done", blocks }));

  assert.deepEqual(client.updates, [], "the message is left as it is");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "111.6");
  assert.equal(client.posts[0].text, "→ failed: board is down");
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, null, "nothing was written, so nothing is acked");
  assert.match(logs.join("\n"), /row done on 2026-11-27:M:ITEM_1 failed: board is down/);
});

test("a row pick from anyone but ZY does nothing, and an unknown row is logged", async () => {
  const other = twoRows();
  await handleRowAction(other.deps, rowClick({ userId: "U_OTHER", blocks: other.blocks }));
  assert.deepEqual(other.client.updates, []);
  assert.equal(other.store.findByKey(ROW_KEY)?.ackedAt, null);

  const unknown = twoRows();
  await handleRowAction(unknown.deps, rowClick({ blockId: "zy_row:2026-11-27:M:NOPE", blocks: unknown.blocks }));
  assert.deepEqual(unknown.client.updates, []);
  assert.match(unknown.logs.join("\n"), /row ack: unknown ping 2026-11-27:M:NOPE/);

  const noBlock = twoRows();
  await handleRowAction(noBlock.deps, rowClick({ blockId: "some_other_block", blocks: noBlock.blocks }));
  assert.deepEqual(noBlock.client.updates, []);
});

test("a Move date pick opens the modal on the row's own date, and its submit edits the row", async () => {
  const { deps, client, board, store, blocks } = twoRows();
  await handleRowAction(deps, rowClick({ value: `move|${TARGET}`, blocks }));

  assert.equal(client.modals.length, 1);
  assert.equal(client.modals[0].trigger_id, "TRIGGER_2");
  assert.equal(board.reads, 0, "the board is not read before views.open");
  const view = asSent(client.modals[0]);
  assert.equal(view.blocks[0].element.initial_date, TARGET);
  const meta = JSON.parse(view.private_metadata) as Record<string, unknown>;
  assert.equal(meta.row, true, "the submit edits the row, not the whole message");
  assert.equal(meta.key, ROW_KEY);
  assert.equal(meta.text, "notes#ITEM_1 Work ITEM_1: *due today*", "the row's own words, not the briefing's title");
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, null, "only the submit acks it");

  await handleMoveSubmit(deps, { userId: "U_ZY", metadata: view.private_metadata, date: "2026-12-02", reason: "the Acme workshop moved" });

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.deepEqual(messageRows(client.updates[0].blocks)[2], {
    text: "notes#ITEM_1 Work ITEM_1: *due today*\n→ Moved to Wed 2 Dec (the Acme workshop moved)",
    menu: false,
  });
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("a row move submitted after a restart leaves the row and answers in the thread", async () => {
  const { deps, client, board, store } = harness(boardItem());
  const meta = JSON.stringify({ channel: "D", ts: "111.6", key: ROW_KEY, text: "notes#52 A: *due today*", row: true });
  await handleMoveSubmit(deps, { userId: "U_ZY", metadata: meta, date: "2026-12-02", reason: "moved" });

  assert.deepEqual(board.dates, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_TARGET", date: "2026-12-02" }]);
  assert.deepEqual(client.updates, [], "there are no blocks to edit");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, "111.6");
  assert.equal(client.posts[0].text, "→ Moved to Wed 2 Dec (moved)");
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, "2026-11-27T01:00:00.000Z");
});

test("an old Done button, whose value is the bare key, still works", async () => {
  const { deps, client, board } = harness();
  await handleAction(deps, click({ actionId: "zy_done", value: KEY, blocks: OLD_MESSAGE_BLOCKS }));

  assert.deepEqual(board.singleSelects, [{ projectId: "PVT_1", itemId: "ITEM_1", fieldId: "F_STATUS", optionId: "O_DONE" }]);
  assert.match(client.updates[0].text, /→ marked Done on the board/);
});

test("a reply under the briefing is a question: a row is acked by its menu", async () => {
  const { deps, client, store } = harness();
  const ask = recordAsk();
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.5", threadTs: "111.6", text: "what's waiting on others?" });
  await ask.settled;

  assert.deepEqual(ask.calls, [{ ts: "222.5", question: "what's waiting on others?", threadTs: "111.6" }]);
  assert.deepEqual(client.posts, [], "nothing says Noted.");
  assert.equal(store.findByKey(ROW_KEY)?.ackedAt, null);
});

test("today sends the briefing's text alone: no menus, no separate ping", async () => {
  const { deps, client } = harness(boardItem({ target: "2026-11-27" }));
  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "today" });

  assert.equal(client.posts.length, 1, "one message, whatever it holds");
  assert.equal(client.posts[0].blocks, undefined);
  assert.match(client.posts[0].text, /• <https:\/\/[^>]*notes#52> A: \*due today\*/);
});

// ---- the proposal cards: their buttons, the Edit modal, and the routing -----

/** The proposal a card of the DM at 222.2 belongs to: add:<message ts>. */
const PROP_ID = "add:222.2";

/** The message the card lives on. */
const CARD_TS = "111.1";

/** An add: pipeline that only records: what it was given, and the ui it got. */
function recordAdd() {
  const calls: AddInput[] = [];
  const uis: AddUi[] = [];
  let resolve = (): void => {};
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  const dispatch: AddDispatch = async (input, ui) => {
    calls.push(input);
    uis.push(ui);
    resolve();
  };
  return { calls, uis, settled, dispatch };
}

/** The card of the fake kind: what it says depends on where the row stands. */
function cardFor(proposal: Proposal): Card {
  return {
    head: "*New board item* · not created yet",
    lines: ["*Call Dana about the renewal*", "Account: Acme · Track: Customer"],
    context: `→ proposal is ${proposal.status}`,
    buttons: proposal.status === "open" ? ["create", "edit", "cancel"] : [],
  };
}

/** A kind that records its applies: the click side of the card, without a board. */
class RecordingSpec implements ProposalSpec {
  readonly applies: string[] = [];

  card(proposal: Proposal): Card {
    return cardFor(proposal);
  }

  editFields(): EditField[] {
    return [{ kind: "text", name: "title", label: "Title", value: "Call Dana", required: true, maxLength: 120 }];
  }

  edited(_proposal: Proposal, values: Record<string, string | null>): string {
    return JSON.stringify(values);
  }

  async apply(proposal: Proposal, _save: (progress: string) => void): Promise<void> {
    this.applies.push(proposal.id);
  }
}

/** The handler's deps plus a proposal store holding one open card at CARD_TS. */
function proposalHarness(options: { status?: ProposalStatus; rev?: number } = {}) {
  const h = harness();
  const store = new FakeProposals();
  store.recordProposal({ id: PROP_ID, kind: "add", source: "call Dana about the renewal", createdAt: "2026-11-27T01:00:00.000Z" });
  const row = store.findProposal(PROP_ID);
  if (row === null) throw new Error("the harness stored no proposal");
  row.status = options.status ?? "open";
  row.rev = options.rev ?? 0;
  row.channel = "D";
  row.messageTs = CARD_TS;
  const spec = new RecordingSpec();
  const proposals: ProposalDeps = { store, specs: { add: spec }, userId: "U_ZY", now: h.deps.now, log: h.deps.log };
  h.deps.proposals = proposals;
  return { ...h, store, spec, proposals, row };
}

function cardClick(overrides: Partial<ProposalActionClick> = {}): ProposalActionClick {
  return {
    actionId: "zy_prop_create",
    value: proposalValue(PROP_ID, 0),
    userId: "U_ZY",
    channel: "D",
    ts: CARD_TS,
    triggerId: "TRIGGER_3",
    ...overrides,
  };
}

function cardSubmit(overrides: Partial<ProposalEditSubmit> = {}): ProposalEditSubmit {
  return {
    userId: "U_ZY",
    metadata: JSON.stringify({ id: PROP_ID, rev: 0 }),
    values: { title: "Call Dana about the renewal on 8 Dec" },
    ...overrides,
  };
}

/** The card's blocks as Slack receives them: what the routing tests read. */
const sentBlocks = (blocks: Block[] | undefined): Array<Record<string, any>> => JSON.parse(JSON.stringify(blocks ?? [])) as Array<Record<string, any>>;

const OPEN_CARD: Card = {
  head: "*New board item* · not created yet",
  lines: ["*Call Dana about the renewal*", "Account: Acme · Track: Customer"],
  context: "Create opens an issue in `demo/notes`.",
  buttons: ["create", "edit", "cancel"],
};

const NINE_FIELDS: EditField[] = [
  { kind: "text", name: "title", label: "Title", value: "Call Dana about the renewal", required: true, maxLength: 120 },
  {
    kind: "select",
    name: "parent",
    label: "Parent engagement",
    value: "ENG_1",
    options: [
      { label: "ENG_1 Acme renewal", value: "ENG_1" },
      { label: "ENG_2 Globex pilot", value: "ENG_2" },
    ],
  },
  { kind: "select", name: "account", label: "Account", value: "Globex", options: [{ label: "Acme", value: "Acme" }] },
  { kind: "select", name: "track", label: "Track", value: null, options: [{ label: "Customer", value: "Customer" }] },
  { kind: "select", name: "workType", label: "Work type", value: "Demo", options: [{ label: "Demo", value: "Demo" }] },
  { kind: "select", name: "status", label: "Status", value: null, options: [{ label: "Next", value: "Next" }] },
  { kind: "date", name: "targetDate", label: "Target date", value: "2026-12-08" },
  { kind: "date", name: "nextTouch", label: "Next touch", value: null },
  { kind: "text", name: "nextAction", label: "Next action", value: null, required: false, maxLength: 300 },
];

test("only a message that starts with add: is a sentence to draft", () => {
  assert.equal(addText("add: call Dana"), "call Dana");
  assert.equal(addText("ADD:call Dana"), "call Dana");
  assert.equal(addText("  add :  call Dana  "), "call Dana");
  assert.equal(addText("add: call Dana\nand Globex"), "call Dana\nand Globex", "a sentence may run on");
  assert.equal(addText("add:"), null, "a bare add: is not an add");
  assert.equal(addText("add:   "), null);
  assert.equal(addText("address: 12 Demo Street"), null);
  assert.equal(addText("note: ten nodes"), null);
  assert.equal(addText("please add: call Dana"), null, "the prefix is the first thing in the message");
});

test("an add: DM reaches the pipeline in the background, and is never a question", async () => {
  const { deps, client } = harness();
  const add = recordAdd();
  const ask = recordAsk();
  deps.add = add.dispatch;
  deps.ask = ask.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "  Add:  call Dana about the renewal on 8 Dec  " });
  await add.settled;

  assert.deepEqual(add.calls, [{ ts: "222.2", text: "call Dana about the renewal on 8 Dec", hint: null }], "the sentence, without the prefix");
  assert.deepEqual(ask.calls, [], "an add: is a command, not a question");
  assert.deepEqual(client.posts, [], "the handler returns at once: the pipeline does the talking");
});

test("an add: in an evening ping's thread drafts under that item, and acks nothing", async () => {
  const { deps, store } = harness(boardItem({ title: "Acme VPC sizing" }));
  const add = recordAdd();
  deps.add = add.dispatch;

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.4", threadTs: "111.1", text: "add: chase the Acme quote" });
  await add.settled;

  assert.deepEqual(add.calls, [{ ts: "222.4", text: "chase the Acme quote", hint: { ref: "notes#52", title: "Acme VPC sizing" } }]);
  assert.equal(store.findByKey(KEY)?.ackedAt, null, "an add: says so in its own message, so the ping stays open");
});

test("without add:, an add: DM is a question, and the hint names add: only when it is on", async () => {
  const asking = harness();
  const ask = recordAsk();
  asking.deps.ask = ask.dispatch;
  asking.deps.add = null;

  await handleMessage(asking.deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "add: call Dana" });
  await ask.settled;

  assert.deepEqual(ask.calls, [{ ts: "222.2", question: "add: call Dana", threadTs: "222.2" }], "with no pipeline it is a plain DM");

  const hinted = harness();
  hinted.deps.add = null;
  await handleMessage(hinted.deps, { userId: "U_ZY", channel: "D", ts: "222.3", threadTs: null, text: "add: call Dana" });
  assert.deepEqual(hinted.client.posts.map((post) => post.text), ["I didn't catch that. Type `today` or `help`."]);

  const withAdd = harness();
  withAdd.deps.add = async () => {};
  await handleMessage(withAdd.deps, { userId: "U_ZY", channel: "D", ts: "222.5", threadTs: null, text: "ping" });
  assert.deepEqual(withAdd.client.posts.map((post) => post.text), ["I didn't catch that. Type `today`, `add: …`, or `help`."]);

  const withBoth = harness();
  withBoth.deps.add = async () => {};
  withBoth.deps.scribe = async () => {};
  await handleMessage(withBoth.deps, { userId: "U_ZY", channel: "D", ts: "222.6", threadTs: null, text: "ping" });
  assert.deepEqual(withBoth.client.posts.map((post) => post.text), ["I didn't catch that. Type `today`, `add: …`, `note: …`, or `help`."]);
});

test("a card is its words and its buttons, and every value carries the rev", () => {
  const blocks = cardBlocks(PROP_ID, 0, OPEN_CARD);

  assert.equal(blocks.length, 3, "a section, the context, and the buttons");
  const sent = sentBlocks(blocks);
  assert.deepEqual(sent[0], {
    type: "section",
    text: { type: "mrkdwn", text: "*New board item* · not created yet\n*Call Dana about the renewal*\nAccount: Acme · Track: Customer" },
  });
  assert.equal(sent[1].type, "context");
  assert.equal(sent[1].elements[0].text, "Create opens an issue in `demo/notes`.");
  assert.equal(sent[2].block_id, `zy_prop:${PROP_ID}`);
  const cardActions = sent[2].elements as Array<Record<string, any>>;
  assert.deepEqual(cardActions.map((element) => element.action_id), ["zy_prop_create", "zy_prop_edit", "zy_prop_cancel"]);
  for (const element of cardActions) assert.equal(element.value, "add:222.2|0", "the id and the rev, in every button");
  assert.deepEqual(cardActions.map((element) => element.text.text), ["Create", "Edit", "Cancel"]);
  assert.equal(cardActions[0].style, "primary", "Create is the approval");
  assert.equal(cardActions[1].style, undefined);
  assert.equal(cardActions[2].style, undefined);

  const retry = sentBlocks(cardBlocks(PROP_ID, 2, { ...OPEN_CARD, buttons: ["retry", "cancel"] }))[2].elements as Array<Record<string, any>>;
  assert.deepEqual(retry.map((element) => element.text.text), ["Retry", "Cancel"]);
  assert.equal(retry[0].style, "primary", "a retry is the approval of a card that failed halfway");
  assert.equal(retry[0].value, "add:222.2|2");

  const bare = cardBlocks(PROP_ID, 0, { ...OPEN_CARD, buttons: [] });
  assert.equal(bare.length, 2, "a card that is over has nothing to click");
  assert.deepEqual(bare.map((block) => block.type), ["section", "context"]);

  assert.equal(
    cardText(OPEN_CARD),
    "*New board item* · not created yet\n*Call Dana about the renewal*\nAccount: Acme · Track: Customer\nCreate opens an issue in `demo/notes`.",
    "the fallback text is the card's own words",
  );

  const long = cardBlocks(PROP_ID, 0, { ...OPEN_CARD, lines: ["x".repeat(4000)] })[0];
  assert.ok(long.type === "section" && long.text.text.length <= 2900, "a long card is cut to a section's limit, like every section here");
});

test("the Edit modal carries the id and the rev alone, and one input per field in order", () => {
  const view = editView(PROP_ID, 2, NINE_FIELDS);
  const sent = JSON.parse(JSON.stringify(view)) as Record<string, any>;

  assert.equal(view.callback_id, "zy_prop_edit_view");
  assert.deepEqual(JSON.parse(view.private_metadata), { id: PROP_ID, rev: 2 }, "ids only: the values come from SQLite");
  assert.equal(view.title.text, "Edit the new item");
  assert.ok(view.title.text.length <= 24, "Slack cuts a modal title at 24 characters");
  assert.equal(view.submit.text, "Save");
  assert.equal(view.close.text, "Cancel");
  assert.deepEqual(sent.blocks.map((block: Record<string, any>) => block.block_id), NINE_FIELDS.map((field) => field.name), "nine inputs, in the card's order");
  for (const block of sent.blocks) assert.equal(block.element.action_id, "v", "one action_id everywhere: the block is what names the field");

  assert.equal(sent.blocks[0].element.type, "plain_text_input");
  assert.equal(sent.blocks[0].element.max_length, 120);
  assert.equal(sent.blocks[0].element.initial_value, "Call Dana about the renewal");
  assert.equal(sent.blocks[0].optional, undefined, "a title is required: Slack refuses the submit without it");

  assert.equal(sent.blocks[8].element.type, "plain_text_input");
  assert.equal(sent.blocks[8].optional, true, "a next action may be left empty");
  assert.equal(sent.blocks[8].element.initial_value, undefined, "nothing to fill in");

  assert.equal(sent.blocks[6].element.type, "datepicker");
  assert.equal(sent.blocks[6].element.initial_date, "2026-12-08");
  assert.equal(sent.blocks[6].optional, true, "a date may be cleared");
  assert.equal(sent.blocks[7].element.initial_date, undefined);

  assert.equal(sent.blocks[1].element.type, "static_select");
  assert.equal(sent.blocks[1].optional, true);
  assert.deepEqual(sent.blocks[1].element.options[0], { text: { type: "plain_text", text: "ENG_1 Acme renewal" }, value: "ENG_1" });
  assert.deepEqual(sent.blocks[1].element.initial_option, sent.blocks[1].element.options[0], "the option that is there, as it is there");
  assert.equal(sent.blocks[2].element.initial_option, undefined, "a value that is not an option opens on nothing: Slack refuses the view otherwise");
  assert.equal(sent.blocks[3].element.initial_option, undefined, "a null value has nothing to open on");
  assert.ok(view.blocks.length <= 100, "Slack takes 100 blocks in a view");
});

test("the modal's initial_option is the very object from its own list", () => {
  const field = NINE_FIELDS[1];
  const block = editView(PROP_ID, 0, [field]).blocks[0];
  if (field.kind !== "select" || block.element.type !== "static_select") throw new Error("the fixture is not a select");

  assert.equal(block.element.initial_option, block.element.options[0], "Slack checks identity, not equality");
});

test("a modal's answers are read by block_id, and an untouched input is null", () => {
  assert.deepEqual(
    editValues({
      title: { v: { value: "Call Dana" } },
      parent: { v: { selected_option: { value: "ENG_1" } } },
      targetDate: { v: { selected_date: "2026-12-08" } },
      nextAction: { v: { value: null } },
      nextTouch: { v: { selected_date: null } },
    }),
    { title: "Call Dana", parent: "ENG_1", targetDate: "2026-12-08", nextAction: null, nextTouch: null },
  );
});

test("a Create click writes the card's item, and the card is redrawn done", async () => {
  const { deps, client, store, spec } = proposalHarness();

  await handleProposalAction(deps, cardClick());

  assert.deepEqual(spec.applies, [PROP_ID], "the click is the approval: the kind's apply ran");
  assert.equal(store.findProposal(PROP_ID)?.status, "done");
  assert.equal(client.updates.length, 2, "the interim card, then the outcome");
  assert.match(client.updates[0].text, /→ proposal is applying/);
  assert.equal(client.updates[0].channel, "D");
  assert.equal(client.updates[0].ts, CARD_TS, "the card's own message");
  assert.match(client.updates[1].text, /→ proposal is done/);
  assert.deepEqual(client.updates[1].blocks?.map((block) => block.type), ["section", "context"], "a done card has nothing to click");
});

test("a card a restart interrupted is redrawn where the row says it is, as the row now reads", async () => {
  const { deps, client, row, spec } = proposalHarness();
  // What the store's constructor left: the apply reopened, with its reason on it.
  row.status = "open";
  row.error = "interrupted by a restart";

  await redrawProposalCard(deps, PROP_ID);

  assert.deepEqual(spec.applies, [], "a redraw writes nothing at all");
  assert.deepEqual(
    client.updates.map((update) => [update.channel, update.ts]),
    [["D", CARD_TS]],
    "the row's own channel and message",
  );
  assert.match(client.updates[0].text, /→ proposal is open/);
  assert.deepEqual(client.updates[0].blocks?.map((block) => block.type), ["section", "context", "actions"], "its buttons came back");
});

test("a row with no card to redraw, or a kind this bot does not apply, is one log line", async () => {
  const { deps, client, row, logs } = proposalHarness();
  row.messageTs = null;

  await redrawProposalCard(deps, PROP_ID);

  row.messageTs = CARD_TS;
  row.kind = "calendar";
  await redrawProposalCard(deps, PROP_ID);

  assert.deepEqual(client.updates, [], "nothing was drawn");
  assert.deepEqual(logs, [
    `proposal ${PROP_ID}: the row names no card, there is nothing to redraw`,
    `proposal ${PROP_ID}: kind calendar is not one this bot applies, there is no card to redraw`,
  ]);
});

test("a redraw Slack refuses is a log line, never a throw", async () => {
  const { deps, client, logs } = proposalHarness();
  client.failUpdate = true;

  await redrawProposalCard(deps, PROP_ID);

  assert.deepEqual(logs, [`proposal ${PROP_ID}: the redraw failed: message_not_found`]);
});

test("a Cancel click writes nothing, and says the card was cancelled", async () => {
  const { deps, client, store, spec } = proposalHarness();

  await handleProposalAction(deps, cardClick({ actionId: "zy_prop_cancel" }));

  assert.deepEqual(spec.applies, [], "a cancel is no approval");
  assert.equal(store.findProposal(PROP_ID)?.status, "cancelled");
  assert.equal(client.updates.length, 1);
  assert.match(client.updates[0].text, /→ proposal is cancelled/);
});

test("an Edit click opens the modal on the row's fields, and writes nothing", async () => {
  const { deps, client, store } = proposalHarness();

  await handleProposalAction(deps, cardClick({ actionId: "zy_prop_edit" }));

  assert.equal(client.modals.length, 1);
  assert.equal(client.modals[0].trigger_id, "TRIGGER_3");
  const view = JSON.parse(JSON.stringify(client.modals[0].view)) as Record<string, any>;
  assert.equal(view.callback_id, "zy_prop_edit_view");
  assert.deepEqual(JSON.parse(view.private_metadata), { id: PROP_ID, rev: 0 });
  assert.deepEqual(view.blocks.map((block: Record<string, any>) => block.block_id), ["title"]);
  assert.deepEqual(client.updates, [], "an edit is not an outcome to draw");
  assert.equal(store.findProposal(PROP_ID)?.status, "open");
});

test("a click with no trigger_id opens no modal, and says why", async () => {
  const { deps, client, logs } = proposalHarness();

  await handleProposalAction(deps, cardClick({ actionId: "zy_prop_edit", triggerId: null }));

  assert.deepEqual(client.modals, []);
  assert.match(logs.join("\n"), /carries no trigger_id/);
});

test("a click whose value names no card is logged and writes nothing", async () => {
  const { deps, client, store, spec, logs } = proposalHarness();
  const before = { ...store.findProposal(PROP_ID) };

  await handleProposalAction(deps, cardClick({ value: "not a card" }));
  await handleProposalAction(deps, cardClick({ actionId: "zy_prop_move" }));
  await handleProposalAction(deps, cardClick({ ts: null }));

  assert.deepEqual(spec.applies, []);
  assert.deepEqual(client.updates, []);
  assert.deepEqual(store.findProposal(PROP_ID), before);
  assert.equal(logs.filter((line) => /names no card/.test(line)).length, 3);
});

test("a click with no proposals set up is a log line, and nothing else", async () => {
  const { deps, client, store, logs } = proposalHarness();
  const before = { ...store.findProposal(PROP_ID) };
  deps.proposals = null;

  await handleProposalAction(deps, cardClick());
  await handleProposalEdit(deps, cardSubmit());

  assert.deepEqual(client.updates, []);
  assert.deepEqual(client.modals, []);
  assert.deepEqual(store.findProposal(PROP_ID), before);
  assert.equal(logs.filter((line) => /no proposals are set up/.test(line)).length, 2);
});

test("an Edit submit stores the payload at the next rev, and redraws the card there", async () => {
  const { deps, client, store } = proposalHarness();

  await handleProposalEdit(deps, cardSubmit());

  const row = store.findProposal(PROP_ID);
  assert.equal(row?.payload, JSON.stringify({ title: "Call Dana about the renewal on 8 Dec" }));
  assert.equal(row?.rev, 1, "an edit is a new revision of the same row");
  assert.equal(client.updates.length, 1);
  assert.match(client.updates[0].text, /→ proposal is open/);
  const actions = sentBlocks(client.updates[0].blocks).at(-1);
  assert.equal(actions?.elements[0].value, "add:222.2|1", "the card is clickable at the rev it was stored at");
});

test("an Edit submit redraws the card where the row says it is, not where the modal does", async () => {
  const { deps, client, row } = proposalHarness();
  row.channel = "D";
  row.messageTs = "444.4";

  await handleProposalEdit(deps, cardSubmit());

  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0].channel, "D");
  assert.equal(client.updates[0].ts, "444.4", "the row's own message: a modal carries no channel");
});

test("an Edit submit whose metadata cannot be read is logged and writes nothing", async () => {
  const { deps, client, store, logs } = proposalHarness();

  await handleProposalEdit(deps, cardSubmit({ metadata: "not json" }));
  await handleProposalEdit(deps, cardSubmit({ metadata: JSON.stringify({ id: PROP_ID, rev: "two" }) }));

  assert.equal(store.findProposal(PROP_ID)?.rev, 0);
  assert.equal(store.findProposal(PROP_ID)?.payload, null);
  assert.deepEqual(client.updates, []);
  assert.equal(logs.filter((line) => /private_metadata holds no proposal/.test(line)).length, 2);
});

test("an Edit submit twice on the same modal stores one payload: the second rev is too late", async () => {
  const { deps, client, store } = proposalHarness();

  await handleProposalEdit(deps, cardSubmit());
  await handleProposalEdit(deps, cardSubmit({ values: { title: "a second thought" } }));

  assert.equal(store.findProposal(PROP_ID)?.rev, 1);
  assert.equal(store.findProposal(PROP_ID)?.payload, JSON.stringify({ title: "Call Dana about the renewal on 8 Dec" }));
  assert.equal(client.updates.length, 1, "the redraw of the one edit that landed");
  assert.deepEqual(client.posts.map((post) => post.text), ["this card has moved on: nothing was changed"]);
  assert.equal(client.posts[0].thread_ts, CARD_TS, "the line lands under the card");
});

test("an edit whose redraw Slack refuses is reposted in the card's thread, and the row follows it", async () => {
  const { deps, client, store } = proposalHarness();
  client.failUpdate = true;

  await handleProposalEdit(deps, cardSubmit());

  assert.equal(store.findProposal(PROP_ID)?.rev, 1, "the edit is stored whatever Slack does");
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].thread_ts, CARD_TS, "the fresh card is a reply under the old one");
  assert.match(client.posts[0].text ?? "", /→ proposal is open/);
  assert.equal(store.findProposal(PROP_ID)?.messageTs, "ts-1", "and it is the message later clicks and edits find");
  assert.equal(store.findProposal(PROP_ID)?.channel, "D");
});

test("a DM's add: draws its card on the drafting reply it posted, at the message's own id", async () => {
  const { deps, client } = harness();
  const calls: AddInput[] = [];
  let drawn = (): void => {};
  const ready = new Promise<void>((resolve) => {
    drawn = resolve;
  });
  deps.add = async (input, ui) => {
    calls.push(input);
    const at = await ui.reply("✍️ drafting…");
    await ui.card(at.channel, at.ts, OPEN_CARD, 0);
    drawn();
  };

  await handleMessage(deps, { userId: "U_ZY", channel: "D", ts: "222.2", threadTs: null, text: "add: call Dana" });
  await ready;

  assert.deepEqual(calls, [{ ts: "222.2", text: "call Dana", hint: null }]);
  assert.deepEqual(client.posts[0], { channel: "D", text: "✍️ drafting…", thread_ts: "222.2" }, "the ack is a reply in the DM's thread");
  assert.equal(client.updates.length, 1);
  assert.equal(client.updates[0].ts, "ts-1", "the ack is the message the card replaces");
  assert.equal(client.updates[0].text, cardText(OPEN_CARD));
  assert.equal(sentBlocks(client.updates[0].blocks).at(-1)?.elements[0].value, "add:222.2|0", "the card's id is the message it was drafted from");
});
