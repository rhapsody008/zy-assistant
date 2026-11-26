// The acceptance table for the week of Mon 2026-11-23, straight from the rules
// in src/rules.ts. If one of these fails, the behaviour the CLI promises changed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, brief, rowOrder, workItems, type Brief, type Env, type Item } from "../src/rules.ts";
import { item } from "./board.ts";

const url = (ref: string): string => `https://github.com/rhapsody008/notes/issues/${ref.split("#")[1]}`;

const A = item({ id: "52", ref: "notes#52", title: "A", nextTouch: "2026-11-25", nextAction: "write the draft", waitingOn: "answers from design" });
const B = item({ id: "53", ref: "notes#53", title: "B", target: "2026-11-26" });
const C = item({ id: "54", ref: "notes#54", title: "C", target: "2026-03-16" });
const D = item({ id: "55", ref: "notes#55", title: "D", status: "Backlog", target: "2026-11-30" });
const E = item({ id: "56", ref: "notes#56", title: "E", status: "Done", target: "2026-11-24" });
const F = item({ id: "57", ref: "notes#57", title: "F" });

const BOARD: Item[] = [A, B, C, D, E];

/** The row of item `id`: the items that need action are the briefing's rows. */
const rowFor = (b: Brief, id: string) => {
  const row = b.rows.find((r) => r.itemId === id);
  assert.ok(row, `expected a briefing row for item ${id}`);
  return row;
};

test("Monday morning: one row, stale and coming-up in the briefing, quiet items absent", () => {
  const b = brief(BOARD, "2026-11-23");
  assert.deepEqual(b.rows.map((r) => r.itemId), [B.id]);
  assert.match(rowFor(b, B.id).text, /due in 3 days/);

  assert.match(b.text, /Stale dates[^\n]*notes#54/);
  assert.match(b.text, /Coming up[\s\S]*notes#55/);
  assert.ok(!b.text.includes("notes#52"), "A has nothing to say on Monday and must not appear");
  assert.ok(!b.text.includes("notes#56"), "a Done item must not appear");
});

test("Tuesday morning: B has a row, the briefing says A touches tomorrow", () => {
  const b = brief(BOARD, "2026-11-24");
  assert.deepEqual(b.rows.map((r) => r.itemId), [B.id]);
  assert.match(b.text, /notes#52[^\n]*touch tomorrow/);
});

test("Wednesday morning: A's row says touch today, B still has one", () => {
  const b = brief(BOARD, "2026-11-25");
  assert.deepEqual(b.rows.map((r) => r.itemId).sort(), [A.id, B.id].sort());
  assert.match(rowFor(b, A.id).text, /\*touch today\*/);
  assert.match(rowFor(b, A.id).text, /Next: write the draft/);
});

test("Thursday morning: B is due today, A's touch was Wednesday", () => {
  const b = brief(BOARD, "2026-11-26");
  assert.match(rowFor(b, B.id).text, /\*due today\*/);
  assert.match(rowFor(b, A.id).text, /\*touch was Wed 25 Nov\*/);
});

test("a parent issue is not a unit of work: its In-progress child is what counts", () => {
  const parent = item({ id: "ENG", ref: "notes#ENG", title: "Acme POC", target: "2026-12-15" });
  const child = item({ id: "61", title: "Sizing", parentUrl: parent.url });

  assert.deepEqual(workItems([parent, child]).map((i) => i.id), [child.id], "only the child is work");
  assert.match(brief([parent, child], "2026-11-23").text, /\*In progress:\* 1$/, "the parent does not count");
});

test("a parent whose child is Done or off the board is still a parent", () => {
  const parent = item({ id: "ENG" });
  const doneChild = item({ id: "61", parentUrl: parent.url, status: "Done" });
  assert.deepEqual(workItems([parent, doneChild]).map((i) => i.id), [doneChild.id], "a Done child still makes its issue a parent");
  assert.match(brief([parent, doneChild], "2026-11-23").text, /\*In progress:\* 0$/, "and the parent is not counted");

  const elsewhere = item({ id: "ENG2", ref: "notes#ENG2", title: "Globex POC", parentUrl: "https://github.com/acme/demo/issues/900" });
  assert.deepEqual(workItems([parent, elsewhere]).map((i) => i.id), [parent.id, elsewhere.id], "their children are not on the board");
});

test("a draft counts as work: it has no sub-issues", () => {
  const draft = item({ id: "D1", ref: "draft", url: "https://github.com/users/acme/projects/1" });
  const parent = item({ id: "ENG", url: "https://github.com/acme/demo/issues/90" });
  const child = item({ id: "61", parentUrl: parent.url });

  assert.deepEqual(workItems([parent, child, draft]).map((i) => i.id), [child.id, draft.id]);
});

test("over the WIP limit the list of what is in flight leaves the parents out", () => {
  const board = [
    item({ id: "ENG1", ref: "notes#ENG1", title: "Acme POC" }),
    item({ id: "ENG2", ref: "notes#ENG2", title: "Globex POC" }),
    item({ id: "C1", parentUrl: url("notes#ENG1") }),
    item({ id: "C2", parentUrl: url("notes#ENG1") }),
    item({ id: "C3", parentUrl: url("notes#ENG2") }),
    item({ id: "C4" }),
  ];
  const { text } = brief(board, "2026-11-23");

  assert.match(text, /\*In progress:\* 4 \(over the limit of 3: what are you dropping\?\)\nnotes#C1, notes#C2, notes#C3, notes#C4$/);
  assert.ok(!/notes#ENG[12]/.test(text), "the engagements are not what you are dropping");
});

test("four In progress items are over the WIP limit", () => {
  assert.match(brief([...BOARD, F], "2026-11-23").text, /\*In progress:\* 4 \(over the limit of 3/);
});

test("three In progress items are not over the limit", () => {
  assert.match(brief(BOARD, "2026-11-23").text, /\*In progress:\* 3$/);
});

test("a notes#5 item next to notes#52 keeps its own touch-tomorrow line", () => {
  // Refs are not unique: "notes#5" is a substring of "notes#52", and two drafts
  // both say "draft". The line must key off the item's own reasons.
  const long = item({ id: "52", ref: "notes#52", title: "Long", target: "2026-11-25" });
  const short = item({ id: "5", ref: "notes#5", title: "Short", nextTouch: "2026-11-25" });
  const draftDue = item({ id: "D1", ref: "draft", title: "Draft due", target: "2026-11-25" });
  const draftTouch = item({ id: "D2", ref: "draft", title: "Draft touch", nextTouch: "2026-11-25" });

  const { text } = brief([long, short, draftDue, draftTouch], "2026-11-24");
  const touchLines = text.split("\n").filter((line) => line.includes("touch tomorrow"));

  assert.equal(touchLines.length, 2, "notes#5 and the draft each get a line");
  assert.ok(touchLines.some((line) => line.includes("notes#5>")), "notes#5 is not swallowed by notes#52");
  assert.ok(touchLines.some((line) => line.includes("|draft>")), "the draft is not swallowed by the other draft");
});

test("an item already due tomorrow has no duplicate touch-tomorrow line", () => {
  const due = item({ id: "60", ref: "notes#60", target: "2026-11-25", nextTouch: "2026-11-25" });
  const { text } = brief([due], "2026-11-24");
  assert.ok(!text.includes("touch tomorrow"));
  assert.match(text, /notes#60[^\n]*due in 1 day/);
});

test("a Work type's heads stretch the Coming up line, in place of the default T-7", () => {
  // Wednesday 2026-11-25. The POC is 6 days out: too far for the default
  // soonDays (4..7 is by days-left, so 6 is inside) but the item that has no
  // type at all stays inside it too. Eight days out separates them.
  const poc = item({ id: "70", type: "POC", target: "2026-12-03" }); // 8 days
  const plain = item({ id: "71", target: "2026-12-03" });
  const b = brief([poc, plain], "2026-11-25");

  assert.deepEqual(b.rows, [], "T-8 is no row for either");
  const soon = b.text.split("\n").filter((line) => line.includes("due Thu 3 Dec"));
  assert.equal(soon.length, 1, "only the POC reaches T-14");
  assert.match(soon[0], /notes#70/);
});

test("a Work type the policy does not know keeps soonDays and has no milestone", () => {
  const chore = item({ id: "72", type: "Chore", target: "2026-12-03" }); // 8 days, outside 4..7
  assert.ok(!brief([chore], "2026-11-25").text.includes("Coming up"));

  const soon = item({ id: "73", type: "Chore", target: "2026-11-30" }); // 5 days, inside
  assert.match(brief([soon], "2026-11-25").text, /notes#73[^\n]*due Mon 30 Nov/);
});

test("a Workshop is pinged on its milestone days, at T-14 and T-7", () => {
  const workshop = item({ id: "80", type: "Workshop", target: "2026-12-07" }); // 14 days
  const b = brief([workshop], "2026-11-23");

  assert.deepEqual(b.rows.map((r) => r.itemId), [workshop.id]);
  assert.match(rowFor(b, workshop.id).text, /Work 80: Workshop in 14 days \(Mon 7 Dec\)/);
  assert.match(b.text, /\*Today\*[\s\S]*Workshop in 14 days/);
  assert.ok(!b.text.includes("Coming up"), "the row says it: no second line");

  // T-13 is neither a milestone nor a row; it is a Coming up line.
  const dayBefore = brief([{ ...workshop, target: "2026-12-06" }], "2026-11-23");
  assert.deepEqual(dayBefore.rows, []);
  assert.match(dayBefore.text, /Coming up[\s\S]*notes#80[^\n]*due Sun 6 Dec/);

  // T-7 is the second milestone.
  const weekOut = brief([{ ...workshop, target: "2026-11-30" }], "2026-11-23");
  assert.match(rowFor(weekOut, workshop.id).text, /Workshop in 7 days \(Mon 30 Nov\)/);
});

test("a milestone has a row whatever the status", () => {
  const next = item({ id: "81", type: "POC", status: "Next", target: "2026-11-30" }); // T-7
  assert.deepEqual(brief([next], "2026-11-23").rows.map((r) => r.itemId), [next.id]);
});

test("inside the deadline ladder a Workshop is still an ordinary due-in row", () => {
  const workshop = item({ id: "82", type: "Workshop", target: "2026-11-25" }); // T-2
  assert.match(rowFor(brief([workshop], "2026-11-23"), workshop.id).text, /due in 2 days \(Wed 25 Nov\)/);
});

test("the lead time is Policy data, not a constant", () => {
  const workshop = item({ id: "83", type: "Workshop", target: "2026-12-14" }); // 21 days
  assert.deepEqual(brief([workshop], "2026-11-23").rows, []);

  const custom = brief([workshop], "2026-11-23", { policy: { leadByType: { Workshop: { heads: 21, milestones: [21] } } } });
  assert.deepEqual(custom.rows.map((r) => r.itemId), [workshop.id]);
  assert.match(custom.rows[0].text, /Workshop in 21 days \(Mon 14 Dec\)/);
});

test("a Waiting item nobody touched for more than waitingChaseDays is chased", () => {
  const waiting = item({ id: "90", status: "Waiting", waitingOn: "Acme", updatedAt: "2026-11-19T00:00:00.000Z" }); // 6 days
  assert.match(rowFor(brief([waiting], "2026-11-25"), waiting.id).text, /Work 90: chase Acme\?/);
});

test("a Waiting item with nothing to name is chased anyway", () => {
  const waiting = item({ id: "91", status: "Waiting", updatedAt: "2026-11-01T00:00:00.000Z" });
  assert.match(rowFor(brief([waiting], "2026-11-25"), waiting.id).text, /chase them\?/);
});

test("a Waiting item inside waitingChaseDays is not chased", () => {
  const fresh = item({ id: "92", status: "Waiting", updatedAt: "2026-11-20T00:00:00.000Z" }); // exactly 5 days
  assert.deepEqual(brief([fresh], "2026-11-25").rows, []);
});

test("a Waiting item whose Next touch is due has a touch row, not a chase", () => {
  const due = item({ id: "93", status: "Waiting", waitingOn: "Acme", nextTouch: "2026-11-25", updatedAt: "2026-11-01T00:00:00.000Z" });
  const b = brief([due], "2026-11-25");
  assert.equal(b.rows.length, 1);
  const row = rowFor(b, due.id);
  assert.match(row.text, /\*touch today\*/);
  assert.ok(!row.text.includes("chase"));
});

test("a Waiting item with a future Next touch is left alone until then", () => {
  const later = item({ id: "94", status: "Waiting", waitingOn: "Globex", nextTouch: "2026-11-30", updatedAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(brief([later], "2026-11-25").rows, []);
});

test("Friday briefs the Pipeline: an open Stage nobody touched for stageStaleDays", () => {
  const stale = item({ id: "95", stage: "POC", updatedAt: "2026-10-28T00:00:00.000Z" }); // 30 days
  assert.match(brief([stale], "2026-11-27").text, /\*Pipeline\*\n• notes#95 Work 95: in POC, no update for 30 days/);
});

test("the Pipeline section is Friday's, and only for the open stages", () => {
  const stale = item({ id: "96", stage: "Discovery", updatedAt: "2026-10-28T00:00:00.000Z" }); // 30 days
  assert.match(brief([stale], "2026-11-27").text, /Pipeline/, "Friday, and stale enough");
  assert.ok(!brief([stale], "2026-11-26").text.includes("Pipeline"), "not on a Thursday");

  const exactly = item({ id: "97", stage: "Discovery", updatedAt: "2026-11-06T00:00:00.000Z" }); // 21 days
  assert.ok(!brief([exactly], "2026-11-27").text.includes("Pipeline"), "21 is not more than 21");

  const closed = item({ id: "98", stage: "Won", updatedAt: "2026-10-01T00:00:00.000Z" });
  const bare = item({ id: "99", updatedAt: "2026-10-01T00:00:00.000Z" });
  assert.ok(
    !brief([closed, bare], "2026-11-27").text.includes("Pipeline"),
    "Won is not the pipeline, and an item without a Stage is not either",
  );
});

test("a Done item never reaches the Pipeline, however stale", () => {
  const done = item({ id: "99", status: "Done", stage: "POC", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.ok(!brief([done], "2026-11-27").text.includes("Pipeline"));
});

test("the Pipeline honours stageStaleDays and pipelineStages from the policy", () => {
  const stale = item({ id: "A1", stage: "Proposal", updatedAt: "2026-11-10T00:00:00.000Z" }); // 17 days
  assert.ok(!brief([stale], "2026-11-27").text.includes("Pipeline"), "17 days is inside the default 21");

  const strict = brief([stale], "2026-11-27", { policy: { stageStaleDays: 14 } });
  assert.match(strict.text, /in Proposal, no update for 17 days/);

  const onlyPoc = brief([stale], "2026-11-27", { policy: { pipelineStages: ["POC"] } });
  assert.ok(!onlyPoc.text.includes("Pipeline"));
});

test("Friday briefs the Learning cadence, with the age of the last update", () => {
  const quiet = item({ id: "B1", track: "Learn", cadence: "2/week", updatedAt: "2026-11-24T00:00:00.000Z" });
  const old = item({ id: "B2", track: "Learn", cadence: "1/week", updatedAt: "2026-11-19T00:00:00.000Z" });
  const { text } = brief([quiet, old], "2026-11-27");

  assert.match(text, /\*Learning\*\n• notes#B1 Work B1: cadence 2\/week, last update Tue 24 Nov \(this week\)/);
  assert.match(text, /• notes#B2 Work B2: cadence 1\/week, last update Thu 19 Nov \(8 days ago\)/);
});

test("Learning is Friday's, needs a cadence, and is not paged for other tracks", () => {
  const learn = item({ id: "B3", track: "Learn", cadence: "daily", updatedAt: "2026-11-20T00:00:00.000Z" });
  assert.ok(!brief([learn], "2026-11-26").text.includes("Learning"));

  const build = item({ id: "B4", track: "Build", cadence: "daily", updatedAt: "2026-11-20T00:00:00.000Z" });
  const noCadence = item({ id: "B5", track: "Learn", updatedAt: "2026-11-20T00:00:00.000Z" });
  assert.ok(!brief([build, noCadence], "2026-11-27").text.includes("Learning"));
});

test("over the WIP limit the briefing names the items in flight", () => {
  const board = [item({ id: "C1" }), item({ id: "C2" }), item({ id: "C3" }), item({ id: "C4" })];
  assert.match(
    brief(board, "2026-11-23").text,
    /\*In progress:\* 4 \(over the limit of 3: what are you dropping\?\)\nnotes#C1, notes#C2, notes#C3, notes#C4/,
  );

  const { text } = brief(board.slice(0, 3), "2026-11-23");
  assert.match(text, /\*In progress:\* 3$/);
  assert.ok(!text.includes("notes#C1"), "under the limit there is nothing to drop");
});

test("Policy overrides the status names, the day windows and the WIP limit", () => {
  const doing = item({ id: "73", status: "Doing", target: "2026-11-25" });
  const board = [doing, item({ id: "74", status: "Doing" }), item({ id: "75", status: "Doing" })];

  const defaults = brief(board, "2026-11-25");
  assert.match(defaults.text, /\*In progress:\* 0/, "Doing is not In progress by default");
  assert.deepEqual(defaults.rows.map((r) => r.itemId), [doing.id], "but being due today is a row whatever the status");

  const custom = brief(board, "2026-11-25", { policy: { inProgress: "Doing", wipLimit: 2 } });
  assert.deepEqual(custom.rows.map((r) => r.itemId), [doing.id]);
  assert.match(custom.text, /\*In progress:\* 3 \(over the limit of 2/);

  const short = brief([item({ id: "76", target: "2026-11-30" })], "2026-11-25", { policy: { pingDays: 7 } });
  assert.deepEqual(short.rows.map((r) => r.itemId), ["76"], "pingDays 7 reaches 5 days out");
});

// ---- the briefing's rows: their order -------------------------------

const envFor = (today: string, board: string[]): Env => ({
  today,
  policy: DEFAULT_POLICY,
  index: new Map(board.map((id, at) => [id, at])),
});

test("a row's tier is late, today, due soon, a chase, then a milestone", () => {
  const env = envFor("2026-11-25", []);
  const tier = (fields: Partial<Item>): number => rowOrder(item({ id: "x", ...fields }), env)[0];

  assert.equal(tier({ target: "2026-11-20" }), 0, "an overdue target");
  assert.equal(tier({ nextTouch: "2026-11-24" }), 0, "a touch in the past");
  assert.equal(tier({ target: "2026-11-25" }), 1, "due today");
  assert.equal(tier({ nextTouch: "2026-11-25" }), 1, "touch today");
  assert.equal(tier({ target: "2026-11-27" }), 2, "due in 2");
  assert.equal(tier({ status: "Waiting" }), 3, "a chase, when no date is due");
  assert.equal(tier({ type: "POC", target: "2026-12-02" }), 4, "a T-7 heads-up");
  assert.equal(tier({ target: "2026-11-25", nextTouch: "2026-11-20" }), 0, "the most urgent reason wins");
});

test("a target past staleDays never drags a row to the top: the touch decides instead", () => {
  const env = envFor("2026-11-25", []);
  // 55 days overdue: targetStale says it, targetDue does not, so it is no late row.
  const stale = item({ id: "x", target: "2026-10-01", nextTouch: "2026-11-25" });
  assert.deepEqual(rowOrder(stale, env), [1, "2026-11-25", 0], "the touch today puts it in tier 1");

  // The bound is targetDue's own: the last day of staleDays is still a late row.
  const edge = item({ id: "x", target: "2026-11-11" });
  assert.deepEqual(rowOrder(edge, env), [0, "2026-11-11", 0], "14 days overdue is still tier 0");
  const past = item({ id: "x", target: "2026-11-10" });
  assert.deepEqual(rowOrder(past, env), [3, "2026-11-25", 0], "15 days overdue is no late row at all");
});

test("a milestone decides the tier only when nothing else puts the row there", () => {
  const env = envFor("2026-11-25", []);
  // Waiting and chased with no Next touch, and a POC at T-7: the chase wins.
  const chased = item({ id: "x", status: "Waiting", type: "POC", target: "2026-12-02", updatedAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(rowOrder(chased, env)[0], 3, "a chase is tier 3, not a heads-up");

  // The same item, updated within the window, is no chase: the milestone decides.
  const headsUp = { ...chased, updatedAt: "2026-11-24T00:00:00.000Z" };
  assert.equal(rowOrder(headsUp, env)[0], 4, "nothing else fires, so the milestone is the reason");
});

test("within a tier the date sorts first, then the board's order", () => {
  const env = envFor("2026-11-25", ["b", "a", "c"]);
  const order = (fields: Partial<Item>): [number, string, number] => rowOrder(item({ id: "x", ...fields }), env);

  assert.deepEqual(order({ id: "a", target: "2026-11-25" }), [1, "2026-11-25", 1]);
  assert.deepEqual(order({ id: "b", target: "2026-11-25" }), [1, "2026-11-25", 0]);
  assert.deepEqual(order({ id: "c", target: "2026-11-20" }), [0, "2026-11-20", 2]);
  assert.deepEqual(order({ id: "c", status: "Waiting" }), [3, "2026-11-25", 2], "a chase has no date of its own");
  assert.deepEqual(order({ id: "off", target: "2026-11-27" }), [2, "2026-11-27", 0], "an item off the board sorts first");
});

test("the briefing's rows come in rowOrder, not in the board's order", () => {
  const chase = item({ id: "1", status: "Waiting", updatedAt: "2026-10-01T00:00:00.000Z" });
  const milestone = item({ id: "2", type: "POC", target: "2026-12-02" }); // T-7
  const soon = item({ id: "3", target: "2026-11-27" }); // T-2
  const touchToday = item({ id: "4", nextTouch: "2026-11-25" });
  const dueToday = item({ id: "5", target: "2026-11-25" });
  const lateTouch = item({ id: "6", nextTouch: "2026-11-18" });
  const overdue = item({ id: "7", target: "2026-11-20" });

  const { rows } = brief([chase, milestone, soon, touchToday, dueToday, lateTouch, overdue], "2026-11-25");
  assert.deepEqual(rows.map((row) => row.itemId), ["6", "7", "4", "5", "3", "1", "2"]);
});

test("a Next item due today gets a row, though it is not In progress", () => {
  const next = item({ id: "77", status: "Next", target: "2026-11-25" });
  const b = brief([next], "2026-11-25");

  assert.match(rowFor(b, next.id).text, /\*due today\*/);
  assert.match(b.text, /• <[^>]*notes#77> Work 77: \*due today\*/);
});

test("the plain text is the head, the rows and the tail, in that order", () => {
  const b = brief(BOARD, "2026-11-23");

  assert.equal(b.head[0], "*Morning briefing, Mon 23 Nov*");
  assert.equal(b.head.at(-1), "*Today*");
  assert.equal(b.rows.length, 1);
  assert.match(b.tail[0], /^\*Coming up\*/);
  assert.match(b.tail.at(-1) ?? "", /^\*In progress:\* 3$/);
  assert.equal(b.text, [...b.head.slice(0, -1), ["*Today*", ...b.rows.map((row) => `• ${row.text}`)].join("\n"), ...b.tail].join("\n\n"));
});
