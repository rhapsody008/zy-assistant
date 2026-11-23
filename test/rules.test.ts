// The acceptance table for the week of Mon 2026-11-23, straight from the rules
// in src/rules.ts. If one of these fails, the behaviour the bot promises changed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pingKey, plan, type Item, type SentPing } from "../src/rules.ts";

const UPDATED = "2026-11-20T00:00:00.000Z";
const url = (ref: string): string => `https://github.com/rhapsody008/notes/issues/${ref.split("#")[1]}`;

function item(fields: Partial<Item> & Pick<Item, "id">): Item {
  return {
    ref: `notes#${fields.id}`,
    title: `Work ${fields.id}`,
    url: url(`notes#${fields.id}`),
    status: "In progress",
    target: null,
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
    type: null,
    stage: null,
    track: null,
    account: null,
    cadence: null,
    parentUrl: null,
    updatedAt: UPDATED,
    ...fields,
  };
}

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

test("Monday morning: one ping, stale and coming-up in the briefing, quiet items absent", () => {
  const result = pings(BOARD, "2026-11-23", "M");
  assert.deepEqual(result.pings.map((p) => p.itemId), [B.id]);
  assert.match(byItem(result, B.id).text, /due in 3 days/);

  const briefing = result.briefing ?? "";
  assert.match(briefing, /Stale dates[^\n]*notes#54/);
  assert.match(briefing, /Coming up[\s\S]*notes#55/);
  assert.ok(!briefing.includes("notes#52"), "A has nothing to say on Monday and must not appear");
  assert.ok(!briefing.includes("notes#56"), "a Done item must not appear");
});

test("Tuesday morning: B is pinged, the briefing says A touches tomorrow", () => {
  const result = pings(BOARD, "2026-11-24", "M");
  assert.deepEqual(result.pings.map((p) => p.itemId), [B.id]);
  assert.match(result.briefing ?? "", /notes#52[^\n]*touch tomorrow/);
});

test("Wednesday morning: A pings with touch today and the +7 button, B still pings", () => {
  const result = pings(BOARD, "2026-11-25", "M");
  assert.deepEqual(result.pings.map((p) => p.itemId).sort(), [A.id, B.id].sort());
  assert.match(byItem(result, A.id).text, /touch today/);
  assert.ok(byItem(result, A.id).actions.includes("touch7"));
  assert.match(byItem(result, A.id).text, /Next: write the draft/);
});

test("Thursday morning: B is due today, A's touch was Wednesday", () => {
  const result = pings(BOARD, "2026-11-26", "M");
  assert.match(byItem(result, B.id).text, /due today/);
  assert.match(byItem(result, A.id).text, /touch was Wed 25 Nov/);
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
  assert.match(byItem(result, B.id).text, /\*overdue\* by 1 day/);
  assert.match(result.briefing ?? "", /⚠ \*No update\* on <[^>]*notes#53>/);
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
  assert.ok(!(result.briefing ?? "").includes("⚠"), "an acked reping must not warn on Friday");
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
  assert.match(result.briefing ?? "", /⚠ \*No update\* on <[^>]*notes#52>/);
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

  const briefing = pings(BOARD, "2026-11-30", "M", history).briefing ?? "";
  const warns = briefing.split("\n").filter((line) => line.startsWith("⚠"));

  assert.equal(warns.length, 2, "both unacked Friday repings warn on Monday");
  assert.match(warns[0], /notes#53/, "B is warned first: it was pinged first on Friday");
  assert.match(warns[1], /notes#52/, "A is warned second, though the board lists it first");
});

test("four In progress items are over the WIP limit", () => {
  const result = pings([...BOARD, F], "2026-11-23", "M");
  assert.match(result.briefing ?? "", /In progress: 4 \(over the limit of 3/);
});

test("three In progress items are not over the limit", () => {
  const result = pings(BOARD, "2026-11-23", "M");
  assert.match(result.briefing ?? "", /In progress: 3$/);
});

test("a notes#5 item next to notes#52 keeps its own touch-tomorrow line", () => {
  // Refs are not unique: "notes#5" is a substring of "notes#52", and two drafts
  // both say "draft". The line must key off the item's own reasons.
  const long = item({ id: "52", ref: "notes#52", title: "Long", target: "2026-11-25" });
  const short = item({ id: "5", ref: "notes#5", title: "Short", nextTouch: "2026-11-25" });
  const draftDue = item({ id: "D1", ref: "draft", title: "Draft due", target: "2026-11-25" });
  const draftTouch = item({ id: "D2", ref: "draft", title: "Draft touch", nextTouch: "2026-11-25" });

  const result = pings([long, short, draftDue, draftTouch], "2026-11-24", "M");
  const touchLines = (result.briefing ?? "").split("\n").filter((line) => line.includes("touch tomorrow"));

  assert.equal(touchLines.length, 2, "notes#5 and the draft each get a line");
  assert.ok(touchLines.some((line) => line.includes("notes#5>")), "notes#5 is not swallowed by notes#52");
  assert.ok(touchLines.some((line) => line.includes("|draft>")), "the draft is not swallowed by the other draft");
});

test("an item already due tomorrow has no duplicate touch-tomorrow line", () => {
  const due = item({ id: "60", ref: "notes#60", target: "2026-11-25", nextTouch: "2026-11-25" });
  const briefing = pings([due], "2026-11-24", "M").briefing ?? "";
  assert.ok(!briefing.includes("touch tomorrow"));
  assert.match(briefing, /notes#60[^\n]*due in 1 day/);
});

test("a Type with a lead time replaces pingDays for that item only", () => {
  // Wednesday, 2026-11-25. Alpha is due in 6 days: past the default 3, inside a
  // Feature's 7. Delta is due in the same 6 days and has no Type.
  const feature = item({ id: "70", type: "Feature", target: "2026-12-01" });
  const plain = item({ id: "71", target: "2026-12-01" });
  const board = [feature, plain];

  assert.deepEqual(pings(board, "2026-11-25", "M").pings, [], "the default policy has no per-type lead time");
  assert.deepEqual(plan(board, "2026-11-25", "M", [], { policy: { leadDaysByType: {} } }).pings, []);

  const withFeature = plan(board, "2026-11-25", "M", [], { policy: { leadDaysByType: { Feature: 7 } } });
  assert.deepEqual(withFeature.pings.map((p) => p.itemId), [feature.id]);
  assert.match(withFeature.pings[0].text, /due in 6 days/);
});

test("a Type the policy does not know keeps pingDays", () => {
  const other = item({ id: "72", type: "Chore", target: "2026-11-30" }); // 5 days out
  assert.deepEqual(plan([other], "2026-11-25", "M", [], { policy: { leadDaysByType: { Feature: 7 } } }).pings, []);
});

test("Policy overrides the status names, the day windows and the WIP limit", () => {
  const doing = item({ id: "73", status: "Doing", target: "2026-11-25" });
  const board = [doing, item({ id: "74", status: "Doing" }), item({ id: "75", status: "Doing" })];

  const defaultPolicy = plan(board, "2026-11-25", "M", []);
  assert.deepEqual(defaultPolicy.pings, [], "Doing is not In progress by default");
  assert.match(defaultPolicy.briefing ?? "", /In progress: 0/);

  const custom = plan(board, "2026-11-25", "M", [], { policy: { inProgress: "Doing", wipLimit: 2 } });
  assert.deepEqual(custom.pings.map((p) => p.itemId), [doing.id]);
  assert.match(custom.briefing ?? "", /In progress: 3 \(over the limit of 2/);

  const short = plan([item({ id: "76", target: "2026-11-30" })], "2026-11-25", "M", [], { policy: { pingDays: 7 } });
  assert.deepEqual(short.pings.map((p) => p.itemId), ["76"], "pingDays 7 reaches 5 days out");
});
