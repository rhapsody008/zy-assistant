// 0.8.0's note items end to end: a fake board, the fake proposal store and the
// real proposal machinery, so a click here goes through the path Slack drives. No
// network, no Slack, no GitHub, no timers. Synthetic names only: "Acme", "Globex",
// "Dana", "demo".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FailedStep } from "../src/add-handler.ts";
import type { Board, BoardField } from "../src/github.ts";
import { readNoteItemsContext, readNoteItemsPayload, readNoteItemsProgress } from "../src/note-items.ts";
import {
  noteItemsSpec,
  proposeNoteItems,
  type NoteItemsDeps,
  type NoteItemsInput,
  type NoteItemsUi,
} from "../src/note-items-handler.ts";
import {
  proposalClick,
  proposalEdited,
  type Card,
  type EditField,
  type ProposalButton,
  type ProposalClick,
  type ProposalDeps,
  type ProposalUi,
} from "../src/proposals.ts";
import type { Item } from "../src/rules.ts";
import type { Note, NoteAction } from "../src/scribe.ts";
import type { Proposal, ProposalPatch } from "../src/store.ts";
import { FakeBoard, FakeProposals } from "./fakes.ts";

/** Wed 2026-11-25, 09:00 in Singapore: the day after the meeting of every note here. */
const NOW = new Date("2026-11-25T01:00:00Z");
const TS = "1700000000.000100";
const ID = `note:${TS}`;
const USER = "U_ZY"; // the only person whose clicks count
const FOLDER = "Accounts/Acme";
/** The DM the dictation came in: where the card is posted, and what a restart redraws in. */
const CHANNEL = "D";
/** The note's own link: what an issue made from it says it came from. */
const COMMIT = "https://github.com/demo/notes/commit/abc123";
const PARENT = "demo#41";
const ISSUE = { id: "I_900", number: 900, url: "https://github.com/demo/notes/issues/900" };

const url = (n: number): string => `https://github.com/demo/notes/issues/${n}`;

const action = (owner: string, text: string, due: string | null = null): NoteAction => ({ owner, text, due });

function note(actions: NoteAction[], overrides: Partial<Note> = {}): Note {
  return {
    folder: "Accounts/Acme",
    newFolderName: null,
    date: "2026-11-24",
    type: "POC",
    topic: "NKP sizing",
    attendees: ["Dana"],
    summary: "Sizing was agreed and the POC window was discussed.",
    decisions: [],
    actions,
    ...overrides,
  };
}

/** Two of ZY's actions and one of Dana's: three items, and every one of them is created. */
const THREE = note([
  action("ZY", "send the sizing sheet", "2026-11-27"),
  action("Dana", "confirm the POC window", "2026-12-01"),
  action("ZY", "book the room"),
]);

/** The engagement a note's items hang under: one live issue, on the board. */
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

/** The board with every field a note item writes, and one engagement to file under. */
function acmeBoard(items: Item[] = [engagement()]): Board {
  return {
    projectId: "PVT_1",
    title: "Board",
    fields: new Map<string, BoardField>([
      [
        "Status",
        {
          id: "F_STATUS",
          options: new Map([
            ["Inbox", "O_INBOX"],
            ["Next", "O_NEXT"],
            ["In progress", "O_PROGRESS"],
            ["Waiting", "O_WAITING"],
            ["Done", "O_DONE"],
          ]),
        },
      ],
      ["Track", { id: "F_TRACK", options: new Map([["Customer", "O_CUSTOMER"], ["Build", "O_BUILD"]]) }],
      ["Account", { id: "F_ACCOUNT", options: new Map([["Acme", "O_ACME"], ["Globex", "O_GLOBEX"]]) }],
      ["Work type", { id: "F_WORKTYPE", options: new Map([["POC", "O_POC"], ["Workshop", "O_WORKSHOP"]]) }],
      ["Target date", { id: "F_TARGET" }],
      ["Next touch", { id: "F_TOUCH" }],
      ["Next action", { id: "F_ACTION" }],
      // A waiting item records who owes the next move, so the batch needs this field.
      ["Waiting on", { id: "F_WAITING" }],
    ]),
    items,
  };
}

/** The propose step's Slack: the card it posts, and the lines it says in the thread. */
class FakeNoteUi implements NoteItemsUi {
  readonly posts: Array<{ card: Card; rev: number }> = [];
  readonly replies: string[] = [];
  /** When set, posting the card fails: what Slack does when the DM cannot take it. */
  failPost: Error | null = null;

  async post(card: Card, rev: number): Promise<string> {
    if (this.failPost !== null) throw this.failPost;
    this.posts.push({ card, rev });
    return `card-${this.posts.length}`;
  }

  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }
}

/** The proposal machinery's Slack: the cards it draws, and the lines it says in their thread. */
class RecordingUi implements ProposalUi {
  readonly redraws: Array<{ card: Card; rev: number }> = [];
  readonly replies: string[] = [];
  readonly modals: Array<{ id: string; rev: number; fields: EditField[] }> = [];

  async redraw(card: Card, rev: number): Promise<void> {
    this.redraws.push({ card, rev });
  }

  async repost(): Promise<void> {}

  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }

  async openEdit(id: string, rev: number, fields: EditField[]): Promise<void> {
    this.modals.push({ id, rev, fields });
  }
}

/** The pipeline as the bot wires it, and the fakes on the other end of it. */
function harness(options: { board?: Board } = {}) {
  const board = new FakeBoard();
  board.board = options.board ?? acmeBoard();
  const proposals = new FakeProposals();
  const logs: string[] = [];
  const clock = { now: NOW };
  const deps: NoteItemsDeps = {
    board,
    proposals,
    repo: "demo/notes",
    owner: "zy",
    number: 1,
    now: () => clock.now,
    log: (line) => logs.push(line),
  };
  return { deps, board, proposals, logs, clock, ui: new FakeNoteUi() };
}

type Harness = ReturnType<typeof harness>;

function rowOf(store: FakeProposals): Proposal {
  const row = store.findProposal(ID);
  if (row === null) throw new Error("the proposal is not in the store");
  return row;
}

/** One committed note through the propose step: the row it leaves, ready for a click. */
async function proposed(setup: Harness, input: Partial<NoteItemsInput> = {}): Promise<Proposal> {
  await proposeNoteItems(setup.deps, { ts: TS, channel: CHANNEL, folder: FOLDER, note: THREE, url: COMMIT, ...input }, setup.ui);
  return rowOf(setup.proposals);
}

/** The proposal machinery over the same fakes, with the kind this file is about. */
function machinery(deps: NoteItemsDeps, ui: ProposalUi): ProposalDeps {
  return { store: deps.proposals, specs: { note: noteItemsSpec(deps) }, userId: USER, now: deps.now, log: deps.log };
}

const click = (ui: ProposalUi, action: ProposalButton = "create", rev = 0): ProposalClick => ({
  action,
  id: ID,
  rev,
  userId: USER,
  triggerId: "trig-1",
  ui,
});

/** One click of the whole batch, with the propose step done already. */
async function clicked(setup: Harness, one: ProposalButton = "create"): Promise<RecordingUi> {
  const ui = new RecordingUi();
  await proposalClick(machinery(setup.deps, ui), click(ui, one));
  return ui;
}

/** The card's own name for one item's marker: two digits, one per written item. */
const marker = (k: number): string => `zy-assistant:note:${TS}/${String(k).padStart(2, "0")}`;

// ---- The propose step -------------------------------------------------------

test("a committed note is proposed as one card, and the row keeps what the card was drawn from", async () => {
  const setup = harness();

  const row = await proposed(setup);

  assert.deepEqual(setup.ui.posts.map((drawn) => drawn.rev), [0], "a fresh row is rev 0");
  assert.equal(setup.ui.posts[0].card.head, "*Board items from this note* · 3 actions · nothing created yet");
  assert.deepEqual(setup.ui.posts[0].card.lines, [
    "1. *send the sizing sheet* · Next · target Fri 27 Nov",
    "2. *confirm the POC window* · Waiting on Dana · touch Tue 1 Dec",
    "3. *book the room* · Next",
  ]);
  assert.deepEqual(setup.ui.posts[0].card.buttons, ["create", "edit", "cancel"]);
  assert.deepEqual(setup.ui.replies, []);

  assert.equal(row.kind, "note", "the kind the click looks the spec up by");
  assert.equal(row.status, "open");
  assert.equal(row.messageTs, "card-1", "the ts the posted card is later redrawn on");
  assert.equal(row.channel, CHANNEL, "where the card is: a restart's redraw needs it");
  const payload = readNoteItemsPayload(row.payload);
  assert.ok(payload !== null);
  assert.deepEqual(payload.note, { date: "2026-11-24", url: COMMIT, folder: FOLDER }, "the meeting's day, the note's own link and the folder that named the account");
  assert.equal(payload.parentRef, PARENT);
  assert.deepEqual(
    payload.items.map((item) => [item.owner, item.as]),
    [
      ["ZY", "next"],
      ["Dana", "waiting"],
      ["ZY", "next"],
    ],
  );
  assert.ok(readNoteItemsContext(row.context) !== null, "the board facts the edit modal needs");
  assert.deepEqual(setup.logs, [`note-items ${TS}: proposed 3 items (0 not created, parent ${PARENT})`]);
});

test("a second proposal for the same dictation is ignored before the board is read", async () => {
  const setup = harness();

  await proposed(setup);
  await proposed(setup);

  assert.equal(setup.ui.posts.length, 1, "one card, however many deliveries");
  assert.equal(setup.proposals.rows.size, 1, "one row");
  assert.deepEqual(setup.board.calls, ["fetchBoard"], "the second one read nothing");
  assert.deepEqual(setup.logs.at(-1), `note-items ${TS}: already proposed, ignoring`);
});

test("a board that cannot be read ends the row and says why in the thread", async () => {
  const setup = harness();
  setup.board.failAt = "fetchBoard";

  const row = await proposed(setup);

  assert.deepEqual(setup.ui.posts, [], "there is no card to draw");
  assert.deepEqual(setup.ui.replies, ["⚠️ could not propose board items: fetchBoard failed"]);
  assert.equal(row.status, "cancelled", "the note is committed: there is no ack to wait for a click on");
  assert.equal(row.error, "fetchBoard failed");
  assert.equal(row.payload, null);
  assert.deepEqual(setup.logs, [`note-items ${TS}: the board read failed: fetchBoard failed`]);
});

test("a note the board cannot take as items is refused before a card exists", async () => {
  // No Waiting option: Dana's action would be a Waiting item, which this board cannot hold.
  const board = acmeBoard();
  board.fields.set("Status", { id: "F_STATUS", options: new Map([["Inbox", "O_INBOX"], ["Next", "O_NEXT"]]) });
  const setup = harness({ board });

  const row = await proposed(setup);

  assert.deepEqual(setup.ui.posts, []);
  const reason = "item 2: the item is not valid: status must be one of the Status options listed, or null";
  assert.deepEqual(setup.ui.replies, [`⚠️ could not propose board items: ${reason}`]);
  assert.equal(row.status, "cancelled");
  assert.equal(row.error, reason);
  assert.deepEqual(setup.logs, [`note-items ${TS}: the payload was refused: ${reason}`]);
});

test("a card Slack will not post ends the row and says why in the thread", async () => {
  const setup = harness();
  setup.ui.failPost = new Error("slack is down");

  const row = await proposed(setup);

  assert.deepEqual(setup.ui.replies, ["⚠️ could not propose board items: slack is down"]);
  assert.equal(row.status, "cancelled");
  assert.equal(row.error, "slack is down");
  assert.ok(row.payload !== null, "the items are still stored: only the card failed");
  assert.deepEqual(setup.logs, [`note-items ${TS}: the card failed to post: slack is down`]);
});

/** The store whose ts write fails: a database that went away after the card was up. */
class FailingTsStore extends FakeProposals {
  override updateProposal(id: string, patch: ProposalPatch): void {
    if (patch.messageTs !== undefined) throw new Error("SQLite: the database is locked");
    super.updateProposal(id, patch);
  }
}

test("a store that loses the card's ts is not a proposal that failed", async () => {
  const setup = harness();
  const store = new FailingTsStore();
  setup.deps.proposals = store;

  await proposeNoteItems(setup.deps, { ts: TS, channel: CHANNEL, folder: FOLDER, note: THREE, url: COMMIT }, setup.ui);

  assert.equal(setup.ui.posts.length, 1, "the card is posted and stays posted");
  assert.deepEqual(setup.ui.replies, [], "and nothing in the thread contradicts it");
  assert.deepEqual(setup.logs, [`note-items ${TS}: the card's ts could not be stored: SQLite: the database is locked`]);
  assert.equal(store.findProposal(ID)?.messageTs, null, "the loss is the ts a restart's redraw would need");
});

// ---- Apply ------------------------------------------------------------------

test("Create writes every item's issue, board item, fields and link, in the note's order", async () => {
  const setup = harness();
  await proposed(setup);
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), [
    "fetchBoard", // the click reads the board again, always
    "createIssue demo/notes|send the sizing sheet",
    "addToProject PVT_1|I_900",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setDate ITEM_900|Target date|2026-11-27",
    "addSubIssue I_41|I_900",
    "createIssue demo/notes|confirm the POC window",
    "addToProject PVT_1|I_900",
    "setSingleSelect ITEM_900|Status|Waiting",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "setDate ITEM_900|Next touch|2026-12-01",
    "setText ITEM_900|Waiting on|Dana",
    "addSubIssue I_41|I_900",
    "createIssue demo/notes|book the room",
    "addToProject PVT_1|I_900",
    "setSingleSelect ITEM_900|Status|Next",
    "setSingleSelect ITEM_900|Track|Customer",
    "setSingleSelect ITEM_900|Account|Acme",
    "addSubIssue I_41|I_900",
  ]);

  const row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  assert.equal(row.error, null);
  const progress = readNoteItemsProgress(row.progress);
  assert.ok(progress !== null);
  assert.equal(progress.items.length, 3);
  for (const entry of progress.items) {
    assert.deepEqual([entry.issue, entry.itemId, entry.error], [ISSUE, "ITEM_900", null]);
    assert.equal(entry.linked, true);
  }
  assert.deepEqual(
    ui.redraws.map((drawn) => drawn.card.context),
    ["→ creating…", `→ created 3 items: on the board, under ${PARENT}.`],
  );
});

test("a batch whose option has gone from the board is refused before anything is written", async () => {
  const setup = harness();
  await proposed(setup);
  // The Waiting option left the board after the card was drawn: Dana's item cannot be written.
  setup.board.board.fields.set("Status", { id: "F_STATUS", options: new Map([["Inbox", "O_INBOX"], ["Next", "O_NEXT"]]) });
  const before = setup.board.calls.length;
  const ui = new RecordingUi();

  await proposalClick(machinery(setup.deps, ui), click(ui));

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard"], "the read, and not one write");
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "open");
  assert.equal(row.error, "the board has no Status option the draft names", "the reason names the field, never the option");
  assert.equal(setup.board.created.length, 0);
});

const STEPS: Array<{ step: "createIssue" | "addToProject" | "setDate" | "addSubIssue"; name: FailedStep; reason: string }> = [
  { step: "createIssue", name: "issue", reason: "createIssue failed" },
  { step: "addToProject", name: "project", reason: "addToProject failed" },
  { step: "setDate", name: "fields", reason: "setDate failed" },
  { step: "addSubIssue", name: "link", reason: "addSubIssue failed" },
];

test("one item failing does not stop the batch: the items after it are still made", async () => {
  for (const one of STEPS) {
    const setup = harness();
    await proposed(setup);
    // The second call of the step is item 2's: item 1 wrote its own first.
    setup.board.failAt = one.step;
    setup.board.failAtCall = 2;
    const ui = await clicked(setup);

    const row = rowOf(setup.proposals);
    const progress = readNoteItemsProgress(row.progress);
    assert.ok(progress !== null, one.name);
    assert.equal(row.status, "open", `${one.name}: the card keeps its buttons`);
    assert.equal(row.error, "1 of 3 items failed");
    assert.deepEqual(
      progress.items.map((entry) => [entry.itemId !== undefined, entry.error]),
      [
        [true, null],
        // An item that stopped before its board item has no item id yet, whatever else it wrote.
        [one.name !== "issue" && one.name !== "project", one.reason],
        [true, null],
      ],
      `${one.name}: items 1 and 3 are made, item 2 stopped where it stood`,
    );
    assert.equal(setup.board.created.length, one.name === "issue" ? 2 : 3, `${one.name}: one issue per item that got that far`);
    assert.ok(setup.logs.includes(`note-items ${TS}: item 2: failed at ${one.name}: ${one.reason}`));
    assert.ok(setup.logs.includes(`note-items ${TS}: item 3: created demo/notes#900 as ITEM_900, under ITEM_41`));
    // The batch's line counts this run's finished items, not the issues it wrote: an
    // item that stopped at its fields has an issue and is still not made.
    assert.ok(setup.logs.includes(`note-items ${TS}: created 2 of 3`), `${one.name}: ${setup.logs.join(" | ")}`);
    assert.deepEqual(ui.redraws.at(-1)?.card.buttons, ["retry", "cancel"], `${one.name}: and Retry is what is left`);
  }
});

test("a retry finishes the item that stopped and makes no second issue for the others", async () => {
  const setup = harness();
  await proposed(setup);
  setup.board.failAt = "addSubIssue"; // item 2's issue, item and fields are all written
  setup.board.failAtCall = 2;
  await clicked(setup);
  assert.equal(setup.board.created.length, 3);
  const before = setup.board.calls.length;

  const ui = await clicked(setup, "retry");

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard", "addSubIssue I_41|I_900"], "item 2's link, and no other write");
  assert.equal(setup.board.created.length, 3, "one issue, however many clicks");
  assert.equal(setup.board.calls.filter((call) => call.startsWith("createIssue")).length, 3);
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  const progress = readNoteItemsProgress(row.progress);
  assert.deepEqual(
    progress?.items.map((entry) => [entry.itemId !== undefined, entry.error]),
    [
      [true, null],
      [true, null],
      [true, null],
    ],
  );
  assert.equal(ui.redraws.at(-1)?.card.context, `→ created 3 items: on the board, under ${PARENT}.`);
  assert.equal(setup.logs.at(-1), `note-items ${TS}: created 1 of 3`, "the retry says what this run had left to make");
});

test("a retry checks the names of the items a restart left unstarted, before it writes anything", async () => {
  const setup = harness();
  const row = await proposed(setup);
  // A restart between item 1 and item 2: the row keeps what was written and nothing else.
  row.progress = JSON.stringify({
    items: [{ issue: ISSUE, itemId: "ITEM_900", fields: true, linked: true, error: null }, { error: null }, { error: null }],
  });
  // The option the unstarted items name leaves the board before the retry.
  setup.board.board.fields.get("Account")?.options?.delete("Acme");
  const before = setup.board.calls.length;

  const ui = await clicked(setup, "retry");

  assert.deepEqual(setup.board.calls.slice(before), ["fetchBoard"], "the read, and not one write");
  assert.equal(setup.board.created.length, 0, "no issue is orphaned for an item nothing has written");
  assert.equal(rowOf(setup.proposals).error, "the board has no Account option the draft names");
  assert.equal(rowOf(setup.proposals).status, "open", "the card keeps its Retry");
  assert.deepEqual(ui.redraws.at(-1)?.card.buttons, ["retry", "cancel"]);
});

test("with a skipped item first, the marker counts the writes and the card its own numbers", async () => {
  const setup = harness();
  const skippedFirst = note([
    action("ZY", "book the room (demo#41)"), // already on the board: card item 1 is not written
    action("Dana", "confirm the POC window", "2026-12-01"),
    action("ZY", "send the sizing sheet", "2026-11-27"),
  ]);
  await proposed(setup, { note: skippedFirst });
  setup.board.createThenThrowOn = 2; // the second write is the card's third item
  const ui = await clicked(setup);

  const bodies = setup.board.bodies;
  assert.equal(bodies.length, 2, "the skipped item wrote nothing");
  assert.ok(bodies[0]?.includes(marker(1)), "the card's second item is the first write");
  assert.ok(bodies[1]?.includes(marker(2)), "the card's third item is the second write");
  assert.equal(bodies[1]?.includes(marker(1)), false, "one marker, one item");

  const progress = readNoteItemsProgress(rowOf(setup.proposals).progress);
  assert.equal(progress?.items[1].issuePending, `note:${TS}/02`, "the progress is the writes', so its second entry is the card's third item");
  const card = ui.redraws.at(-1)?.card;
  assert.equal(card?.lines[1], `✅ <${ISSUE.url}|notes#900>`, "the card's second item is made");
  assert.equal(card?.lines[2], "⚠ 3. send the sizing sheet · not created: createIssue: the request timed out", "its line in the card's own numbering");

  const before = setup.board.calls.length;
  await clicked(setup, "retry");

  assert.ok(setup.board.calls.slice(before).includes(`findIssue demo/notes|note:${TS}/02`), "the retry looks for the third item's marker");
  assert.equal(setup.board.created.length, 2, "and writes no third issue");
  assert.equal(rowOf(setup.proposals).status, "done");
});

test("an item whose create lost its answer is adopted by its marker, not made twice", async () => {
  const setup = harness();
  await proposed(setup);
  setup.board.createThenThrowOn = 2; // item 2's issue is on GitHub; the answer never arrived
  await clicked(setup);

  let progress = readNoteItemsProgress(rowOf(setup.proposals).progress);
  assert.equal(progress?.items[1].issue, undefined);
  assert.equal(progress?.items[1].issuePending, `note:${TS}/02`, "the marker, saved before the POST");
  assert.equal(setup.board.created.length, 3, "the POST landed");

  await clicked(setup, "retry");

  assert.equal(setup.board.created.length, 3, "the retry adopted it instead of writing a fourth");
  assert.ok(setup.board.calls.includes(`findIssue demo/notes|note:${TS}/02`), "looked up by the marker, before any create");
  const row = rowOf(setup.proposals);
  assert.equal(row.status, "done");
  progress = readNoteItemsProgress(row.progress);
  assert.deepEqual(
    progress?.items.map((entry) => [entry.issue !== undefined, entry.error]),
    [
      [true, null],
      [true, null],
      [true, null],
    ],
  );
});

test("each item's issue carries its own marker, its own line and the note's own day", async () => {
  const setup = harness();
  await proposed(setup);
  await clicked(setup);

  const bodies = setup.board.bodies;
  assert.equal(bodies.length, 3);
  for (const [i, body] of bodies.entries()) assert.ok(body !== undefined && body.includes(marker(i + 1)), `item ${i + 1} names itself`);
  // Two digits, so no item's marker is the start of another's: findIssue matches with includes.
  for (const [i, body] of bodies.entries()) {
    for (const other of bodies.entries()) {
      if (other[0] !== i) assert.equal(body?.includes(marker(other[0] + 1)), false, `item ${i + 1} does not carry item ${other[0] + 1}'s marker`);
    }
  }
  assert.ok(bodies[0]?.includes("- [ ] ZY: send the sizing sheet (due 2026-11-27)"), "the note's line, verbatim");
  assert.ok(bodies[1]?.includes("- [ ] Dana: confirm the POC window (due 2026-12-01)"));
  assert.ok(bodies[0]?.includes(`_Added by zy-assistant from a meeting note (${COMMIT}) on 2026-11-24._`), "the note's day, not the click's");
});

test("the log names ids and steps only, never a title, an owner or an account", async () => {
  const setup = harness();
  await proposed(setup);
  await clicked(setup);

  assert.deepEqual(setup.logs, [
    `note-items ${TS}: proposed 3 items (0 not created, parent ${PARENT})`,
    `note-items ${TS}: item 1: created demo/notes#900 as ITEM_900, under ITEM_41`,
    `note-items ${TS}: item 2: created demo/notes#900 as ITEM_900, under ITEM_41`,
    `note-items ${TS}: item 3: created demo/notes#900 as ITEM_900, under ITEM_41`,
    `note-items ${TS}: created 3 of 3`,
  ]);
  for (const line of setup.logs) {
    for (const name of ["sizing sheet", "POC window", "book the room", "Dana", "Acme", "Customer", "Accounts/", "NKP sizing"]) {
      assert.equal(line.includes(name), false, `"${line}" repeats no name of the note`);
    }
  }
});

test("a GitHub refusal that echoes the title is clipped to its status, in the log and on the card", async () => {
  const setup = harness();
  await proposed(setup);
  setup.board.failAt = "createIssue";
  // What a 422 looks like: the body quotes the title the request sent.
  setup.board.failWith = 'GitHub API 422: {"message":"Validation Failed","errors":[{"message":"send the sizing sheet is too long"}]}';
  const ui = await clicked(setup);

  assert.deepEqual(setup.logs, [
    `note-items ${TS}: proposed 3 items (0 not created, parent ${PARENT})`,
    `note-items ${TS}: item 1: failed at issue: GitHub API 422`,
    `note-items ${TS}: item 2: created demo/notes#900 as ITEM_900, under ITEM_41`,
    `note-items ${TS}: item 3: created demo/notes#900 as ITEM_900, under ITEM_41`,
    `note-items ${TS}: created 2 of 3`,
    `proposal ${ID}: apply failed`,
  ]);
  for (const line of setup.logs) assert.equal(line.includes("sizing sheet"), false, `"${line}" repeats no title`);
  assert.equal(ui.redraws.at(-1)?.card.lines[0], "⚠ 1. send the sizing sheet · not created: GitHub API 422");
  assert.equal(readNoteItemsProgress(rowOf(setup.proposals).progress)?.items[0].error, "GitHub API 422");
});

test("an item whose addToProject and the read it falls back to both fail is saved, logged and shown", async () => {
  const setup = harness();
  await proposed(setup);
  // The project's own workflow added item 1's issue first, so addToProject throws, and
  // the read that would find the item on the board fails too: this failure never goes
  // through fail(), and it is still this item's own.
  setup.board.autoAdd = true;
  setup.board.failAt = "fetchBoard";
  setup.board.failAtCall = 3; // the propose read, the click's own read, then item 1's fallback
  const ui = await clicked(setup);

  const entry = readNoteItemsProgress(rowOf(setup.proposals).progress)?.items[0];
  assert.equal(entry?.error, "fetchBoard failed", "the reason is saved");
  assert.equal(entry?.itemId, undefined, "nothing was put on the board");
  assert.ok(setup.logs.includes(`note-items ${TS}: item 1: failed: fetchBoard failed`), "and logged once");
  // The whole list of that item's lines, so a second one for the same failure fails here.
  assert.deepEqual(
    setup.logs.filter((line) => line.startsWith(`note-items ${TS}: item 1:`)),
    [`note-items ${TS}: item 1: failed: fetchBoard failed`],
  );
  assert.equal(ui.redraws.at(-1)?.card.lines[0], "⚠ 1. send the sizing sheet · exists, but adding it to the board failed");
});

test("six actions are six issues, and the card says the rest did not fit", async () => {
  const seven = note(Array.from({ length: 7 }, (_, i) => action("ZY", `do thing ${i + 1}`)));
  const setup = harness();

  await proposed(setup, { note: seven });
  const card = setup.ui.posts[0].card;
  assert.equal(card.head, "*Board items from this note* · 7 actions · nothing created yet");
  assert.match(card.context, /⚠ 1 more action did not fit this card; use `add:` for it./);
  const payload = readNoteItemsPayload(rowOf(setup.proposals).payload);
  assert.equal(payload?.items.length, 6);
  assert.equal(payload?.more, 1);

  await clicked(setup);

  assert.equal(setup.board.created.length, 6, "six issues: the card's own limit");
  assert.deepEqual(setup.logs.at(-1), `note-items ${TS}: created 6 of 6`);
});

test("a note whose every action is already on the board offers no Create at all", async () => {
  const setup = harness();
  const repeated = note([action("ZY", "book the room (demo#41)"), action("Dana", "chase demo#41")]);

  await proposed(setup, { note: repeated });

  const card = setup.ui.posts[0].card;
  assert.deepEqual(card.buttons, ["edit", "cancel"], "nothing to create, so nothing claims an issue");
  assert.equal(card.context.includes("Nothing to create"), true);
  assert.deepEqual(setup.logs, [`note-items ${TS}: proposed 2 items (2 not created, parent ${PARENT})`]);
  assert.deepEqual(setup.board.calls, ["fetchBoard"], "and no click wrote anything");
});

test("a progress that cannot be read stops the click before a second issue", async () => {
  for (const stored of ['{"items":[{"issue":{"id":"I_900"}}]}', "not json", '{"items":{}}']) {
    const setup = harness();
    const row = await proposed(setup);
    row.progress = stored;
    const before = setup.board.calls.length;
    const ui = new RecordingUi();

    await proposalClick(machinery(setup.deps, ui), click(ui));

    assert.deepEqual(setup.board.calls.slice(before), [], `${stored}: not even the board is read`);
    assert.equal(row.status, "open", stored);
    assert.equal(row.error, "this proposal's progress could not be read", stored);
    assert.deepEqual(setup.logs.at(-1), `proposal ${ID}: apply failed`, stored);
  }
});

test("a card whose progress cannot be read says so, and offers no Create", async () => {
  const setup = harness();
  const row = await proposed(setup);
  row.progress = '{"items":[{"issue":{"id":"I_900"}}]}';

  const card = noteItemsSpec(setup.deps).card(row);

  assert.equal(card.context, "⚠ what this card has already created could not be read: nothing more will be written.");
  assert.deepEqual(card.buttons, ["cancel"], "a Create here would write the items it cannot see a second time");
  assert.deepEqual(card.lines, []);
});

// ---- The Edit modal ---------------------------------------------------------

test("the modal is the row's own items, and a row that cannot be read opens none", async () => {
  const setup = harness();
  const row = await proposed(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui, "edit"));

  assert.equal(ui.modals.length, 1);
  assert.deepEqual(
    ui.modals[0].fields.map((field) => field.name),
    ["parent", "i1.as", "i1.title", "i1.date", "i2.as", "i2.title", "i2.date", "i3.as", "i3.title", "i3.date"],
  );

  // The context the modal is drawn against is gone: there is no modal, and nothing written.
  row.context = null;
  await proposalClick(specs, click(ui, "edit"));
  assert.equal(ui.modals.length, 1, "no second modal");
  assert.deepEqual(setup.logs.at(-1), `proposal ${ID}: the modal failed: this note's items could not be read`);
});

test("an edit is checked against the board and stored as the new card", async () => {
  const setup = harness();
  const row = await proposed(setup);
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui, "edit"));
  await proposalEdited(specs, { id: ID, rev: 0, userId: USER, values: { "i3.as": "skip", "i2.title": "confirm the POC window with Dana" }, ui });

  assert.equal(row.rev, 1, "the edit moved the card on");
  const payload = readNoteItemsPayload(row.payload);
  assert.equal(payload?.items[2].as, "skip");
  assert.equal(payload?.items[1].title, "confirm the POC window with Dana");
  assert.deepEqual(ui.redraws.at(-1)?.card.buttons, ["create", "edit", "cancel"]);

  // The checked payload still writes: two items now, and the third's line is struck out.
  await proposalClick(specs, click(ui, "create", 1));
  assert.equal(setup.board.created.length, 2, "a skipped item is not written");
  assert.equal(rowOf(setup.proposals).status, "done");
});

test("an edit submitted after a partial run is refused by the store, and nothing is written", async () => {
  const setup = harness();
  await proposed(setup);
  setup.board.failAt = "addSubIssue"; // item 2's link: the run got far enough to record progress
  setup.board.failAtCall = 2;
  await clicked(setup);
  const before = setup.board.calls.length;
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);

  await proposalClick(specs, click(ui, "edit"));
  await proposalEdited(specs, { id: ID, rev: 0, userId: USER, values: { "i1.title": "send the sizing sheet and the quote" }, ui });

  // The guard is the store's: a card whose items are half written has no draft to edit.
  assert.equal(rowOf(setup.proposals).rev, 0, "the edit stored nothing");
  assert.equal(readNoteItemsPayload(rowOf(setup.proposals).payload)?.items[0].title, "send the sizing sheet");
  assert.deepEqual(ui.replies.at(-1), "this card has moved on: nothing was changed");
  assert.equal(setup.board.calls.length, before, "and nothing was written");
});

test("an item revived by an edit is the only one Create writes", async () => {
  const setup = harness();
  const repeated = note([action("ZY", "book the room (demo#41)"), action("Dana", "chase demo#41")]);
  await proposed(setup, { note: repeated });
  const ui = new RecordingUi();
  const specs = machinery(setup.deps, ui);
  assert.deepEqual(setup.ui.posts[0].card.buttons, ["edit", "cancel"], "both items were on the board already");

  await proposalClick(specs, click(ui, "edit"));
  await proposalEdited(specs, { id: ID, rev: 0, userId: USER, values: { "i1.as": "next", "i1.title": "book the room" }, ui });
  await proposalClick(specs, click(ui, "create", 1));

  assert.equal(setup.board.created.length, 1, "the revived item, and not the one still on the board");
  assert.ok(setup.board.bodies[0]?.includes("- [ ] ZY: book the room (demo#41)"), "with the note's own line");
  assert.equal(readNoteItemsProgress(rowOf(setup.proposals).progress)?.items.length, 1);
  assert.deepEqual(setup.logs.at(-1), `note-items ${TS}: created 1 of 1`);
});
