// The pure core of 0.8.0's note items, pinned exactly: the account a folder
// names, the engagement it picks, the items a note's actions become, the card in
// every state and the editor behind it. No clock and no fakes: every date and
// every board fact is passed in. Synthetic names only: "Acme", "Globex", "Dana",
// "demo".

import assert from "node:assert/strict";
import { test } from "node:test";
import { addEditFields, type AddContext } from "../src/add.ts";
import {
  chooseParent,
  draftOf,
  itemsToCreate,
  noteAccount,
  noteItems,
  noteItemsCard,
  noteItemsEditFields,
  payloadFromEdit,
  readNoteItemsContext,
  readNoteItemsPayload,
  readNoteItemsProgress,
  validatePayload,
  type NoteItem,
  type NoteItemsPayload,
  type NoteItemsState,
} from "../src/note-items.ts";
import type { EditField, ProposalButton } from "../src/proposals.ts";
import { STATUS } from "../src/schema.ts";
import type { Note, NoteAction } from "../src/scribe.ts";

/** Wed 2026-11-25, the day every fixture is drafted on. */
const TODAY = "2026-11-25";

const NOTE_URL = "https://github.com/zy/notes/blob/main/Accounts/Acme/README.md";
const url = (n: number): string => `https://github.com/zy/demo/issues/${n}`;

const CTX: AddContext = {
  accounts: ["Acme", "Globex"],
  tracks: ["Customer", "Build", "Learn"],
  workTypes: ["POC", "Workshop"],
  statuses: ["Inbox", "Next", "In progress", "Waiting"],
  engagements: [
    { ref: "demo#41", title: "Acme · NKP renewal", url: url(41), account: "Acme", track: "Customer" },
    { ref: "demo#63", title: "Acme · sizing sheet", url: url(63), account: "Acme", track: "Customer" },
    { ref: "demo#50", title: "Globex · workshop", url: url(50), account: "Globex", track: "Build" },
  ],
};

const action = (owner: string, text: string, due: string | null = null): NoteAction => ({ owner, text, due });

const note = (actions: NoteAction[], overrides: Partial<Note> = {}): Note => ({
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
});

/** Four actions: two of ZY's, one of Dana's, one that names a board item already. */
const BASE = note([
  action("ZY", "send the sizing sheet", "2026-11-27"),
  action("Dana", "confirm the POC window", "2026-12-01"),
  action("ZY", "book the room (demo#63)"),
  action("Globex", "share the VLAN map"),
]);

const PAYLOAD = noteItems(BASE, CTX, NOTE_URL, TODAY);

const issue = (n: number): { id: string; number: number; url: string } => ({
  id: `I_${n}`,
  number: n,
  url: `https://github.com/zy/notes/issues/${n}`,
});

/** One write of the base payload, done: indices 0, 1 and 3 are created, 2 is skipped. */
const created = (n: number): { issue: { id: string; number: number; url: string }; itemId: string; fields: true; linked: true; error: null } => ({
  issue: issue(n),
  itemId: `PVTI_${n}`,
  fields: true,
  linked: true,
  error: null,
});

const CREATED = created(900);

const state = (overrides: Partial<NoteItemsState> = {}): NoteItemsState => ({
  status: "open",
  payload: PAYLOAD,
  context: CTX,
  progress: null,
  error: null,
  repo: "zy/notes",
  ...overrides,
});

/** The throw's message, for the refusals the card and the log repeat. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return assert.fail("expected a throw");
}

/** One select of an edit modal, by the name the values are keyed by. */
function select(fields: EditField[], name: string): Extract<EditField, { kind: "select" }> {
  const field = fields.find((f) => f.name === name);
  if (field === undefined || field.kind !== "select") assert.fail(`${name} is not a select`);
  return field;
}

const textOf = (payload: NoteItemsPayload, index: number): NoteItem => {
  const item = payload.items[index];
  assert.ok(item !== undefined, `item ${index} is there`);
  return item;
};

// ---- The account and the parent ----------------------------------------------

test("the folder is the account only under Accounts/", () => {
  assert.equal(noteAccount("Accounts/Acme"), "Acme");
  assert.equal(noteAccount("Accounts/Acme Ltd"), "Acme Ltd");
  assert.equal(noteAccount("Partners/Globex"), null, "a partner is not an Account option");
  assert.equal(noteAccount("Events/KubeCon"), null);
  assert.equal(noteAccount(null), null, "a note the model gave no folder for names no account");
  assert.equal(noteAccount("Accounts/"), null);
  assert.equal(noteAccount("Acme"), null);
});

test("the account is kept in the board's own spelling, and only when the board has it", () => {
  const lower = noteItems(note([action("ZY", "send the sheet")], { folder: "Accounts/acme" }), CTX, NOTE_URL, TODAY);
  assert.equal(lower.account, "Acme");

  const unknown = noteItems(note([action("ZY", "send the sheet")], { folder: "Accounts/Initech" }), CTX, NOTE_URL, TODAY);
  assert.equal(unknown.account, null, "a folder the board has no option for is no account");
  assert.equal(unknown.parentRef, null, "and no engagement is picked for it");
  assert.equal(unknown.candidates, 0);
});

test("the parent is the account's open engagement: none, one, or the first of several", () => {
  assert.deepEqual(chooseParent(CTX, "Globex"), { ref: "demo#50", candidates: 1 });
  assert.deepEqual(chooseParent(CTX, "Initech"), { ref: null, candidates: 0 });
  assert.deepEqual(chooseParent(CTX, null), { ref: null, candidates: 0 }, "no account, nowhere to hang");
  assert.deepEqual(chooseParent(CTX, "acme"), { ref: "demo#41", candidates: 2 }, "the first, and how many it beat");
});

test("a note under no account has no parent, no track, and standalone items", () => {
  const payload = noteItems(note([action("ZY", "send the sheet")], { folder: "Partners/Globex" }), CTX, NOTE_URL, TODAY);

  assert.equal(payload.account, null);
  assert.equal(payload.track, null);
  assert.equal(payload.parentRef, null);
  assert.equal(payload.items[0].as, "next", "the action is still an item: only where it hangs is missing");
});

test("the item takes the engagement's track: nothing else infers one", () => {
  assert.equal(PAYLOAD.track, "Customer");
  assert.equal(draftOf(textOf(PAYLOAD, 0), PAYLOAD).track, "Customer");

  const globex = noteItems(note([action("ZY", "book the demo")], { folder: "Accounts/Globex" }), CTX, NOTE_URL, TODAY);
  assert.equal(globex.track, "Build");
  assert.equal(draftOf(textOf(globex, 0), globex).track, "Build");
});

// ---- The items ---------------------------------------------------------------

test("ZY's action is Next and anyone else's is Waiting, whatever the case of the name", () => {
  const payload = noteItems(
    note([action("ZY", "send the sizing sheet"), action("zy", "book the room"), action(" zy ", "call the venue"), action("Dana", "confirm the window")]),
    CTX,
    NOTE_URL,
    TODAY,
  );

  assert.deepEqual(
    payload.items.map((item) => [item.owner, item.as]),
    [
      ["ZY", "next"],
      ["zy", "next"],
      ["zy", "next"],
      ["Dana", "waiting"],
    ],
  );
  assert.equal(draftOf(textOf(payload, 3), payload).waitingOn, "Dana");
  assert.equal(draftOf(textOf(payload, 0), payload).waitingOn, null, "ZY owes himself nothing");
});

test("a date is a target for ZY's own action and the day ZY chases for anyone else's", () => {
  const zy = draftOf(textOf(PAYLOAD, 0), PAYLOAD);
  assert.equal(zy.status, STATUS.next);
  assert.equal(zy.targetDate, "2026-11-27");
  assert.equal(zy.nextTouch, null);

  const dana = draftOf(textOf(PAYLOAD, 1), PAYLOAD);
  assert.equal(dana.status, STATUS.waiting);
  assert.equal(dana.targetDate, null, "another person's deadline is not ZY's target");
  assert.equal(dana.nextTouch, "2026-12-01");
  assert.equal(dana.waitingOn, "Dana");

  const undated = draftOf(textOf(PAYLOAD, 3), PAYLOAD);
  assert.equal(undated.nextTouch, null);
  assert.equal(undated.waitingOn, "Globex");
});

test("a due date before today is dropped and flagged, and the note's line keeps it", () => {
  const payload = noteItems(note([action("ZY", "chase the quote", "2026-11-20")]), CTX, NOTE_URL, TODAY);
  const item = textOf(payload, 0);

  assert.equal(item.due, null, "a past target is not written");
  assert.deepEqual(item.flag, { kind: "past-due" });
  assert.equal(item.as, "next", "a past date is no reason to skip the item");
  assert.equal(item.line, "- [ ] ZY: chase the quote (due 2026-11-20)", "the note is quoted as it is");
  assert.equal(draftOf(item, payload).targetDate, null);
});

test("today is not the past: a due date of today is kept", () => {
  assert.equal(textOf(noteItems(note([action("ZY", "send it", TODAY)]), CTX, NOTE_URL, TODAY), 0).due, TODAY);
});

test("an action that names an engagement's ref is not created again", () => {
  const item = textOf(PAYLOAD, 2);

  assert.equal(item.as, "skip");
  assert.deepEqual(item.flag, { kind: "already-there", ref: "demo#63" });
  assert.equal(item.title, "book the room (demo#63)");

  const unknown = noteItems(note([action("ZY", "book the room (demo#999)")]), CTX, NOTE_URL, TODAY);
  assert.equal(unknown.items[0].as, "next", "a ref the board does not have is no reason to skip");
  assert.equal(unknown.items[0].flag, null);
});

test("an action whose whole title is an engagement's is not created again either", () => {
  const same = noteItems(note([action("ZY", "Acme · sizing  sheet.")]), CTX, NOTE_URL, TODAY);
  assert.equal(same.items[0].as, "skip");
  assert.deepEqual(same.items[0].flag, { kind: "already-there", ref: "demo#63" }, "spacing, case and punctuation are not the point");

  const other = noteItems(note([action("ZY", "write the sizing sheet")]), CTX, NOTE_URL, TODAY);
  assert.equal(other.items[0].as, "next", "a title that only starts the same is a different thing");
});

test("two actions with the same title are one item", () => {
  const payload = noteItems(
    note([action("ZY", "send the sizing sheet"), action("ZY", "Send the  sizing sheet."), action("Dana", "confirm the window")]),
    CTX,
    NOTE_URL,
    TODAY,
  );

  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].owner, "ZY", "the first one is kept, as the note has it");
  assert.equal(payload.more, 0, "a repeat is not an action the card leaves out");
});

test("six items are kept and the rest are only counted", () => {
  const actions = Array.from({ length: 7 }, (_, i) => action("ZY", `task ${i + 1}`));
  const payload = noteItems(note(actions), CTX, NOTE_URL, TODAY);

  assert.equal(payload.items.length, 6);
  assert.equal(payload.more, 1);
  assert.equal(payload.items[5].title, "task 6");
  assert.equal(noteItemsCard(state({ payload })).head, "*Board items from this note* · 7 actions · nothing created yet");
});

test("an item's title is the action text, clipped to what a title may be", () => {
  const payload = noteItems(note([action("ZY", `send ${"x".repeat(200)}`)]), CTX, NOTE_URL, TODAY);

  assert.equal(payload.items[0].title.length, 120);
  assert.equal(payload.items[0].line, `- [ ] ZY: send ${"x".repeat(200)}`, "the note's own line is not clipped");
});

// ---- The draft --------------------------------------------------------------

test("a draft is the item's own fields, and nothing it did not say", () => {
  assert.deepEqual(draftOf(textOf(PAYLOAD, 0), PAYLOAD), {
    title: "send the sizing sheet",
    parentRef: "demo#41",
    account: "Acme",
    track: "Customer",
    workType: null,
    status: STATUS.next,
    targetDate: "2026-11-27",
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
  });
  assert.deepEqual(draftOf(textOf(PAYLOAD, 1), PAYLOAD), {
    title: "confirm the POC window",
    parentRef: "demo#41",
    account: "Acme",
    track: "Customer",
    workType: null,
    status: STATUS.waiting,
    targetDate: null,
    nextTouch: "2026-12-01",
    nextAction: null,
    waitingOn: "Dana",
  });
});

test("the items Create writes are the ones that are not skipped, in the note's order", () => {
  assert.deepEqual(
    itemsToCreate(PAYLOAD).map((one) => [one.index, one.item.title]),
    [
      [0, "send the sizing sheet"],
      [1, "confirm the POC window"],
      [3, "share the VLAN map"],
    ],
  );
});

// ---- What a click may write --------------------------------------------------

test("a payload is checked item by item, and comes back in the board's own spelling", () => {
  const payload = { ...PAYLOAD, account: "acme", track: "customer" };
  const checked = validatePayload(payload, CTX, TODAY);

  assert.equal(checked.account, "Acme");
  assert.equal(checked.track, "Customer");
  assert.deepEqual(checked.items, payload.items, "the items themselves are as they were");
});

test("an item whose title is too long is refused rather than clipped", () => {
  const long: NoteItemsPayload = {
    ...PAYLOAD,
    items: [{ ...textOf(PAYLOAD, 0), title: "T".repeat(121) }],
  };
  assert.throws(() => validatePayload(long, CTX, TODAY), /item 1: the title must be 120 characters or fewer/);

  const empty: NoteItemsPayload = { ...PAYLOAD, items: [{ ...textOf(PAYLOAD, 0), title: "  " }] };
  assert.throws(() => validatePayload(empty, CTX, TODAY), /item 1 needs a title/);
});

test("an option the board no longer has stops the click with nothing written", () => {
  assert.throws(() => validatePayload({ ...PAYLOAD, account: "Initech" }, CTX, TODAY), /account must be one of the Account options listed, or null/);
  assert.throws(() => validatePayload({ ...PAYLOAD, parentRef: "demo#999" }, CTX, TODAY), /parent must be a ref from the engagements listed, or null/);

  // A Status the board cannot file: Waiting is the one a waiting item asks for.
  const noWaiting: AddContext = { ...CTX, statuses: ["Inbox", "Next", "In progress"] };
  assert.throws(() => validatePayload(PAYLOAD, noWaiting, TODAY), /status must be one of the Status options listed, or null/);
});

test("a skipped item is not checked: its text may say anything", () => {
  const items = PAYLOAD.items.map((item) => (item.as === "skip" ? { ...item, title: "T".repeat(200), owner: "x".repeat(400) } : item));
  assert.deepEqual(validatePayload({ ...PAYLOAD, items }, CTX, TODAY).account, "Acme");
});

// ---- The card ---------------------------------------------------------------

const CREATED_LINKS = [issue(900), issue(901), issue(902)].map((one) => `<${one.url}|notes#${one.number}>`);

const CASES: Array<{ name: string; state: NoteItemsState; head: string; context: string; buttons: ProposalButton[] }> = [
  {
    name: "the first card",
    state: state(),
    head: "*Board items from this note* · 4 actions · nothing created yet",
    context:
      "⚠ 2 open engagements for this account: picked the most recent. Create opens 3 issues in `zy/notes`, puts them on the board and links them under demo#41. Nothing is written until then.",
    buttons: ["create", "edit", "cancel"],
  },
  {
    name: "every item left out",
    state: state({ payload: { ...PAYLOAD, items: PAYLOAD.items.filter((item) => item.as !== "next" && item.as !== "waiting") } }),
    head: "*Board items from this note* · 1 action · nothing created yet",
    context:
      "⚠ 2 open engagements for this account: picked the most recent. Nothing to create: every action is on the board already, or left out.",
    buttons: ["edit", "cancel"],
  },
  {
    name: "no account",
    state: state({ payload: noteItems(note([action("ZY", "send the sheet")], { folder: "Partners/Globex" }), CTX, NOTE_URL, TODAY) }),
    head: "*Board items from this note* · 1 action · nothing created yet",
    context:
      "⚠ A note outside Accounts/ names no account: these are standalone items. Create opens 1 issue in `zy/notes`, puts it on the board as standalone items. Nothing is written until then.",
    buttons: ["create", "edit", "cancel"],
  },
  {
    name: "no open engagement",
    state: state({ payload: { ...PAYLOAD, parentRef: null, candidates: 0 } }),
    head: "*Board items from this note* · 4 actions · nothing created yet",
    context:
      "⚠ No open engagement for this account: these are standalone items. Create opens 3 issues in `zy/notes`, puts them on the board as standalone items. Nothing is written until then.",
    buttons: ["create", "edit", "cancel"],
  },
  {
    // The issue is in the repo but never reached the board: the card must not call
    // it created, and must not look as if nothing had happened either.
    name: "an issue with no board item yet",
    state: state({ progress: { items: [{ issue: issue(901), error: null }, { error: null }, { error: null }] } }),
    head: "*Board items from this note* · 4 actions · 0 of 3 created",
    context:
      "⚠ 2 open engagements for this account: picked the most recent. → 3 items are unfinished. Retry continues from there and creates no second issue.",
    buttons: ["retry", "cancel"],
  },
  {
    name: "being created",
    state: state({ status: "applying", progress: { items: [{ error: null }, { error: null }, { error: null }] } }),
    head: "*Board items from this note* · 4 actions · creating…",
    context: "→ creating…",
    buttons: [],
  },
  {
    name: "every item created",
    state: state({ status: "done", progress: { items: [created(900), created(901), created(902)] } }),
    head: "*Board items from this note* · 4 actions · created 3 items",
    context:
      "→ created 3 items: on the board, under demo#41.",
    buttons: [],
  },
  {
    name: "one item failed where it stood",
    state: state({
      error: "GitHub GraphQL: nope",
      progress: { items: [CREATED, { issue: issue(901), itemId: "PVTI_2", error: "GitHub GraphQL: nope" }, { error: null }] },
    }),
    head: "*Board items from this note* · 4 actions · 1 of 3 created",
    context:
      "⚠ 2 open engagements for this account: picked the most recent. → failed: GitHub GraphQL: nope. 2 items are unfinished. Retry continues from there and creates no second issue.",
    buttons: ["retry", "cancel"],
  },
  {
    // A restart between an item's issue and its board item: the store reopens the
    // row with its own reason, and the progress says how far each item got.
    name: "interrupted by a restart",
    state: state({ error: "interrupted by a restart", progress: { items: [CREATED, { error: null }, { error: null }] } }),
    head: "*Board items from this note* · 4 actions · 1 of 3 created",
    context:
      "⚠ 2 open engagements for this account: picked the most recent. → failed: interrupted by a restart. 2 items are unfinished. Retry continues from there and creates no second issue.",
    buttons: ["retry", "cancel"],
  },
  {
    name: "failed before anything was written",
    state: state({ error: "GitHub API 500: boom" }),
    head: "*Board items from this note* · 4 actions · nothing created yet",
    context:
      "⚠ 2 open engagements for this account: picked the most recent. → failed: GitHub API 500: boom. Nothing was written.",
    buttons: ["create", "edit", "cancel"],
  },
  {
    name: "cancelled",
    state: state({ status: "cancelled" }),
    head: "*Board items from this note* · 4 actions · cancelled",
    context: "→ cancelled, nothing was written.",
    buttons: [],
  },
  {
    name: "cancelled halfway",
    state: state({ status: "cancelled", progress: { items: [CREATED, { error: null }, { error: null }] } }),
    head: "*Board items from this note* · 4 actions · cancelled",
    context: "→ stopped: 1 of 3 created; nothing more will be written.",
    buttons: [],
  },
  {
    name: "a payload that cannot be read",
    state: state({ payload: null }),
    head: "*Board items from this note* · nothing created yet",
    context: "⚠ this card's items could not be read; start over with a new note:",
    buttons: ["cancel"],
  },
  {
    name: "a context that cannot be read",
    state: state({ context: null }),
    head: "*Board items from this note* · nothing created yet",
    context: "⚠ this card's items could not be read; start over with a new note:",
    buttons: ["cancel"],
  },
];

test("every card says where the batch stands and offers only the clicks that work", () => {
  for (const one of CASES) {
    const card = noteItemsCard(one.state);
    assert.equal(card.head, one.head, `${one.name}: the head`);
    assert.equal(card.context, one.context, `${one.name}: the context`);
    assert.deepEqual(card.buttons, one.buttons, `${one.name}: the buttons`);
  }
});

test("a card whose progress cannot be read says what its status says, and never a count", () => {
  const head = (status: NoteItemsState["status"]): string => noteItemsCard(state({ status, progressUnreadable: true })).head;

  // An unreadable progress is not an empty one: something may be on the board.
  assert.equal(head("open"), "*Board items from this note* · unknown");
  assert.equal(head("applying"), "*Board items from this note* · creating…");
  assert.equal(head("done"), "*Board items from this note* · created");
  assert.equal(head("cancelled"), "*Board items from this note* · cancelled");
});

test("an issue is not a board item: an entry with no item id is not done", () => {
  // The restart case: the issue was made, the board item never was.
  const card = noteItemsCard(state({ progress: { items: [{ issue: issue(900), error: null }, { error: null }, { error: null }] } }));

  assert.equal(card.lines[0], "⚠ 1. send the sizing sheet · <https://github.com/zy/notes/issues/900|notes#900> exists, but it is not on the board yet", "the issue is named, and the card does not call it created");
  assert.equal(card.head, "*Board items from this note* · 4 actions · 0 of 3 created");
  assert.deepEqual(card.buttons, ["retry", "cancel"], "Retry is what finishes it");
});

test("an item on the board but not linked says which step it lacks, not that it is missing", () => {
  // The restart case a step later: the item is on the board, the link never happened.
  const card = noteItemsCard(
    state({ progress: { items: [{ issue: issue(900), itemId: "PVTI_900", fields: true, error: null }, { error: null }, { error: null }] } }),
  );

  assert.equal(
    card.lines[0],
    "⚠ 1. send the sizing sheet · <https://github.com/zy/notes/issues/900|notes#900> is on the board, but linking it under its parent did not finish",
  );
  assert.equal(card.head, "*Board items from this note* · 4 actions · 0 of 3 created", "and it is still not done");
});

test("the card lists each item as the note has it and Create would write it", () => {
  assert.deepEqual(noteItemsCard(state()).lines, [
    "1. *send the sizing sheet* · Next · target Fri 27 Nov",
    "2. *confirm the POC window* · Waiting on Dana · touch Tue 1 Dec",
    "3. ~book the room (demo#63)~ · not created: demo#63 is already on the board",
    "4. *share the VLAN map* · Waiting on Globex",
  ]);

  assert.deepEqual(noteItemsCard(state({ status: "done", progress: { items: [created(900), created(901), created(902)] } })).lines, [
    `✅ ${CREATED_LINKS[0]}`,
    `✅ ${CREATED_LINKS[1]}`,
    "3. ~book the room (demo#63)~ · not created: demo#63 is already on the board",
    `✅ ${CREATED_LINKS[2]}`,
  ]);
});

test("a failed item says which step stopped, or that it was never made", () => {
  const links = noteItemsCard(
    state({
      progress: { items: [{ issue: issue(901), error: "GitHub GraphQL: nope" }, { error: "createIssue: the request timed out" }, { error: null }] },
    }),
  );

  assert.equal(links.lines[0], "⚠ 1. send the sizing sheet · exists, but adding it to the board failed");
  assert.equal(links.lines[1], "⚠ 2. confirm the POC window · not created: createIssue: the request timed out");
});

test("a title's own formatting cannot break the card, and a dropped date is said so", () => {
  const payload = noteItems(
    note([action("ZY", "send the *final* sheet <b>with demo#63</b>_x_", "2026-11-20")]),
    CTX,
    NOTE_URL,
    TODAY,
  );
  // the ref is in the text, so it is a skip: draw an item that only has the date problem
  const dated = noteItems(note([action("ZY", "send the *final* sheet", "2026-11-20")]), CTX, NOTE_URL, TODAY);
  const card = noteItemsCard(state({ payload: dated }));

  // The card's own bold pair stays, and the title's asterisks are left as ZY wrote
  // them: nothing invisible lands in a title he may copy, the way `add:` has it too.
  assert.equal(card.lines[0], "1. *send the *final* sheet* · Next");
  assert.equal(card.lines[0].match(/\*/g)?.length, 4, "the card's own bold pair and the title's, the latter left as ZY wrote it");
  assert.equal(card.context.includes("⚠ 1 due date was in the past: dropped, it is not written."), true);
  assert.equal(noteItemsCard(state({ payload })).lines[0].includes("&lt;b&gt;"), true, "no link is made of a title");
});

test("a note under Accounts/ whose name is no option is not called a note outside Accounts/", () => {
  const initech = noteItems(note([action("ZY", "send the sheet")], { folder: "Accounts/Initech" }), CTX, NOTE_URL, TODAY);
  const partner = noteItems(note([action("ZY", "send the sheet")], { folder: "Partners/Globex" }), CTX, NOTE_URL, TODAY);
  const said = (payload: NoteItemsPayload): string => noteItemsCard(state({ payload })).context;

  assert.equal(said(initech).includes("outside Accounts/"), false, "the folder does name an account: the board has no such option");
  assert.equal(
    said(initech).includes("⚠ The note's account is not an Account option on the board: these are standalone items."),
    true,
  );
  assert.equal(said(partner).includes("⚠ A note outside Accounts/ names no account: these are standalone items."), true);
});

test("a card fits one Slack section, whatever its items and its reason say", () => {
  const long = Array.from({ length: 6 }, (_, i) => action("ZY", `${i} ${"T".repeat(118)}`, "2026-11-20"));
  const payload = noteItems(note(long, { folder: "Accounts/Initech" }), CTX, NOTE_URL, TODAY);

  for (const one of CASES) {
    const card = noteItemsCard({ ...one.state, error: "E".repeat(400), payload: { ...payload, more: 9 } });
    const text = [card.head, ...card.lines, card.context].join("\n");
    assert.ok(text.length < 3000, `${one.name}: ${text.length} characters`);
  }
});

// ---- The Edit modal ---------------------------------------------------------

test("the modal is the parent of every item, then what each item does, is called and is due", () => {
  const fields = noteItemsEditFields(PAYLOAD, CTX);

  assert.deepEqual(
    fields.map((f) => [f.name, f.kind, f.label]),
    [
      ["parent", "select", "Parent for all"],
      ["i1.as", "select", "1. What to do"],
      ["i1.title", "text", "1. Title"],
      ["i1.date", "date", "1. Date"],
      ["i2.as", "select", "2. What to do"],
      ["i2.title", "text", "2. Title"],
      ["i2.date", "date", "2. Date"],
      ["i3.as", "select", "3. What to do"],
      ["i3.title", "text", "3. Title"],
      ["i3.date", "date", "3. Date"],
      ["i4.as", "select", "4. What to do"],
      ["i4.title", "text", "4. Title"],
      ["i4.date", "date", "4. Date"],
    ],
  );

  assert.deepEqual(select(fields, "parent").options.slice(0, 3), [
    { label: "(none)", value: "_none" },
    { label: "demo#41 Acme · NKP renewal", value: "demo#41" },
    { label: "demo#63 Acme · sizing sheet", value: "demo#63" },
  ]);
  assert.equal(select(fields, "parent").value, "demo#41");
  assert.equal((fields[0] as ReturnType<typeof addEditFields>[number]).name, "parent", "the same shape add:'s own parent field has");

  assert.deepEqual(select(fields, "i2.as").options, [
    { label: "Next", value: "next" },
    { label: "Waiting", value: "waiting" },
    { label: "Don't create", value: "skip" },
  ]);
  assert.equal(select(fields, "i2.as").value, "waiting");
  assert.deepEqual(fields[2], { kind: "text", name: "i1.title", label: "1. Title", value: "send the sizing sheet", required: true, maxLength: 120 });
  assert.deepEqual(fields[3], { kind: "date", name: "i1.date", label: "1. Date", value: "2026-11-27" });
});

test("a skipped item keeps its inputs, so it can be brought back", () => {
  const fields = noteItemsEditFields(PAYLOAD, CTX);

  assert.equal(select(fields, "i3.as").value, "skip");
  assert.equal((fields.find((f) => f.name === "i3.title") as { value: string }).value, "book the room (demo#63)");
  assert.equal(select(fields, "parent").options.some((option) => option.value === "_none"), true);
});

// ---- An edit ------------------------------------------------------------------

test("an edit carries the parent and every item's action, title and date", () => {
  const edited = payloadFromEdit(
    PAYLOAD,
    { parent: "_none", "i1.title": "send the sizing sheet and the quote", "i1.date": "2026-12-04", "i2.title": "chase Dana on the POC" },
    CTX,
    TODAY,
  );

  assert.equal(edited.parentRef, null);
  assert.equal(edited.items[0].title, "send the sizing sheet and the quote");
  assert.equal(edited.items[0].due, "2026-12-04");
  assert.equal(edited.items[1].title, "chase Dana on the POC");
  assert.equal(edited.items[1].due, "2026-12-01", "a field the modal did not send keeps its value");
  assert.equal(edited.items[2].as, "skip", "and so does an item the modal did not touch");
});

test("an item brought back from skipped becomes a board item again", () => {
  const revived = payloadFromEdit(PAYLOAD, { "i3.as": "next", "i3.title": "book the room", "i3.date": "2026-12-08" }, CTX, TODAY);
  const item = textOf(revived, 2);

  assert.equal(item.as, "next");
  assert.equal(item.flag, null, "its own words no longer name the item it was skipped for");
  assert.equal(item.due, "2026-12-08");
  assert.deepEqual(
    itemsToCreate(revived).map((one) => one.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(noteItemsCard(state({ payload: revived })).buttons, ["create", "edit", "cancel"]);
  assert.equal(noteItemsCard(state({ payload: revived })).lines[2], "3. *book the room* · Next · target Tue 8 Dec");
});

test("an item skipped by an edit keeps what it was, and one still naming a board item keeps its reason", () => {
  const left = payloadFromEdit(PAYLOAD, { "i1.as": "skip" }, CTX, TODAY);
  assert.equal(textOf(left, 0).as, "skip");
  assert.equal(textOf(left, 0).flag, null);
  assert.equal(noteItemsCard(state({ payload: left })).lines[0], "1. ~send the sizing sheet~ · not created: you left it out");

  const stillThere = payloadFromEdit(PAYLOAD, { "i3.as": "waiting", "i3.date": "2026-12-08" }, CTX, TODAY);
  assert.deepEqual(textOf(stillThere, 2).flag, { kind: "already-there", ref: "demo#63" }, "its own words still name the item");
  assert.equal(textOf(stillThere, 2).as, "waiting", "but ZY's click decides, not the flag");
});

test("an edit is checked exactly the way the drafted payload is", () => {
  assert.throws(() => payloadFromEdit(PAYLOAD, { "i1.date": "2026-11-01" }, CTX, TODAY), /targetDate must be 2026-11-25 or later/);
  assert.throws(() => payloadFromEdit(PAYLOAD, { "i2.date": "2026-11-24" }, CTX, TODAY), /nextTouch must be 2026-11-25 or later/);
  assert.throws(() => payloadFromEdit(PAYLOAD, { "i1.date": "2026-02-31" }, CTX, TODAY), /targetDate must be a real date like 2026-11-25/);
  assert.throws(() => payloadFromEdit(PAYLOAD, { "i1.title": "  " }, CTX, TODAY), /item 1 needs a title/);
  assert.throws(() => payloadFromEdit(PAYLOAD, { "i1.title": "T".repeat(200) }, CTX, TODAY), /item 1: the title must be 120 characters or fewer/);
  assert.throws(() => payloadFromEdit(PAYLOAD, { "i1.as": "maybe" }, CTX, TODAY), /item 1 must be one of next, waiting or skip/);
  assert.throws(() => payloadFromEdit(PAYLOAD, { parent: "demo#999" }, CTX, TODAY), /parent must be a ref from the engagements listed/);
});

test("a refusal names the item's number, so six items are six places to look", () => {
  const message = (values: Record<string, string>): string => messageOf(() => payloadFromEdit(PAYLOAD, values, CTX, TODAY));

  assert.match(message({ "i2.date": "2026-11-24" }), /^item 2: the item is not valid: nextTouch must be 2026-11-25 or later$/);
  // The card's number, whatever the skipped items did to an array index.
  assert.match(message({ "i4.date": "2026-11-01" }), /^item 4: the item is not valid: nextTouch must be 2026-11-25 or later$/);
});

test("an edit that leaves a date alone keeps that date's past-due caution", () => {
  const payload = noteItems(note([action("ZY", "chase the quote", "2026-11-20"), action("Dana", "confirm the window")]), CTX, NOTE_URL, TODAY);
  const caution = "⚠ 1 due date was in the past: dropped, it is not written.";
  assert.equal(noteItemsCard(state({ payload })).context.includes(caution), true);

  const retitled = payloadFromEdit(payload, { "i2.title": "confirm the window with Dana" }, CTX, TODAY);
  assert.deepEqual(textOf(retitled, 0).flag, { kind: "past-due" }, "the date did not change, so the caution stands");
  assert.equal(noteItemsCard(state({ payload: retitled })).context.includes(caution), true);

  const redated = payloadFromEdit(payload, { "i1.date": "2026-12-02" }, CTX, TODAY);
  assert.equal(textOf(redated, 0).flag, null, "a new date is a new judgement");
  assert.equal(noteItemsCard(state({ payload: redated })).context.includes(caution), false);
});

test("an edit that clears the parent makes the items standalone, in the note's account", () => {
  const alone = payloadFromEdit(PAYLOAD, { parent: "_none" }, CTX, TODAY);

  assert.equal(alone.parentRef, null);
  assert.equal(draftOf(textOf(alone, 0), alone).parentRef, null);
  assert.equal(alone.account, "Acme", "the account is the note's, not the parent's");
  assert.equal(noteItemsCard(state({ payload: alone })).context.includes("puts them on the board as standalone items"), true);
});

// ---- The stored JSON --------------------------------------------------------

test("a proposal's stored JSON reads back as it was written", () => {
  assert.deepEqual(readNoteItemsPayload(JSON.stringify(PAYLOAD)), PAYLOAD);
  assert.deepEqual(readNoteItemsContext(JSON.stringify(CTX)), CTX);

  const progress = { items: [CREATED, { issue: issue(901), error: "GitHub GraphQL: nope" }] };
  assert.deepEqual(readNoteItemsProgress(JSON.stringify(progress)), progress);
  assert.deepEqual(readNoteItemsProgress(null), { items: [] }, "a row with no progress has written nothing");
});

test("a payload from another version reads as nothing, so the card says so", () => {
  const broken = [
    null,
    "",
    "not json",
    "[]",
    "{}",
    '{"v":2}',
    JSON.stringify({ ...PAYLOAD, note: { date: "2026-11-24" } }),
    JSON.stringify({ ...PAYLOAD, note: { date: "2026-11-24", url: NOTE_URL, folder: 7 } }),
    JSON.stringify({ ...PAYLOAD, account: 5 }),
    JSON.stringify({ ...PAYLOAD, candidates: "2" }),
    JSON.stringify({ ...PAYLOAD, items: [{ ...PAYLOAD.items[0], as: "maybe" }] }),
    JSON.stringify({ ...PAYLOAD, items: [{ ...PAYLOAD.items[0], flag: { kind: "somewhere" } }] }),
    JSON.stringify({ ...PAYLOAD, items: [{ ...PAYLOAD.items[0], due: 7 }] }),
  ];

  for (const json of broken) assert.equal(readNoteItemsPayload(json), null, `${String(json)} is no payload`);
});

test("a payload drawn yesterday still reads: nothing here asks what today is", () => {
  const old = { ...PAYLOAD, account: "Initech", parentRef: "demo#999", items: [{ ...textOf(PAYLOAD, 0), due: "2020-01-02" }] };
  assert.deepEqual(readNoteItemsPayload(JSON.stringify(old)), old);
});

test("a progress that cannot be read is nothing, never an empty batch", () => {
  for (const json of [
    "",
    "not json",
    "[]",
    "{}",
    '{"items":{}}',
    '{"items":[{"issue":{"id":"I_900"}}]}',
    '{"items":[{"error":5}]}',
    '{"items":[null]}',
  ]) {
    assert.equal(readNoteItemsProgress(json), null, `${JSON.stringify(json)} is no progress`);
  }

  // The one that would make a second issue: an item whose issue cannot be named.
  assert.deepEqual(readNoteItemsProgress('{"items":[{"issue":{"id":"I_900","number":900,"url":"u"},"error":null}]}'), {
    items: [{ issue: { id: "I_900", number: 900, url: "u" }, error: null }],
  });
});

// ---- Names ------------------------------------------------------------------

test("a refusal names a field, and never the account or the person it refused", () => {
  const refused = [
    () => validatePayload({ ...PAYLOAD, account: "Initech", track: "Sales" }, CTX, TODAY),
    () => payloadFromEdit(PAYLOAD, { "i1.title": "T".repeat(200), "i2.as": "maybe" }, CTX, TODAY),
    () => payloadFromEdit({ ...PAYLOAD, account: null }, { parent: "demo#999" }, CTX, TODAY),
  ];

  for (const call of refused) {
    const message = messageOf(call);
    for (const name of ["Initech", "Sales", "Dana", "Globex", "Acme", "demo#999"]) {
      assert.equal(message.includes(name), false, `"${message}" repeats no name of its own`);
    }
  }

  // And no card speaks in a name the fixtures never wrote.
  for (const one of CASES) {
    const card = noteItemsCard(one.state);
    const text = [card.head, ...card.lines, card.context].join("\n");
    for (const name of ["Initech", "Hooli", "Umbrella", "Pied Piper"]) {
      assert.equal(text.includes(name), false, `${one.name} invents no name`);
    }
  }
});
