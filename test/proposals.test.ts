// The generic proposal machinery, pinned: a click is the approval, so the claim,
// the apply, the progress a retry continues from, and every redraw are driven
// over a fake kind, a fake card ui and the fake store. No network, no Slack, no
// timers, no clock. Synthetic names only: "Acme", "Globex", "demo".

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseProposalValue,
  proposalClick,
  proposalEdited,
  proposalValue,
  type Card,
  type EditField,
  type ProposalClick,
  type ProposalDeps,
  type ProposalEdit,
  type ProposalSpec,
  type ProposalUi,
} from "../src/proposals.ts";
import type { Proposal, ProposalStatus, ProposalStore } from "../src/store.ts";
import { FakeProposals, Gate } from "./fakes.ts";

/** Wed 2026-11-25, 09:00 in Singapore. */
const NOW = new Date("2026-11-25T01:00:00Z");
const ID = "add:1700000000.000100";
const OWNER = "U_ZY";
const TITLE = "Acme renewal · renew the Globex pilot";
const SENTENCE = "renew the Globex pilot for Acme before the demo";

/** The one input of the fake kind's modal. */
const FIELD: EditField = { kind: "text", name: "title", label: "Title", value: TITLE, required: true, maxLength: 120 };

/** The fake kind's card: the status and the last failure are what it says. */
function cardFor(proposal: Proposal): Card {
  const failed = proposal.error === null ? "" : ` · failed: ${proposal.error}`;
  return {
    head: "*New board item*",
    lines: [TITLE, "Account: Acme · Track: Customer"],
    context: `proposal is ${proposal.status}${failed}`,
    buttons: proposal.status === "open" ? ["create", "edit", "cancel"] : [],
  };
}

/** A kind whose apply the test drives: it writes, it fails, or it waits on a gate. */
class FakeSpec implements ProposalSpec {
  readonly store: ProposalStore;
  readonly applies: Proposal[] = [];
  /** What the row's status was when each apply started: the claim has to be in it. */
  readonly statusAtApply: ProposalStatus[] = [];
  /** The progress the store held before each write: the write before it was saved. */
  readonly progressBeforeWrite: Array<string | null> = [];
  gate: Gate | null = null;
  /** When set, the next apply throws this, once. */
  failure: Error | null = null;
  /** When set, the next edited throws this, once: the reason the edit is refused. */
  refusal: Error | null = null;
  /** Runs inside the apply, so a test can change the world while a write is in flight. */
  onApply: (() => void) | null = null;

  constructor(store: ProposalStore) {
    this.store = store;
  }

  card(proposal: Proposal): Card {
    return cardFor(proposal);
  }

  editFields(): EditField[] {
    return [FIELD];
  }

  edited(_proposal: Proposal, values: Record<string, string | null>): string {
    const refusal = this.refusal;
    if (refusal !== null) {
      this.refusal = null;
      throw refusal;
    }
    return JSON.stringify(values);
  }

  async apply(proposal: Proposal, save: (progress: string) => void): Promise<void> {
    this.applies.push(proposal);
    this.statusAtApply.push(this.store.findProposal(proposal.id)?.status ?? "drafting");
    this.onApply?.();
    if (this.gate !== null) await this.gate.wait();
    const failure = this.failure;
    if (failure !== null) {
      this.failure = null;
      throw failure;
    }
    // Two writes, each saved before the next one: this is what a retry reads.
    for (const step of ["one", "two"]) {
      this.progressBeforeWrite.push(this.store.findProposal(proposal.id)?.progress ?? null);
      save(JSON.stringify({ step }));
    }
  }
}

/** Every call the machinery makes, in order, so a test can say what it did. */
class FakeUi implements ProposalUi {
  readonly redraws: Array<{ card: Card; rev: number }> = [];
  readonly reposts: Array<{ card: Card; rev: number }> = [];
  readonly replies: string[] = [];
  readonly modals: Array<{ id: string; rev: number; fields: EditField[] }> = [];
  /** When set, every redraw is refused: Slack will not take the blocks. */
  failRedraw = false;

  async redraw(card: Card, rev: number): Promise<void> {
    if (this.failRedraw) throw new Error("invalid_blocks");
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

function harness(options: { status?: ProposalStatus; rev?: number } = {}) {
  const store = new FakeProposals();
  store.recordProposal({ id: ID, kind: "add", source: SENTENCE, createdAt: NOW.toISOString() });
  const stored = store.findProposal(ID);
  if (stored === null) throw new Error("the harness stored no proposal");
  stored.status = options.status ?? "open";
  stored.rev = options.rev ?? 0;
  stored.payload = JSON.stringify({ title: TITLE });
  const spec = new FakeSpec(store);
  const ui = new FakeUi();
  const logs: string[] = [];
  const deps: ProposalDeps = {
    store,
    specs: { add: spec },
    userId: OWNER,
    now: () => NOW,
    log: (line) => logs.push(line),
  };
  return { store, spec, ui, logs, deps };
}

/** The row as the fake store holds it: the same object it mutates in place. */
function rowOf(store: FakeProposals): Proposal {
  const row = store.findProposal(ID);
  if (row === null) throw new Error("the proposal is not in the store");
  return row;
}

const click = (ui: ProposalUi, overrides: Partial<ProposalClick> = {}): ProposalClick => ({
  action: "create",
  id: ID,
  rev: 0,
  userId: OWNER,
  triggerId: "trig-1",
  ui,
  ...overrides,
});

const submit = (ui: ProposalUi, overrides: Partial<ProposalEdit> = {}): ProposalEdit => ({
  id: ID,
  rev: 0,
  userId: OWNER,
  values: { title: "Globex pilot" },
  ui,
  ...overrides,
});

test("Create claims the proposal before it writes, saves progress, and ends done", async () => {
  const { deps, spec, ui, store, logs } = harness();

  await proposalClick(deps, click(ui));

  assert.deepEqual(spec.statusAtApply, ["applying"], "the claim is in the store before the first write");
  assert.deepEqual(
    spec.progressBeforeWrite,
    [null, JSON.stringify({ step: "one" })],
    "each write follows a save of the one before it",
  );
  assert.deepEqual(
    ui.redraws.map((entry) => [entry.card.context, entry.rev]),
    [
      ["proposal is applying", 0],
      ["proposal is done", 0],
    ],
    "the interim card, then the outcome",
  );
  assert.deepEqual(ui.replies, [], "the card carries the outcome when Slack takes it");
  assert.equal(rowOf(store).status, "done");
  assert.equal(rowOf(store).error, null);
  assert.deepEqual(logs, []);
});

test("a double click applies once: the second click finds it applying and writes nothing", async () => {
  const { deps, spec, ui, store, logs } = harness();
  const gate = new Gate();
  spec.gate = gate;

  const first = proposalClick(deps, click(ui));
  await gate.entered;
  await proposalClick(deps, click(ui));

  assert.deepEqual(logs, [`proposal ${ID}: already applying, this click does nothing`]);
  assert.equal(ui.redraws.length, 1, "the interim card, and nothing drawn by the second click");
  gate.open();
  await first;

  assert.equal(spec.applies.length, 1, "one apply, however many clicks");
  assert.equal(rowOf(store).status, "done");
});

test("a click on a finished proposal draws it as it is and writes nothing", async () => {
  const { deps, spec, ui, store, logs } = harness({ status: "done" });
  const before = { ...rowOf(store) };

  await proposalClick(deps, click(ui));

  assert.deepEqual(logs, [`proposal ${ID}: already done, this click does nothing`]);
  assert.deepEqual(ui.redraws, [{ card: cardFor(before), rev: 0 }]);
  assert.equal(spec.applies.length, 0, "the kind was not asked to write");
  assert.deepEqual(rowOf(store), before, "the row is untouched");
});

test("a click on a card that has moved on draws the current one and writes nothing", async () => {
  const { deps, spec, ui, store, logs } = harness({ rev: 2 });

  await proposalClick(deps, click(ui, { rev: 1 }));

  assert.deepEqual(logs, [`proposal ${ID}: stale rev 1, the card has moved on`]);
  assert.deepEqual(ui.redraws.map((entry) => entry.rev), [2], "the card as the row is now");
  assert.deepEqual(ui.replies, ["that card was out of date: this is the current draft"]);
  assert.equal(spec.applies.length, 0);
  assert.equal(rowOf(store).status, "open");
  assert.equal(rowOf(store).rev, 2);
});

test("a click from anyone but ZY does nothing at all", async () => {
  const { deps, spec, ui, store, logs } = harness();
  const before = { ...rowOf(store) };

  await proposalClick(deps, click(ui, { userId: "U_SOMEONE" }));

  assert.deepEqual(logs, []);
  assert.deepEqual(ui.redraws, []);
  assert.deepEqual(ui.replies, []);
  assert.equal(spec.applies.length, 0);
  assert.deepEqual(rowOf(store), before);
});

test("Edit opens the modal on the spec's fields and the current rev, and writes nothing", async () => {
  const { deps, ui, store, logs } = harness({ rev: 1 });

  await proposalClick(deps, click(ui, { action: "edit", rev: 1 }));

  assert.deepEqual(ui.modals, [{ id: ID, rev: 1, fields: [FIELD] }]);
  assert.deepEqual(ui.redraws, [], "an edit is not an outcome to draw");
  assert.equal(rowOf(store).rev, 1);
  assert.equal(rowOf(store).status, "open");
  assert.deepEqual(logs, []);
});

test("Cancel stops an open proposal and draws it as cancelled", async () => {
  const { deps, ui, store, logs } = harness();

  await proposalClick(deps, click(ui, { action: "cancel" }));

  assert.equal(rowOf(store).status, "cancelled");
  assert.deepEqual(ui.redraws.map((entry) => entry.card.context), ["proposal is cancelled"]);
  assert.deepEqual(logs, [`proposal ${ID}: cancelled by ${OWNER}`]);
});

test("a Cancel racing a Create loses: the create applies once and the cancel writes nothing", async () => {
  const { deps, spec, ui, store, logs } = harness();
  const gate = new Gate();
  spec.gate = gate;

  const applying = proposalClick(deps, click(ui));
  await gate.entered;
  await proposalClick(deps, click(ui, { action: "cancel" }));

  assert.deepEqual(logs, [`proposal ${ID}: already applying, this click does nothing`]);
  assert.equal(rowOf(store).status, "applying", "the cancel changed nothing");
  gate.open();
  await applying;

  assert.equal(spec.applies.length, 1);
  assert.equal(rowOf(store).status, "done");
});

test("a failed apply reopens the proposal with the error, and a retry applies again", async () => {
  const { deps, spec, ui, store, logs } = harness();
  spec.failure = new Error("the board is down");

  await proposalClick(deps, click(ui));

  assert.equal(rowOf(store).status, "open", "the card keeps its buttons");
  assert.equal(rowOf(store).error, "the board is down");
  assert.equal(ui.redraws.at(-1)?.card.context, "proposal is open · failed: the board is down");
  assert.deepEqual(logs, [`proposal ${ID}: apply failed`], "the reason goes to the card, which is ZY's view");

  await proposalClick(deps, click(ui, { action: "retry" }));

  assert.equal(spec.applies.length, 2, "a retry after a failure is a second apply");
  assert.equal(rowOf(store).status, "done");
  assert.equal(rowOf(store).error, null);
});

test("an apply failure's reason reaches the card and never the log", async () => {
  const { deps, spec, ui, store, logs } = harness();
  // What a kind's own error can carry: an Account option is a real customer name.
  spec.failure = new Error("the board has no Account option Acme");

  await proposalClick(deps, click(ui));

  assert.equal(rowOf(store).error, "the board has no Account option Acme", "the card is ZY's own view");
  assert.match(ui.redraws.at(-1)?.card.context ?? "", /Acme/);
  assert.deepEqual(logs, [`proposal ${ID}: apply failed`]);
  assert.equal(logs.join("\n").includes("Acme"), false, "no log line carries the reason");
});

test("an outcome Slack will not draw reaches ZY as text, and the write still counts", async () => {
  const { deps, spec, ui, store, logs } = harness();
  spec.onApply = () => {
    ui.failRedraw = true;
  };

  await proposalClick(deps, click(ui));

  assert.equal(rowOf(store).status, "done", "a refused redraw never turns a write into a failure");
  assert.equal(ui.redraws.length, 1, "the interim card, drawn before Slack gave up");
  const done = cardFor(rowOf(store));
  assert.deepEqual(ui.replies, [[done.head, ...done.lines, done.context].join("\n")]);
  assert.match(logs.join("\n"), new RegExp(`proposal ${ID}: the redraw failed: invalid_blocks`));
});

test("an edit stores the spec's payload, bumps the rev and draws the new card", async () => {
  const { deps, spec, ui, store, logs } = harness();

  await proposalEdited(deps, submit(ui, { values: { title: "Globex pilot" } }));

  assert.equal(rowOf(store).payload, JSON.stringify({ title: "Globex pilot" }));
  assert.equal(rowOf(store).rev, 1);
  assert.deepEqual(ui.redraws.map((entry) => entry.rev), [1], "the card at the rev it was stored at");
  assert.equal(spec.applies.length, 0, "an edit writes nothing");
  assert.deepEqual(logs, [`proposal ${ID}: edit rev 0 by ${OWNER}`]);
});

test("an edit of a proposal that is over says the card moved on and stores nothing", async () => {
  const { deps, ui, store } = harness({ status: "done" });
  const before = { ...rowOf(store) };

  await proposalEdited(deps, submit(ui));

  assert.deepEqual(ui.replies, ["this card has moved on: nothing was changed"]);
  assert.deepEqual(ui.redraws.map((entry) => entry.rev), [0], "a finished card is drawn as it stands");
  assert.deepEqual(rowOf(store), before);
});

test("an edit from a modal opened on an older rev says the card moved on, and stores nothing", async () => {
  const { deps, ui, store } = harness({ rev: 2 });
  const before = { ...rowOf(store) };

  await proposalEdited(deps, submit(ui, { rev: 1 }));

  assert.deepEqual(ui.replies, ["this card has moved on: nothing was changed"]);
  assert.deepEqual(rowOf(store), before, "the modal's rev is the one the store checks");
});

test("an edit the kind refuses says why, and leaves the card and the store as they were", async () => {
  const { deps, spec, ui, store, logs } = harness();
  spec.refusal = new Error("a title is one line");
  const before = { ...rowOf(store) };

  await proposalEdited(deps, submit(ui));

  assert.deepEqual(ui.replies, ["a title is one line"], "the kind's own reason reaches ZY");
  assert.deepEqual(ui.redraws, [{ card: cardFor(before), rev: 0 }], "the card as it was");
  assert.deepEqual(rowOf(store), before);
  assert.match(logs.join("\n"), /the edit was refused: a title is one line/);
});

test("an edit whose redraw Slack refuses is reposted at the same rev", async () => {
  const { deps, ui, store } = harness();
  ui.failRedraw = true;

  await proposalEdited(deps, submit(ui, { values: { title: "Globex pilot" } }));

  assert.equal(rowOf(store).rev, 1, "the edit is stored whatever Slack does");
  assert.deepEqual(ui.reposts, [{ card: cardFor(rowOf(store)), rev: 1 }]);
});

test("a kind this deployment cannot apply says so and does nothing", async () => {
  const { deps, ui, store, logs } = harness();
  rowOf(store).kind = "calendar";

  await proposalClick(deps, click(ui));
  await proposalClick(deps, click(ui, { action: "edit" }));
  await proposalEdited(deps, submit(ui));

  assert.deepEqual(ui.redraws, []);
  assert.deepEqual(ui.modals, []);
  assert.equal(rowOf(store).status, "open");
  assert.deepEqual(logs, [
    `proposal ${ID}: kind calendar is not one this bot applies, this click does nothing`,
    `proposal ${ID}: kind calendar is not one this bot applies, this click does nothing`,
    `proposal ${ID}: kind calendar is not one this bot applies, this edit does nothing`,
  ]);
});

test("a kind with no edit is a log line, and no modal", async () => {
  const { deps, ui, store, logs } = harness();
  const createOnly: ProposalSpec = { card: cardFor, apply: async () => {} };
  deps.specs.add = createOnly;

  await proposalClick(deps, click(ui, { action: "edit" }));
  await proposalEdited(deps, submit(ui));

  assert.deepEqual(ui.modals, []);
  assert.equal(rowOf(store).rev, 0);
  assert.deepEqual(logs, [
    `proposal ${ID}: kind add cannot be edited, this click does nothing`,
    `proposal ${ID}: kind add cannot be edited, this edit does nothing`,
  ]);
});

test("a button's value round-trips, and an id may hold the separator", () => {
  assert.equal(proposalValue(ID, 3), `${ID}|3`);
  assert.deepEqual(parseProposalValue(proposalValue(ID, 3)), { id: ID, rev: 3 });
  const odd = "calendar|meeting|note";
  assert.deepEqual(parseProposalValue(proposalValue(odd, 0)), { id: odd, rev: 0 }, "the split is at the last one");
  assert.equal(parseProposalValue(`${ID}|two`), null, "a rev is a number");
  assert.equal(parseProposalValue(`${ID}|`), null);
  assert.equal(parseProposalValue(""), null);
  assert.equal(parseProposalValue(null), null);
  assert.equal(parseProposalValue("|3"), null, "an empty id names no proposal");
});

test("every log line names ids only: no title, no sentence, no payload", async () => {
  const { deps, spec, ui, logs } = harness();

  await proposalClick(deps, click(ui, { id: "add:unknown" }));
  await proposalClick(deps, click(ui, { rev: 9 }));
  spec.failure = new Error("the board is down");
  await proposalClick(deps, click(ui));
  await proposalClick(deps, click(ui, { action: "retry" }));
  await proposalClick(deps, click(ui, { action: "cancel" }));
  spec.refusal = new Error("a title is one line");
  await proposalEdited(deps, submit(ui));
  ui.failRedraw = true;
  await proposalEdited(deps, submit(ui));
  await proposalEdited(deps, submit(ui, { id: "add:unknown" }));

  assert.ok(logs.length >= 7, `each of those paths logs: ${logs.length}`);
  for (const line of logs) {
    assert.match(line, /^proposal \S+: /, `a log line keeps to the id: ${line}`);
    assert.ok(!line.includes(TITLE), `the title is in a log line: ${line}`);
    assert.ok(!line.includes(SENTENCE), `the sentence is in a log line: ${line}`);
    assert.ok(!line.includes(JSON.stringify({ title: TITLE })), `the payload is in a log line: ${line}`);
  }
});
