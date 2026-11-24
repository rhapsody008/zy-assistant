// The `add:` pipeline and its Apply, end to end: a scripted model, a fake board,
// the fake proposal store and the real proposal machinery, so a click here goes
// through the path Slack drives. No network, no Slack, no GitHub, no timers.
// Synthetic names only: "Acme", "Globex", "Dana", "demo".

import assert from "node:assert/strict";
import { test } from "node:test";
import { readContext, readPayload, readProgress } from "../src/add.ts";
import { addHandler, addSpec, proposalId, type AddDeps, type AddInput, type AddUi } from "../src/add-handler.ts";
import type { Board, BoardField } from "../src/github.ts";
import {
  proposalClick,
  type Card,
  type EditField,
  type ProposalButton,
  type ProposalClick,
  type ProposalDeps,
  type ProposalUi,
} from "../src/proposals.ts";
import type { Item } from "../src/rules.ts";
import type { Proposal } from "../src/store.ts";
import { FakeBoard, FakeLlm, FakeProposals, Gate } from "./fakes.ts";

/** Wed 2026-11-25, 09:00 in Singapore. */
const NOW = new Date("2026-11-25T01:00:00Z");
const TS = "1700000000.000100";
const ID = `add:${TS}`;
const USER = "U_ZY"; // the only person whose clicks count
const SENTENCE = "call Dana about the renewal on 8 Dec";
const PARENT = "demo#41";
const ACK = "✍️ drafting…";

const json = (value: unknown): string => JSON.stringify(value);
const url = (n: number): string => `https://github.com/demo/notes/issues/${n}`;

/** The engagement a new item is filed under: one live issue, on the board. */
const engagement = (overrides: Partial<Item> = {}): Item => ({
  id: "ITEM_41",
  ref: PARENT,
  title: "Acme · NKP renewal",
  url: url(41),
  status: null,
  target: null,
  nextTouch: null,
  nextAction: null,
  waitingOn: null,
  type: null,
  stage: null,
  track: "Customer",
  account: "Acme",
  cadence: null,
  parentUrl: null,
  contentId: "I_41",
  updatedAt: "2026-11-20T00:00:00.000Z",
  ...overrides,
});

/** The board with every field a draft may set, and one engagement to file under. */
function acmeBoard(items: Item[] = [engagement()]): Board {
  return {
    projectId: "PVT_1",
    title: "Board",
    fields: new Map<string, BoardField>([
      [
        "Status",
        { id: "F_STATUS", options: new Map([["Inbox", "O_INBOX"], ["Next", "O_NEXT"], ["In progress", "O_PROGRESS"], ["Waiting", "O_WAITING"], ["Done", "O_DONE"]]) },
      ],
      ["Track", { id: "F_TRACK", options: new Map([["Customer", "O_CUSTOMER"], ["Build", "O_BUILD"]]) }],
      ["Account", { id: "F_ACCOUNT", options: new Map([["Acme", "O_ACME"], ["Globex", "O_GLOBEX"]]) }],
      ["Work type", { id: "F_WORKTYPE", options: new Map([["POC", "O_POC"], ["Workshop", "O_WORKSHOP"]]) }],
      ["Target date", { id: "F_TARGET" }],
      ["Next touch", { id: "F_TOUCH" }],
      ["Next action", { id: "F_ACTION" }],
    ]),
    items,
  };
}

/** What the model answers: one item under the engagement, every field filled. */
const RAW = {
  title: "Call Dana about the renewal",
  parent: PARENT,
  account: "Acme",
  track: "Customer",
  workType: "POC",
  status: "Next",
  targetDate: "2026-12-08",
  nextTouch: "2026-11-30",
  nextAction: "Ask Dana for the renewal date",
};

/** The Slack side of the pipeline: the ack, the edits of it, and the cards drawn on it. */
class FakeAddUi implements AddUi {
  readonly replies: string[] = [];
  readonly edits: Array<{ channel: string; ts: string; text: string }> = [];
  readonly cards: Array<{ channel: string; ts: string; card: Card; rev: number }> = [];

  async reply(text: string): Promise<{ channel: string; ts: string }> {
    this.replies.push(text);
    return { channel: "DM", ts: `ack-${this.replies.length}` };
  }

  async edit(channel: string, ts: string, text: string): Promise<void> {
    this.edits.push({ channel, ts, text });
  }

  async card(channel: string, ts: string, card: Card, rev: number): Promise<void> {
    this.cards.push({ channel, ts, card, rev });
  }
}

/** The proposal machinery's Slack: the cards it draws, and the lines it says in their thread. */
class RecordingUi implements ProposalUi {
  readonly redraws: Array<{ card: Card; rev: number }> = [];
  readonly reposts: Array<{ card: Card; rev: number }> = [];
  readonly replies: string[] = [];
  readonly modals: Array<{ id: string; rev: number; fields: EditField[] }> = [];

  async redraw(card: Card, rev: number): Promise<void> {
    this.redraws.push({ card, rev });
  }

  async repost(card: Card, rev: number): Promise<void> {
    this.reposts.push({ card, rev });
  }

  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }

  async openEdit(id: string, rev: number, fields: EditField[]): Promise<void> {
    this.modals.push({ id, rev, fields });
  }
}

/** The board item the model's draft becomes, as the fake board made it. */
const ISSUE = { id: "I_900", number: 900, url: "https://github.com/demo/notes/issues/900" };
const LINK = `<${ISSUE.url}|notes#900>`;

/** The pipeline as the bot wires it, and the fakes on the other end of it. */
function harness(options: { replies?: string[] } = {}) {
  const llm = new FakeLlm();
  llm.replies.push(...(options.replies ?? [json(RAW)]));
  const board = new FakeBoard();
  board.board = acmeBoard();
  const proposals = new FakeProposals();
  const logs: string[] = [];
  const clock = { now: NOW };
  const deps: AddDeps = {
    llm,
    board,
    proposals,
    repo: "demo/notes",
    owner: "zy",
    number: 1,
    now: () => clock.now,
    log: (line) => logs.push(line),
    timeoutMs: 1000,
    maxTokens: 4096,
  };
  return { deps, llm, board, proposals, logs, clock, ui: new FakeAddUi() };
}

type Harness = ReturnType<typeof harness>;

function rowOf(store: FakeProposals): Proposal {
  const row = store.findProposal(ID);
  if (row === null) throw new Error("the proposal is not in the store");
  return row;
}

/** One sentence through the pipeline: the row it leaves, ready for a click. */
async function drafted(setup: Harness, input: Partial<AddInput> = {}): Promise<Proposal> {
  await addHandler(setup.deps, { ts: TS, text: SENTENCE, hint: null, ...input }, setup.ui);
  return rowOf(setup.proposals);
}

/** The proposal machinery over the same fakes, with the kind this file is about. */
function machinery(deps: AddDeps, ui: ProposalUi): ProposalDeps {
  return { store: deps.proposals, specs: { add: addSpec(deps) }, userId: USER, now: deps.now, log: deps.log };
}

const click = (ui: ProposalUi, action: ProposalButton = "create", rev = 0): ProposalClick => ({
  action,
  id: ID,
  rev,
  userId: USER,
  triggerId: "trig-1",
  ui,
});

// ---- The pipeline -----------------------------------------------------------

test("a sentence is drafted into the card its ack turns into", async () => {
  const setup = harness();

  const row = await drafted(setup, { hint: { ref: PARENT, title: "Acme · NKP renewal" } });

  assert.deepEqual(setup.ui.replies, [ACK], "one ack, and it is the message the card lands on");
  assert.deepEqual(setup.ui.edits, [], "the ack became the card, so nothing was edited to a line");
  assert.equal(setup.llm.requests.length, 1);
  assert.match(setup.llm.requests[0].system, /^Today is 2026-11-25 \(Asia\/Singapore\)\.$/m);
  assert.match(setup.llm.requests[0].system, /^demo#41 \| Acme · NKP renewal \| Acme \| Customer$/m);
  assert.deepEqual(
    setup.ui.cards.map((drawn) => [drawn.channel, drawn.ts, drawn.rev]),
    [["DM", "ack-1", 0]],
    "the card is drawn on the ack's own ts",
  );
  assert.deepEqual(setup.ui.cards[0].card.lines[0], "*Call Dana about the renewal*");
  assert.deepEqual(setup.ui.cards[0].card.buttons, ["create", "edit", "cancel"]);

  assert.equal(row.status, "open");
  assert.equal(row.channel, "DM");
  assert.equal(row.messageTs, "ack-1");
  assert.equal(row.error, null);
  assert.equal(readPayload(row.payload)?.draft.title, "Call Dana about the renewal");
  assert.deepEqual(
    readContext(row.context)?.engagements.map((one) => [one.ref, one.account, one.track]),
    [[PARENT, "Acme", "Customer"]],
  );
  assert.deepEqual(setup.logs, [`add ${TS}: drafted in 0 ms (parent ${PARENT})`], "ids only, and the parent by its ref");
});

test("a redelivered sentence replies, calls the model and draws once", async () => {
  const setup = harness();

  await drafted(setup);
  await addHandler(setup.deps, { ts: TS, text: SENTENCE, hint: null }, setup.ui);

  assert.equal(setup.ui.replies.length, 1, "the redelivery is never acked");
  assert.equal(setup.llm.requests.length, 1, "and never sends the model anywhere");
  assert.equal(setup.ui.cards.length, 1);
  assert.equal(setup.proposals.rows.size, 1, "one row, one card");
  assert.deepEqual(setup.logs.at(-1), `add ${TS}: already taken, ignoring the redelivery`);
});

test("a hint says what the sentence was typed under, and an absent one says nothing", async () => {
  const hinted = harness();
  await drafted(hinted, { hint: { ref: PARENT, title: "Acme · NKP renewal" } });
  assert.equal(
    hinted.llm.requests[0].user,
    'Sentence from Slack:\n\ncall Dana about the renewal on 8 Dec\n\nIt was typed under demo#41 "Acme · NKP renewal".',
  );

  const plain = harness();
  await drafted(plain);
  assert.equal(plain.llm.requests[0].user, `Sentence from Slack:\n\n${SENTENCE}`);
});

test("a model that cannot answer twice still drafts the sentence", async () => {
  const setup = harness({ replies: ["not json", "still not json"] });

  const row = await drafted(setup);

  assert.equal(setup.llm.requests.length, 2, "the attempt, and the one retry that hands the reason back");
  assert.deepEqual(setup.logs, [`add ${TS}: the model failed, the draft is the sentence`, `add ${TS}: drafted in 0 ms (parent none)`]);
  const payload = readPayload(row.payload);
  assert.equal(payload?.modelError, "the reply holds no JSON object");
  assert.equal(payload?.draft.title, SENTENCE, "the title is the sentence as typed");
  assert.equal(row.status, "open");
  assert.equal(setup.ui.cards.length, 1);
  assert.match(setup.ui.cards[0].card.context, /The model didn't answer/);
});

test("a board that cannot be read is said in the ack, and ends the row instead of waiting for a restart", async () => {
  const setup = harness();
  setup.board.failAt = "fetchBoard";

  await addHandler(setup.deps, { ts: TS, text: SENTENCE, hint: null }, setup.ui);

  assert.deepEqual(setup.ui.replies, [ACK]);
  assert.deepEqual(setup.ui.edits, [{ channel: "DM", ts: "ack-1", text: "⚠️ could not read the board: fetchBoard failed" }]);
  assert.deepEqual(setup.ui.cards, [], "there is no draft to draw");
  assert.equal(setup.llm.requests.length, 0, "no board, no prompt");
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "cancelled", "nothing was drafted, and a redraw must say why");
  assert.equal(row.error, "fetchBoard failed");
  assert.equal(row.payload, null);
  assert.equal(row.context, null);
  assert.deepEqual(setup.logs, [`add ${TS}: the board read failed: fetchBoard failed`]);
});

// ---- Apply ------------------------------------------------------------------

test("Create writes the issue, the board item, its fields and the link, in that order", async () => {
  const setup = harness();
  await drafted(setup);
  // The retry day is not the day ZY typed it: the issue says when it came from Slack.
  setup.clock.now = new Date("2026-11-28T01:00:00Z");
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls, [
    "fetchBoard", // the draft
    "fetchBoard", // the click reads the board again, always
    "createIssue demo/notes|Call Dana about the renewal",
    "addToProject PVT_1|I_900",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setSingleSelect ITEM_900|Work type|POC",
    "setDate ITEM_900|Target date|2026-12-08",
    "setDate ITEM_900|Next touch|2026-11-30",
    "setText ITEM_900|Next action|Ask Dana for the renewal date",
    "addSubIssue I_41|I_900",
  ]);
  assert.match(setup.board.bodies[0], /on 2026-11-25\./, "the day it was typed, not the day of the click");
  assert.match(setup.board.bodies[0], /call Dana about the renewal on 8 Dec/, "the sentence is quoted as typed");

  const row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.equal(row.error, null);
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900", fields: true, linked: true });
  assert.deepEqual(ui.redraws.map((drawn) => drawn.card.context), [
    "→ creating…",
    `→ created ${LINK}: on the board, under ${PARENT}.`,
  ]);
  assert.deepEqual(setup.logs.at(-1), `add ${TS}: created demo/notes#900 as ITEM_900, under ITEM_41`);
});

test("an add: create runs one pinned order of writes, each saved before the next", async () => {
  const setup = harness();
  await drafted(setup);
  // The board's own call log and the progress saves share one trace: the order
  // between them is the thing this test is about.
  const trace = setup.board.calls;
  const update = setup.proposals.updateProposal.bind(setup.proposals);
  setup.proposals.updateProposal = (id, patch) => {
    if (typeof patch.progress === "string") trace.push(`save ${Object.keys(JSON.parse(patch.progress) as object).join("+")}`);
    update(id, patch);
  };
  const before = trace.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(trace.slice(before), [
    "fetchBoard",
    "save issuePending", // the marker, before the POST that may land without an answer
    "createIssue demo/notes|Call Dana about the renewal",
    "save issue",
    "addToProject PVT_1|I_900",
    "save issue+itemId",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setSingleSelect ITEM_900|Work type|POC",
    "setDate ITEM_900|Target date|2026-12-08",
    "setDate ITEM_900|Next touch|2026-11-30",
    "setText ITEM_900|Next action|Ask Dana for the renewal date",
    "save issue+itemId+fields",
    "addSubIssue I_41|I_900",
    "save issue+itemId+fields+linked",
  ]);
});

test("a draft that waits on someone writes Waiting on last, through setText", async () => {
  const setup = harness();
  const row = await drafted(setup);
  const board = acmeBoard();
  board.fields.set("Waiting on", { id: "F_WAITING" });
  setup.board.board = board;
  const payload = readPayload(row.payload);
  assert.ok(payload !== null);
  // The `add:` prompt never asks for one: a note item's draft is what carries it.
  row.payload = json({ ...payload, draft: { ...payload.draft, waitingOn: "Dana's answer" } });
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(
    setup.board.calls.slice(before).filter((call) => call.startsWith("set")),
    [
      "setSingleSelect ITEM_900|Status|Next",
      "setSingleSelect ITEM_900|Track|Customer",
      "setSingleSelect ITEM_900|Account|Acme",
      "setSingleSelect ITEM_900|Work type|POC",
      "setDate ITEM_900|Target date|2026-12-08",
      "setDate ITEM_900|Next touch|2026-11-30",
      "setText ITEM_900|Next action|Ask Dana for the renewal date",
      "setText ITEM_900|Waiting on|Dana's answer",
    ],
    "the waiting on is the last field written",
  );
  assert.equal(ui.redraws.at(-1)?.card.lines.at(-1), "Waiting on: Dana's answer", "and the card says who owes it");
  assert.equal(rowOf(setup.proposals).status, "done");
});

test("a field the draft leaves null is not written, and a parent decides account and track", async () => {
  const setup = harness({ replies: [json({ ...RAW, account: null, track: null, workType: null, nextTouch: null, nextAction: null })] });
  await drafted(setup);
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), [
    "fetchBoard",
    "createIssue demo/notes|Call Dana about the renewal",
    "addToProject PVT_1|I_900",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setDate ITEM_900|Target date|2026-12-08",
    "addSubIssue I_41|I_900",
  ]);
  assert.equal(rowOf(setup.proposals).status, "done");
});

test("a standalone item is not linked under anything", async () => {
  const setup = harness({ replies: [json({ ...RAW, parent: null, account: null, track: null })] });
  const row = await drafted(setup);
  assert.equal(readPayload(row.payload)?.draft.parentRef, null);
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), [
    "fetchBoard",
    "createIssue demo/notes|Call Dana about the renewal",
    "addToProject PVT_1|I_900",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Work type|POC",
    "setDate ITEM_900|Target date|2026-12-08",
    "setDate ITEM_900|Next touch|2026-11-30",
    "setText ITEM_900|Next action|Ask Dana for the renewal date",
  ]);
  const done = rowOf(setup.proposals);
  assert.equal(done.status, "done");
  assert.equal(readProgress(done.progress)?.linked, undefined, "no parent, nothing to link");
});

test("an issue the project's workflow already added is found on the board, not created twice", async () => {
  const setup = harness();
  setup.board.autoAdd = true;
  setup.board.boardAfterCreate = true;
  await drafted(setup);
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), [
    "fetchBoard",
    "createIssue demo/notes|Call Dana about the renewal",
    "addToProject PVT_1|I_900", // it throws: the workflow got there first
    "fetchBoard", // and the item it made is the one the fields are written to
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setSingleSelect ITEM_900|Work type|POC",
    "setDate ITEM_900|Target date|2026-12-08",
    "setDate ITEM_900|Next touch|2026-11-30",
    "setText ITEM_900|Next action|Ask Dana for the renewal date",
    "addSubIssue I_41|I_900",
  ]);
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.equal(readProgress(row.progress)?.itemId, "ITEM_900");
});

test("a createIssue that threw before anything existed creates one issue on the retry", async () => {
  const setup = harness();
  setup.board.failAt = "createIssue";
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui));

  let row = rowOf(setup.proposals);
  assert.equal(row.status, "open", "the card keeps its buttons");
  assert.equal(row.error, "createIssue failed");
  assert.deepEqual(readProgress(row.progress), { issuePending: ID }, "the marker, saved before the call that threw");
  assert.equal(
    ui.redraws.at(-1)?.card.context,
    "→ interrupted while creating the issue: it may exist. Retry looks for it before creating anything.",
  );
  assert.deepEqual(setup.logs.slice(-2), [
    `add ${TS}: create failed at issue: createIssue failed`,
    `proposal ${ID}: apply failed`,
  ]);

  await proposalClick(specs, click(ui, "retry"));

  row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.equal(setup.board.calls.filter((call) => call.startsWith("findIssue")).length, 1, "the retry looked first");
  assert.equal(setup.board.calls.at(-1), "addSubIssue I_41|I_900");
  assert.equal(setup.board.created.length, 1, "one issue, and it is the retry's");
});

test("a create whose answer never arrived says the issue may exist, and the retry adopts it", async () => {
  const setup = harness();
  setup.board.createThenThrow = true;
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui));

  let row = rowOf(setup.proposals);
  assert.equal(row.status, "open", "the card keeps its buttons");
  assert.deepEqual(readProgress(row.progress), { issuePending: ID }, "the issue is on GitHub, and only the marker knows it");
  assert.equal(setup.board.created.length, 1, "the POST landed");
  assert.match(
    ui.redraws.at(-1)?.card.context ?? "",
    /^→ interrupted while creating the issue: it may exist\. Retry looks for it before creating anything\.$/,
  );
  assert.equal(
    ui.redraws.some((drawn) => drawn.card.context.includes("Nothing was written")),
    false,
    "no card claims nothing was written while an issue may exist",
  );

  await proposalClick(specs, click(ui, "retry"));

  assert.equal(setup.board.calls.filter((call) => call.startsWith("createIssue")).length, 1, "one issue, however many clicks");
  assert.ok(setup.board.calls.includes(`findIssue demo/notes|${ID}`), "the retry looked before it created");
  assert.ok(setup.board.calls.includes("addToProject PVT_1|I_900"), "and the issue it adopted went on the board");
  assert.ok(setup.board.calls.includes("addSubIssue I_41|I_900"), "and under its engagement");
  row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900", fields: true, linked: true }, "the marker has done its job");
});

test("a lookup that fails creates nothing: an issue it could not find is no reason for a second", async () => {
  const setup = harness();
  setup.board.createThenThrow = true;
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui)); // the POST landed, the answer did not
  setup.board.failAt = "findIssue";
  await proposalClick(specs, click(ui, "retry"));

  assert.equal(setup.board.calls.filter((call) => call.startsWith("createIssue")).length, 1, "the one the POST landed, and no other");
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "open");
  assert.equal(row.error, "findIssue failed");
  assert.deepEqual(setup.logs.at(-2), `add ${TS}: create failed at issue: findIssue failed`);
});

test("a retry after the issue exists links it even when an Account option has gone from the board", async () => {
  const setup = harness();
  setup.board.failAt = "addSubIssue"; // everything is written, the link is not
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui));
  // The board renames the option away after the issue was made: only the link is left.
  setup.board.board.fields.set("Account", { id: "F_ACCOUNT", options: new Map([["Globex", "O_GLOBEX"]]) });
  const before = setup.board.calls.length;

  await proposalClick(specs, click(ui, "retry"));

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard", "addSubIssue I_41|I_900"], "the link, and no field write");
  assert.equal(
    setup.board.calls.slice(before).filter((call) => call.startsWith("setSingleSelect")).length,
    0,
    "a name the board has since dropped rewrites nothing",
  );
  assert.equal(rowOf(setup.proposals).status, "done");
});

test("a progress that cannot be read stops the apply before a second issue", async () => {
  for (const stored of ['{"issue":{"id":"I_900"}}', "not json", "[]"]) {
    const setup = harness();
    const row = await drafted(setup);
    row.progress = stored;
    const before = setup.board.calls.length;
    const ui = new RecordingUi();

    await proposalClick(machinery(setup.deps, ui), click(ui));

    assert.deepEqual(setup.board.calls.slice(before), [], `${stored}: not even the board is read`);
    assert.equal(row.status, "open", stored);
    assert.equal(row.error, "this draft's progress could not be read", stored);
    assert.match(ui.redraws.at(-1)?.card.context ?? "", /progress could not be read/, stored);
    assert.deepEqual(setup.logs.at(-1), `proposal ${ID}: apply failed`, stored);
  }
});

test("a failure at the board item keeps the issue, and the retry adds it without creating another", async () => {
  const setup = harness();
  setup.board.failAt = "addToProject";
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui));

  let row = rowOf(setup.proposals);
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE }, "the issue is written, the item is not");
  assert.equal(
    ui.redraws.at(-1)?.card.context,
    `→ ${LINK} exists, but adding it to the board failed: addToProject failed. Retry continues from there and creates no second issue.`,
  );

  const before = setup.board.calls.length;
  await proposalClick(specs, click(ui, "retry"));

  assert.equal(setup.board.calls.slice(before).some((call) => call.startsWith("createIssue")), false, "no second issue");
  row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900", fields: true, linked: true });
});

test("a failure at a field keeps the item, and the retry rewrites every field and then links", async () => {
  const setup = harness();
  setup.board.failAt = "setDate"; // after the four selects, before the link
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui));

  let row = rowOf(setup.proposals);
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900" }, "the fields are not marked set");
  assert.deepEqual(setup.logs.at(-2), `add ${TS}: create failed at fields: setDate failed`);

  const before = setup.board.calls.length;
  await proposalClick(specs, click(ui, "retry"));

  assert.deepEqual(setup.board.calls.slice(before), [
    "fetchBoard",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setSingleSelect ITEM_900|Work type|POC",
    "setDate ITEM_900|Target date|2026-12-08",
    "setDate ITEM_900|Next touch|2026-11-30",
    "setText ITEM_900|Next action|Ask Dana for the renewal date",
    "addSubIssue I_41|I_900",
  ]);
  row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900", fields: true, linked: true });
});

test("a failure at the link keeps everything else, and the retry only links", async () => {
  const setup = harness();
  setup.board.failAt = "addSubIssue";
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui));

  let row = rowOf(setup.proposals);
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900", fields: true });
  assert.equal(
    ui.redraws.at(-1)?.card.context,
    `→ ${LINK} exists, but linking it under its parent failed: addSubIssue failed. Retry continues from there and creates no second issue.`,
  );

  const before = setup.board.calls.length;
  await proposalClick(specs, click(ui, "retry"));

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard", "addSubIssue I_41|I_900"]);
  row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.deepEqual(readProgress(row.progress), { issue: ISSUE, itemId: "ITEM_900", fields: true, linked: true });
});

test("a draft whose engagement has left the board fails before anything is created", async () => {
  const setup = harness();
  await drafted(setup);
  setup.board.board = acmeBoard([]);
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard"], "the read, and no write at all");
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "open");
  assert.equal(row.error, `parent ${PARENT} is not on the board`);
  assert.match(ui.redraws.at(-1)?.card.context ?? "", /^→ failed: parent demo#41 is not on the board\. Nothing was written\./);
});

test("a draft whose Status option has gone fails before anything is created", async () => {
  const setup = harness();
  await drafted(setup);
  setup.board.board.fields.set("Status", { id: "F_STATUS", options: new Map([["Inbox", "O_INBOX"]]) });
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard"]);
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "open");
  assert.equal(row.error, "the board has no Status option the draft names", "the card's reason names the field, never the option");
});

test("a payload that cannot be read writes nothing at all", async () => {
  const setup = harness();
  const row = await drafted(setup);
  row.payload = "{not json";
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), [], "not even the board is read");
  assert.equal(row.status, "open");
  assert.equal(row.error, "this draft could not be read");
  assert.deepEqual(setup.logs.at(-1), `proposal ${ID}: apply failed`);
});

test("a double click writes once: the second click finds the card being created", async () => {
  const setup = harness();
  await drafted(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);
  const gate = new Gate();
  setup.board.gate = gate;

  const first = proposalClick(specs, click(ui));
  await gate.entered;
  await proposalClick(specs, click(ui));

  assert.equal(setup.board.calls.filter((call) => call.startsWith("createIssue")).length, 1);
  gate.open();
  await first;

  assert.equal(setup.board.calls.filter((call) => call.startsWith("createIssue")).length, 1, "one issue, two clicks");
  assert.equal(rowOf(setup.proposals).status, "done");
  assert.ok(setup.logs.includes(`proposal ${ID}: already applying, this click does nothing`));
});

test("the proposal id is the Slack ts with the kind in front", () => {
  assert.equal(proposalId("1700.1"), "add:1700.1");
});
