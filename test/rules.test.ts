// The acceptance table for the week of Mon 2026-11-23, straight from the rules
// in src/rules.ts. If one of these fails, the behaviour the bot promises changed.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_POLICY,
  pingKey,
  plan,
  rowOrder,
  workItems,
  type Env,
  type Item,
  type Ping,
  type SentPing,
} from "../src/rules.ts";
import { item } from "./board.ts";

const url = (ref: string): string => `https://github.com/rhapsody008/notes/issues/${ref.split("#")[1]}`;

const A = item({ id: "52", ref: "notes#52", title: "A", nextTouch: "2026-11-25", nextAction: "write the draft", waitingOn: "answers from design" });
const B = item({ id: "53", ref: "notes#53", title: "B", target: "2026-11-26" });
const C = item({ id: "54", ref: "notes#54", title: "C", target: "2026-03-16" });
const D = item({ id: "55", ref: "notes#55", title: "D", status: "Backlog", target: "2026-11-30" });
const E = item({ id: "56", ref: "notes#56", title: "E", status: "Done", target: "2026-11-24" });
const F = item({ id: "57", ref: "notes#57", title: "F" });

const BOARD: Item[] = [A, B, C, D, E];

const pings = (items: Item[], date: string, slot: "M" | "E", history: SentPing[] = []) => plan(items, date, slot, history);
const byItem = (result: ReturnType<typeof plan>, id: string) => {
  const ping = result.pings.find((p) => p.itemId === id);
  assert.ok(ping, `expected a ping for item ${id}`);
  return ping;
};
/** The morning's rows: the items that need action, in the briefing's order. */
const rows = (result: ReturnType<typeof plan>): Ping[] => result.briefing?.rows ?? [];
const rowFor = (result: ReturnType<typeof plan>, id: string) => {
  const row = rows(result).find((p) => p.itemId === id);
  assert.ok(row, `expected a briefing row for item ${id}`);
  return row;
};
const text = (result: ReturnType<typeof plan>): string => result.briefing?.text ?? "";

test("Monday morning: one row, stale and coming-up in the briefing, quiet items absent", () => {
  const result = pings(BOARD, "2026-11-23", "M");
  assert.deepEqual(result.pings, [], "the morning sends the briefing alone");
  assert.deepEqual(rows(result).map((p) => p.itemId), [B.id]);
  assert.match(rowFor(result, B.id).text, /due in 3 days/);

  assert.match(text(result), /Stale dates[^\n]*notes#54/);
  assert.match(text(result), /Coming up[\s\S]*notes#55/);
  assert.ok(!text(result).includes("notes#52"), "A has nothing to say on Monday and must not appear");
  assert.ok(!text(result).includes("notes#56"), "a Done item must not appear");
});

test("Tuesday morning: B has a row, the briefing says A touches tomorrow", () => {
  const result = pings(BOARD, "2026-11-24", "M");
  assert.deepEqual(rows(result).map((p) => p.itemId), [B.id]);
  assert.match(text(result), /notes#52[^\n]*touch tomorrow/);
});

test("Wednesday morning: A's row has touch today and the +7 action, B still has one", () => {
  const result = pings(BOARD, "2026-11-25", "M");
  assert.deepEqual(rows(result).map((p) => p.itemId).sort(), [A.id, B.id].sort());
  assert.match(rowFor(result, A.id).text, /\*touch today\*/);
  assert.ok(rowFor(result, A.id).actions.includes("touch7"));
  assert.match(rowFor(result, A.id).text, /Next: write the draft/);
});

test("Thursday morning: B is due today, A's touch was Wednesday", () => {
  const result = pings(BOARD, "2026-11-26", "M");
  assert.match(rowFor(result, B.id).text, /\*due today\*/);
  assert.match(rowFor(result, A.id).text, /\*touch was Wed 25 Nov\*/);
});

test("Thursday evening, unacked morning ping: reping with both reasons", () => {
  const morning: SentPing = {
    key: pingKey("2026-11-26", "M", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-26T01:00:00.000Z",
    ackedAt: null,
  };
  const ping = byItem(pings(BOARD, "2026-11-26", "E", [morning]), B.id);
  assert.equal(ping.kind, "reping");
  assert.match(ping.text, /due today/);
  assert.match(ping.text, /no update since this morning/);
});

test("Thursday evening, morning ping acked by button: plain ping with one reason", () => {
  const morning: SentPing = {
    key: pingKey("2026-11-26", "M", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-26T01:00:00.000Z",
    ackedAt: "2026-11-26T02:00:00.000Z",
  };
  const ping = byItem(pings(BOARD, "2026-11-26", "E", [morning]), B.id);
  assert.equal(ping.kind, "ping");
  assert.match(ping.text, /due today/);
  assert.ok(!ping.text.includes("no update since this morning"));
});

test("Thursday evening, morning acked by a board update: plain ping", () => {
  const morning: SentPing = {
    key: pingKey("2026-11-26", "M", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-26T01:00:00.000Z",
    ackedAt: null,
  };
  const touched = BOARD.map((i) => (i.id === B.id ? { ...i, updatedAt: "2026-11-26T03:00:00.000Z" } : i));
  const ping = byItem(pings(touched, "2026-11-26", "E", [morning]), B.id);
  assert.equal(ping.kind, "ping");
  assert.ok(!ping.text.includes("no update since this morning"));
});

test("Friday morning: B is one day overdue and Thursday's unacked reping warns", () => {
  const thursdayReping: SentPing = {
    key: pingKey("2026-11-26", "E", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "E",
    kind: "reping",
    sentAt: "2026-11-26T09:30:00.000Z",
    ackedAt: null,
  };
  const result = pings(BOARD, "2026-11-27", "M", [thursdayReping]);
  assert.match(rowFor(result, B.id).text, /\*overdue\* by 1 day/);
  assert.match(text(result), /⚠ \*No update\* on <[^>]*notes#53>/);
});

test("Friday morning: no warning once Thursday's reping is acked", () => {
  const thursdayReping: SentPing = {
    key: pingKey("2026-11-26", "E", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "E",
    kind: "reping",
    sentAt: "2026-11-26T09:30:00.000Z",
    ackedAt: "2026-11-26T10:00:00.000Z",
  };
  const result = pings(BOARD, "2026-11-27", "M", [thursdayReping]);
  assert.ok(!text(result).includes("⚠"), "an acked reping must not warn on Friday");
});

test("a Friday reping on A still warns on Monday", () => {
  const fridayReping: SentPing = {
    key: pingKey("2026-11-27", "E", A.id),
    itemId: A.id,
    date: "2026-11-27",
    slot: "E",
    kind: "reping",
    sentAt: "2026-11-27T09:30:00.000Z",
    ackedAt: null,
  };
  const result = pings(BOARD, "2026-11-30", "M", [fridayReping]);
  assert.match(text(result), /⚠ \*No update\* on <[^>]*notes#52>/);
});

test("two warnings on one morning follow the history's order, not the board's", () => {
  const friday = "2026-11-27";
  const reping = (i: Item, sentAt: string): SentPing => ({
    key: pingKey(friday, "E", i.id),
    itemId: i.id,
    date: friday,
    slot: "E",
    kind: "reping",
    sentAt,
    ackedAt: null,
  });
  // Friday evening pinged B first and A second; the board lists A before B.
  const history = [reping(B, "2026-11-27T09:30:00.000Z"), reping(A, "2026-11-27T09:31:00.000Z")];

  const briefing = text(pings(BOARD, "2026-11-30", "M", history));
  const warns = briefing.split("\n").filter((line) => line.startsWith("⚠"));

  assert.equal(warns.length, 2, "both unacked Friday repings warn on Monday");
  assert.match(warns[0], /notes#53/, "B is warned first: it was pinged first on Friday");
  assert.match(warns[1], /notes#52/, "A is warned second, though the board lists it first");
});

test("a parent issue is not a unit of work: its In-progress child is what counts", () => {
  const parent = item({ id: "ENG", ref: "notes#ENG", title: "Acme POC", target: "2026-12-15" });
  const child = item({ id: "61", title: "Sizing", parentUrl: parent.url });

  assert.deepEqual(workItems([parent, child]).map((i) => i.id), [child.id], "only the child is work");
  assert.match(text(pings([parent, child], "2026-11-23", "M")), /\*In progress:\* 1$/, "the parent does not count");
});

test("a parent whose child is Done or off the board is still a parent", () => {
  const parent = item({ id: "ENG" });
  const doneChild = item({ id: "61", parentUrl: parent.url, status: "Done" });
  assert.deepEqual(workItems([parent, doneChild]).map((i) => i.id), [doneChild.id], "a Done child still makes its issue a parent");
  assert.match(text(pings([parent, doneChild], "2026-11-23", "M")), /\*In progress:\* 0$/, "and the parent is not counted");

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
  const briefing = text(pings(board, "2026-11-23", "M"));

  assert.match(briefing, /\*In progress:\* 4 \(over the limit of 3: what are you dropping\?\)\nnotes#C1, notes#C2, notes#C3, notes#C4$/);
  assert.ok(!/notes#ENG[12]/.test(briefing), "the engagements are not what you are dropping");
});

test("four In progress items are over the WIP limit", () => {
  const result = pings([...BOARD, F], "2026-11-23", "M");
  assert.match(text(result), /\*In progress:\* 4 \(over the limit of 3/);
});

test("three In progress items are not over the limit", () => {
  const result = pings(BOARD, "2026-11-23", "M");
  assert.match(text(result), /\*In progress:\* 3$/);
});

test("a notes#5 item next to notes#52 keeps its own touch-tomorrow line", () => {
  // Refs are not unique: "notes#5" is a substring of "notes#52", and two drafts
  // both say "draft". The line must key off the item's own reasons.
  const long = item({ id: "52", ref: "notes#52", title: "Long", target: "2026-11-25" });
  const short = item({ id: "5", ref: "notes#5", title: "Short", nextTouch: "2026-11-25" });
  const draftDue = item({ id: "D1", ref: "draft", title: "Draft due", target: "2026-11-25" });
  const draftTouch = item({ id: "D2", ref: "draft", title: "Draft touch", nextTouch: "2026-11-25" });

  const result = pings([long, short, draftDue, draftTouch], "2026-11-24", "M");
  const touchLines = text(result).split("\n").filter((line) => line.includes("touch tomorrow"));

  assert.equal(touchLines.length, 2, "notes#5 and the draft each get a line");
  assert.ok(touchLines.some((line) => line.includes("notes#5>")), "notes#5 is not swallowed by notes#52");
  assert.ok(touchLines.some((line) => line.includes("|draft>")), "the draft is not swallowed by the other draft");
});

test("an item already due tomorrow has no duplicate touch-tomorrow line", () => {
  const due = item({ id: "60", ref: "notes#60", target: "2026-11-25", nextTouch: "2026-11-25" });
  const briefing = text(pings([due], "2026-11-24", "M"));
  assert.ok(!briefing.includes("touch tomorrow"));
  assert.match(briefing, /notes#60[^\n]*due in 1 day/);
});

test("a Work type's heads stretch the Coming up line, in place of the default T-7", () => {
  // Wednesday 2026-11-25. The POC is 6 days out: too far for the default
  // soonDays (4..7 is by days-left, so 6 is inside) but the item that has no
  // type at all stays inside it too. Eight days out separates them.
  const poc = item({ id: "70", type: "POC", target: "2026-12-03" }); // 8 days
  const plain = item({ id: "71", target: "2026-12-03" });
  const result = pings([poc, plain], "2026-11-25", "M");

  assert.deepEqual(result.pings, [], "T-8 is no ping for either");
  const soon = text(result).split("\n").filter((line) => line.includes("due Thu 3 Dec"));
  assert.equal(soon.length, 1, "only the POC reaches T-14");
  assert.match(soon[0], /notes#70/);
});

test("a Work type the policy does not know keeps soonDays and has no milestone", () => {
  const chore = item({ id: "72", type: "Chore", target: "2026-12-03" }); // 8 days, outside 4..7
  assert.ok(!text(pings([chore], "2026-11-25", "M")).includes("Coming up"));

  const soon = item({ id: "73", type: "Chore", target: "2026-11-30" }); // 5 days, inside
  assert.match(text(pings([soon], "2026-11-25", "M")), /notes#73[^\n]*due Mon 30 Nov/);
});

test("a Workshop is pinged on its milestone days, at T-14 and T-7", () => {
  const workshop = item({ id: "80", type: "Workshop", target: "2026-12-07" }); // 14 days
  const result = pings([workshop], "2026-11-23", "M");

  assert.deepEqual(rows(result).map((p) => p.itemId), [workshop.id]);
  assert.match(rowFor(result, workshop.id).text, /Work 80: Workshop in 14 days \(Mon 7 Dec\)/);
  assert.deepEqual(rowFor(result, workshop.id).actions, ["ack", "move"], "ack, then move the date");
  assert.match(text(result), /\*Today\*[\s\S]*Workshop in 14 days/);
  assert.ok(!text(result).includes("Coming up"), "the row says it: no second line");

  // T-13 is neither a milestone nor a row; it is a Coming up line.
  const dayBefore = pings([{ ...workshop, target: "2026-12-06" }], "2026-11-23", "M");
  assert.deepEqual(dayBefore.pings, []);
  assert.deepEqual(rows(dayBefore), []);
  assert.match(text(dayBefore), /Coming up[\s\S]*notes#80[^\n]*due Sun 6 Dec/);

  // T-7 is the second milestone.
  const weekOut = pings([{ ...workshop, target: "2026-11-30" }], "2026-11-23", "M");
  assert.match(rowFor(weekOut, workshop.id).text, /Workshop in 7 days \(Mon 30 Nov\)/);
});

test("a milestone has a row whatever the status, and the evening sweep has its own rules", () => {
  const next = item({ id: "81", type: "POC", status: "Next", target: "2026-11-30" }); // T-7
  assert.deepEqual(rows(pings([next], "2026-11-23", "M")).map((p) => p.itemId), [next.id]);
  assert.deepEqual(pings([next], "2026-11-23", "E").pings, [], "the evening sweep does not re-ping a heads-up");
});

test("inside the deadline ladder a Workshop is still an ordinary due-in row", () => {
  const workshop = item({ id: "82", type: "Workshop", target: "2026-11-25" }); // T-2
  const row = rowFor(pings([workshop], "2026-11-23", "M"), workshop.id);
  assert.match(row.text, /due in 2 days \(Wed 25 Nov\)/);
  assert.deepEqual(row.actions, ["ack", "move", "done"], "move comes after ack");
});

test("the lead time is Policy data, not a constant", () => {
  const workshop = item({ id: "83", type: "Workshop", target: "2026-12-14" }); // 21 days
  assert.deepEqual(rows(pings([workshop], "2026-11-23", "M")), []);

  const custom = plan([workshop], "2026-11-23", "M", [], {
    policy: { leadByType: { Workshop: { heads: 21, milestones: [21] } } },
  });
  assert.deepEqual(rows(custom).map((p) => p.itemId), [workshop.id]);
  assert.match(rows(custom)[0].text, /Workshop in 21 days \(Mon 14 Dec\)/);
});

test("an overdue Target date row offers to move the date, after the ack", () => {
  const overdue = item({ id: "84", target: "2026-11-20" });
  assert.deepEqual(rowFor(pings([overdue], "2026-11-23", "M"), overdue.id).actions, ["ack", "move", "done"]);
});

test("a Waiting item nobody touched for more than waitingChaseDays is chased", () => {
  const waiting = item({ id: "90", status: "Waiting", waitingOn: "Acme", updatedAt: "2026-11-19T00:00:00.000Z" }); // 6 days
  const row = rowFor(pings([waiting], "2026-11-25", "M"), waiting.id);

  assert.match(row.text, /Work 90: chase Acme\?/);
  assert.deepEqual(row.actions, ["ack", "touch1", "touch7", "done"]);
});

test("a Waiting item with nothing to name is chased anyway, and only in the morning", () => {
  const waiting = item({ id: "91", status: "Waiting", updatedAt: "2026-11-01T00:00:00.000Z" });
  assert.match(rowFor(pings([waiting], "2026-11-25", "M"), waiting.id).text, /chase them\?/);
  assert.deepEqual(pings([waiting], "2026-11-25", "E").pings, [], "a chase does not re-ping at 17:30");
});

test("a Waiting item inside waitingChaseDays is not chased", () => {
  const fresh = item({ id: "92", status: "Waiting", updatedAt: "2026-11-20T00:00:00.000Z" }); // exactly 5 days
  assert.deepEqual(rows(pings([fresh], "2026-11-25", "M")), []);
});

test("a Waiting item whose Next touch is due has a touch row, not a chase", () => {
  const due = item({ id: "93", status: "Waiting", waitingOn: "Acme", nextTouch: "2026-11-25", updatedAt: "2026-11-01T00:00:00.000Z" });
  const result = pings([due], "2026-11-25", "M");
  assert.equal(rows(result).length, 1);
  const row = rowFor(result, due.id);
  assert.match(row.text, /\*touch today\*/);
  assert.ok(!row.text.includes("chase"));
  assert.deepEqual(row.actions, ["ack", "touch1", "touch7", "done"]);
});

test("a Waiting item with a future Next touch is left alone until then", () => {
  const later = item({ id: "94", status: "Waiting", waitingOn: "Globex", nextTouch: "2026-11-30", updatedAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(rows(pings([later], "2026-11-25", "M")), []);
});

test("Friday briefs the Pipeline: an open Stage nobody touched for stageStaleDays", () => {
  const stale = item({ id: "95", stage: "POC", updatedAt: "2026-10-28T00:00:00.000Z" }); // 30 days
  const result = pings([stale], "2026-11-27", "M");

  assert.deepEqual(result.pings, [], "the Pipeline nags, it does not ping");
  assert.match(text(result), /\*Pipeline\*\n• notes#95 Work 95: in POC, no update for 30 days/);
});

test("the Pipeline section is Friday's, and only for the open stages", () => {
  const stale = item({ id: "96", stage: "Discovery", updatedAt: "2026-10-28T00:00:00.000Z" }); // 30 days
  assert.match(text(pings([stale], "2026-11-27", "M")), /Pipeline/, "Friday, and stale enough");
  assert.ok(!text(pings([stale], "2026-11-26", "M")).includes("Pipeline"), "not on a Thursday");

  const exactly = item({ id: "97", stage: "Discovery", updatedAt: "2026-11-06T00:00:00.000Z" }); // 21 days
  assert.ok(!text(pings([exactly], "2026-11-27", "M")).includes("Pipeline"), "21 is not more than 21");

  const closed = item({ id: "98", stage: "Won", updatedAt: "2026-10-01T00:00:00.000Z" });
  const bare = item({ id: "99", updatedAt: "2026-10-01T00:00:00.000Z" });
  assert.ok(!text(pings([closed, bare], "2026-11-27", "M")).includes("Pipeline"), "Won is not the pipeline, and an item without a Stage is not either");
});

test("a Done item never reaches the Pipeline, however stale", () => {
  const done = item({ id: "99", status: "Done", stage: "POC", updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.ok(!text(pings([done], "2026-11-27", "M")).includes("Pipeline"));
});

test("the Pipeline honours stageStaleDays and pipelineStages from the policy", () => {
  const stale = item({ id: "A1", stage: "Proposal", updatedAt: "2026-11-10T00:00:00.000Z" }); // 17 days
  assert.ok(!text(pings([stale], "2026-11-27", "M")).includes("Pipeline"), "17 days is inside the default 21");

  const strict = plan([stale], "2026-11-27", "M", [], { policy: { stageStaleDays: 14 } });
  assert.match(text(strict), /in Proposal, no update for 17 days/);

  const onlyPoc = plan([stale], "2026-11-27", "M", [], { policy: { pipelineStages: ["POC"] } });
  assert.ok(!text(onlyPoc).includes("Pipeline"));
});

test("a Waiting item that was pinged within waitingChaseDays is not chased again", () => {
  const waiting = item({ id: "99", status: "Waiting", waitingOn: "Acme", updatedAt: "2026-11-10T00:00:00.000Z" });
  const sent = (date: string, sentAt: string): SentPing => ({
    key: pingKey(date, "M", waiting.id),
    itemId: waiting.id,
    date,
    slot: "M",
    kind: "ping",
    sentAt,
    ackedAt: null,
  });

  const monday = sent("2026-11-23", "2026-11-23T01:00:00.000Z");
  assert.deepEqual(rows(pings([waiting], "2026-11-25", "M", [monday])), [], "pinged on Monday, quiet on Wednesday");

  const lastWeek = sent("2026-11-19", "2026-11-19T01:00:00.000Z"); // 6 days: outside the window
  assert.match(rowFor(pings([waiting], "2026-11-25", "M", [lastWeek]), waiting.id).text, /chase Acme\?/);
});

test("Friday briefs the Learning cadence, with the age of the last update", () => {
  const quiet = item({ id: "B1", track: "Learn", cadence: "2/week", updatedAt: "2026-11-24T00:00:00.000Z" });
  const old = item({ id: "B2", track: "Learn", cadence: "1/week", updatedAt: "2026-11-19T00:00:00.000Z" });
  const briefing = text(pings([quiet, old], "2026-11-27", "M"));

  assert.match(briefing, /\*Learning\*\n• notes#B1 Work B1: cadence 2\/week, last update Tue 24 Nov \(this week\)/);
  assert.match(briefing, /• notes#B2 Work B2: cadence 1\/week, last update Thu 19 Nov \(8 days ago\)/);
});

test("Learning is Friday's, needs a cadence, and is not paged for other tracks", () => {
  const learn = item({ id: "B3", track: "Learn", cadence: "daily", updatedAt: "2026-11-20T00:00:00.000Z" });
  assert.ok(!text(pings([learn], "2026-11-26", "M")).includes("Learning"));

  const build = item({ id: "B4", track: "Build", cadence: "daily", updatedAt: "2026-11-20T00:00:00.000Z" });
  const noCadence = item({ id: "B5", track: "Learn", updatedAt: "2026-11-20T00:00:00.000Z" });
  assert.ok(!text(pings([build, noCadence], "2026-11-27", "M")).includes("Learning"));
});

test("the Learning line ages the item's own update, not a notes commit", () => {
  const learn = item({ id: "B6", track: "Learn", cadence: "2/week", updatedAt: "2026-11-02T00:00:00.000Z" });
  const activity = new Map([[learn.id, "2026-11-26T10:00:00.000Z"]]);
  const briefing = plan([learn], "2026-11-27", "M", [], { activity }).briefing?.text ?? "";

  assert.match(briefing, /notes#B6[^\n]*last update Mon 2 Nov \(25 days ago\)/, "the board's date, not the notes'");
});

test("over the WIP limit the briefing names the items in flight", () => {
  const board = [item({ id: "C1" }), item({ id: "C2" }), item({ id: "C3" }), item({ id: "C4" })];
  assert.match(text(pings(board, "2026-11-23", "M")), /\*In progress:\* 4 \(over the limit of 3: what are you dropping\?\)\nnotes#C1, notes#C2, notes#C3, notes#C4/);

  const three = text(pings(board.slice(0, 3), "2026-11-23", "M"));
  assert.match(three, /\*In progress:\* 3$/);
  assert.ok(!three.includes("notes#C1"), "under the limit there is nothing to drop");
});

test("activity after the ping acks it, like a board update", () => {
  const morning: SentPing = {
    key: pingKey("2026-11-26", "M", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-26T01:00:00.000Z",
    ackedAt: null,
  };
  const board = [{ ...B, account: "Acme" }];

  assert.equal(plan(board, "2026-11-26", "E", [morning]).pings[0].kind, "reping", "nothing acked it yet");

  const activity = new Map([[B.id, "2026-11-26T05:00:00.000Z"]]);
  const ping = plan(board, "2026-11-26", "E", [morning], { activity }).pings[0];
  assert.equal(ping.kind, "ping");
  assert.ok(!ping.text.includes("no update since this morning"));

  const early = new Map([[B.id, "2026-11-25T05:00:00.000Z"]]);
  assert.equal(plan(board, "2026-11-26", "E", [morning], { activity: early }).pings[0].kind, "reping", "an older commit acks nothing");
});

test("activity after yesterday's reping clears the warning line", () => {
  const reping: SentPing = {
    key: pingKey("2026-11-26", "E", B.id),
    itemId: B.id,
    date: "2026-11-26",
    slot: "E",
    kind: "reping",
    sentAt: "2026-11-26T09:30:00.000Z",
    ackedAt: null,
  };
  const activity = new Map([[B.id, "2026-11-26T12:00:00.000Z"]]);
  assert.ok(!text(plan([B], "2026-11-27", "M", [reping], { activity })).includes("⚠"));
});

test("Policy overrides the status names, the day windows and the WIP limit", () => {
  const doing = item({ id: "73", status: "Doing", target: "2026-11-25" });
  const board = [doing, item({ id: "74", status: "Doing" }), item({ id: "75", status: "Doing" })];

  const defaultPolicy = plan(board, "2026-11-25", "M", []);
  assert.match(text(defaultPolicy), /\*In progress:\* 0/, "Doing is not In progress by default");
  assert.deepEqual(rows(defaultPolicy).map((p) => p.itemId), [doing.id], "but being due today is a row whatever the status");

  const custom = plan(board, "2026-11-25", "M", [], { policy: { inProgress: "Doing", wipLimit: 2 } });
  assert.deepEqual(rows(custom).map((p) => p.itemId), [doing.id]);
  assert.match(text(custom), /\*In progress:\* 3 \(over the limit of 2/);

  const short = plan([item({ id: "76", target: "2026-11-30" })], "2026-11-25", "M", [], { policy: { pingDays: 7 } });
  assert.deepEqual(rows(short).map((p) => p.itemId), ["76"], "pingDays 7 reaches 5 days out");

  // The very same board at 17:30 keeps its pings: the sweep is unchanged.
  const evening = plan(board, "2026-11-25", "E", [], { policy: { inProgress: "Doing" } });
  assert.deepEqual(evening.pings.map((p) => p.itemId), [doing.id]);
});

// ---- the briefing's rows: their order, their menu ---------------------------

const envFor = (today: string, board: string[]): Env => ({
  today,
  slot: "M",
  history: [],
  byId: new Map(),
  policy: DEFAULT_POLICY,
  activity: new Map(),
  index: new Map(board.map((id, at) => [id, at])),
});

const morning = (item: Item, date: string): SentPing => ({
  key: pingKey(date, "M", item.id),
  itemId: item.id,
  date,
  slot: "M",
  kind: "ping",
  sentAt: `${date}T01:00:00.000Z`,
  ackedAt: null,
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

  // The same item, pinged within the window, is no chase: the milestone decides.
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

  const result = pings([chase, milestone, soon, touchToday, dueToday, lateTouch, overdue], "2026-11-25", "M");
  assert.deepEqual(rows(result).map((row) => row.itemId), ["6", "7", "4", "5", "3", "1", "2"]);
});

test("a Next item due today gets a row with its menu, though it is not In progress", () => {
  const next = item({ id: "77", status: "Next", target: "2026-11-25" });
  const result = pings([next], "2026-11-25", "M");
  const row = rowFor(result, next.id);

  assert.match(row.text, /\*due today\*/);
  assert.deepEqual(row.actions, ["ack", "move", "done"]);
  assert.match(text(result), /• <[^>]*notes#77> Work 77: \*due today\*/);
});

test("the plain text is the head, the rows and the tail, in that order", () => {
  const result = pings(BOARD, "2026-11-23", "M");
  const briefing = result.briefing;
  assert.ok(briefing !== null);

  assert.equal(briefing.head[0], "*Morning briefing, Mon 23 Nov*");
  assert.equal(briefing.head.at(-1), "*Today*");
  assert.equal(briefing.rows.length, 1);
  assert.match(briefing.tail[0], /^\*Coming up\*/);
  assert.match(briefing.tail.at(-1) ?? "", /^\*In progress:\* 3$/);
  assert.equal(
    briefing.text,
    [...briefing.head.slice(0, -1), ["*Today*", ...briefing.rows.map((row) => `• ${row.text}`)].join("\n"), ...briefing.tail].join("\n\n"),
  );
});

// ---- E: what the sweep re-pings --------------------------------------------

test("the evening sweep skips an unacked row that is only due in a couple of days", () => {
  const soon = item({ id: "40", target: "2026-11-27" }); // Mon 25: due in 2
  assert.equal(rows(pings([soon], "2026-11-25", "M")).length, 1, "it has a morning row");

  const evening = pings([soon], "2026-11-25", "E", [morning(soon, "2026-11-25")]);
  assert.deepEqual(evening.pings, [], "and the sweep has nothing to add");
});

test("the evening sweep skips an unacked milestone heads-up", () => {
  const poc = item({ id: "41", type: "POC", target: "2026-12-02" }); // T-7
  assert.equal(rows(pings([poc], "2026-11-25", "M")).length, 1);
  assert.deepEqual(pings([poc], "2026-11-25", "E", [morning(poc, "2026-11-25")]).pings, []);
});

test("the evening sweep re-pings an unacked row that is overdue", () => {
  const late = item({ id: "42", target: "2026-11-20" });
  const evening = pings([late], "2026-11-25", "E", [morning(late, "2026-11-25")]);

  assert.equal(evening.pings.length, 1);
  assert.equal(evening.pings[0].kind, "reping");
  assert.match(evening.pings[0].text, /no update since this morning/);
  assert.deepEqual(evening.pings[0].actions, ["ack", "done"], "the sweep's actions, unchanged");
});

test("the evening sweep re-pings an unacked row whose touch was due", () => {
  const touch = item({ id: "43", nextTouch: "2026-11-24" });
  const evening = pings([touch], "2026-11-25", "E", [morning(touch, "2026-11-25")]);

  assert.equal(evening.pings.length, 1);
  assert.equal(evening.pings[0].kind, "reping");
  assert.deepEqual(evening.pings[0].actions, ["ack", "touch1", "touch7", "done"]);
});

// ---- the day's meetings: the briefing's one section that is not the board's --

const MEETINGS = ["• 09:00 Acme weekly sync", "• 10:30 Globex kickoff"];

test("a morning briefing names the day's meetings under the rows, in its text and its tail", () => {
  const briefing = plan(BOARD, "2026-11-25", "M", [], { meetings: MEETINGS }).briefing;
  assert.ok(briefing !== null);

  const section = `*Today's meetings*\n${MEETINGS.join("\n")}`;
  assert.equal(briefing.tail[0], section, "the first of the sections under the rows");
  assert.ok(briefing.text.includes(`\n\n${section}\n\n`), "the text carries the same lines, so the preview does not lie");
  assert.ok(briefing.text.indexOf(section) > briefing.text.indexOf("*Today*"), "and under the rows, not above them");
  assert.equal(briefing.tail.filter((line) => line.startsWith("*Today's meetings*")).length, 1, "one heading, the lines on it");
});

test("with no meetings the briefing is byte for byte the one it was", () => {
  const before = plan(BOARD, "2026-11-25", "M", []);
  assert.deepEqual(plan(BOARD, "2026-11-25", "M", [], { meetings: [] }), before, "an empty day adds nothing");
  assert.deepEqual(plan(BOARD, "2026-11-25", "M", [], { meetings: undefined }), before, "and so does no source at all");
  assert.ok(!(before.briefing?.text ?? "").includes("Today's meetings"), "no heading either");
});

test("the evening plan ignores meetings entirely", () => {
  const withMeetings = plan(BOARD, "2026-11-25", "E", [], { meetings: MEETINGS });
  assert.deepEqual(withMeetings, plan(BOARD, "2026-11-25", "E", []), "the sweep is unchanged");
  assert.equal(withMeetings.briefing, null, "the evening has no message to put a meeting in");
});
