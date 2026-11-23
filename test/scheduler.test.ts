// The scheduler with a fake clock in Asia/Singapore (UTC+8), a fake board, a
// fake store and a fake Slack. Nothing here waits for a real minute.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board } from "../src/github.ts";
import type { Item } from "../src/rules.ts";
import { createTicker, tick, type SchedulerDeps } from "../src/scheduler.ts";
import { FakeSender, FakeStore, Gate } from "./fakes.ts";

const UPDATED = "2026-11-20T00:00:00.000Z";

function item(id: string, fields: Partial<Item> = {}): Item {
  return {
    id,
    ref: `notes#${id}`,
    title: `Work ${id}`,
    url: `https://github.com/rhapsody008/notes/issues/${id}`,
    status: "In progress",
    target: null,
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
    updatedAt: UPDATED,
    ...fields,
  };
}

// Monday 2026-11-23: two pings (due tomorrow, due in two days) and a third from
// a Next touch in the past.
const ITEMS: Item[] = [
  item("1", { target: "2026-11-24" }),
  item("2", { target: "2026-11-25" }),
  item("3", { nextTouch: "2026-11-20" }),
];

// 08:59, 09:00, 09:01, 11:00 and 17:30 local on the same Monday.
const EIGHT_FIFTY_NINE = "2026-11-23T00:59:00Z";
const NINE = "2026-11-23T01:00:00Z";
const NINE_OH_ONE = "2026-11-23T01:01:00Z";
const ELEVEN = "2026-11-23T03:00:00Z";
const SEVENTEEN_THIRTY = "2026-11-23T09:30:00Z";
const SATURDAY_NINE = "2026-11-28T01:00:00Z";

function harness(items: Item[]) {
  const store = new FakeStore();
  const sender = new FakeSender();
  const logs: string[] = [];
  const board: Board = { projectId: "PVT_1", title: "Board", fields: new Map(), items };
  const deps: SchedulerDeps = {
    config: { projectOwner: "rhapsody008", projectNumber: 1, briefTime: "09:00", eodTime: "17:30" },
    board: { fetchBoard: async () => board },
    store,
    sender,
    now: () => new Date(NINE),
    log: (line) => logs.push(line),
  };
  return { deps, store, sender, logs };
}

async function at(deps: SchedulerDeps, iso: string): Promise<void> {
  await tick(new Date(iso), deps);
}

test("nothing happens at 08:59", async () => {
  const { deps, sender, store } = harness(ITEMS);
  await at(deps, EIGHT_FIFTY_NINE);
  assert.deepEqual(sender.dms, []);
  assert.deepEqual(sender.sent, []);
  assert.equal(store.slotRan("2026-11-23", "M"), false);
});

test("the morning slot runs at 09:00 and never twice", async () => {
  const { deps, sender, store } = harness(ITEMS);
  await at(deps, NINE);
  assert.equal(sender.dms.length, 1, "the briefing goes out first");
  assert.equal(sender.sent.length, 3);
  assert.equal(store.slotRan("2026-11-23", "M"), true);

  await at(deps, NINE_OH_ONE);
  assert.equal(sender.sent.length, 3);
  assert.equal(sender.dms.length, 1);
});

test("a slot that was missed at 11:00 does not run", async () => {
  const { deps, sender, store } = harness(ITEMS);
  await at(deps, ELEVEN);
  assert.deepEqual(sender.sent, []);
  assert.equal(store.slotRan("2026-11-23", "M"), false);
});

test("the weekend is quiet", async () => {
  const { deps, sender } = harness(ITEMS);
  await at(deps, SATURDAY_NINE);
  assert.deepEqual(sender.sent, []);
  assert.deepEqual(sender.dms, []);
});

test("the evening slot runs at 17:30", async () => {
  const { deps, sender, store } = harness([item("9", { target: "2026-11-23" })]);
  await at(deps, SEVENTEEN_THIRTY);
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].kind, "ping");
  assert.equal(store.slotRan("2026-11-23", "E"), true);
});

test("a ping already in the store is not sent again", async () => {
  const { deps, sender, store } = harness(ITEMS);
  store.recordPing({
    key: "2026-11-23:M:1",
    itemId: "1",
    date: "2026-11-23",
    slot: "M",
    kind: "ping",
    sentAt: NINE,
    channel: "DM",
    ts: "ts-old",
  });
  await at(deps, NINE);
  assert.deepEqual(sender.sent.map((p) => p.itemId), ["2", "3"]);
  assert.equal(store.slotRan("2026-11-23", "M"), true);
});

test("a failure mid-slot leaves it unmarked and the retry sends only the rest", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  sender.failOnAttempt = 2;

  await at(deps, NINE);
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  assert.deepEqual(sender.sent.map((p) => p.itemId), ["1"]);
  assert.match(logs.join("\n"), /slack is down/);

  await at(deps, NINE_OH_ONE);
  assert.equal(store.slotRan("2026-11-23", "M"), true);
  assert.deepEqual(sender.sent.map((p) => p.itemId), ["1", "2", "3"], "item 1 is not sent twice");
});

test("two overlapping ticks send the briefing and each ping exactly once", async () => {
  const { deps, sender, store } = harness(ITEMS);
  const gate = new Gate();
  sender.gate = gate;
  const runTick = createTicker(deps);

  // The briefing send is held open, so the first tick is still in flight when
  // the second one starts. Both calls are resolved; the guard must make the
  // second a no-op rather than a second run.
  const first = runTick(new Date(NINE));
  await gate.entered;
  const second = runTick(new Date(NINE_OH_ONE));
  gate.open();
  await Promise.all([first, second]);

  assert.equal(sender.dms.length, 1, "the briefing went out once");
  assert.equal(sender.sent.length, 3, "every ping went out once");
  assert.equal(store.slotRan("2026-11-23", "M"), true);
});

test("a slot that fails every time briefs once, then gives up with a DM", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  sender.alwaysFailPings = true;
  const runTick = createTicker(deps);

  await runTick(new Date(NINE));
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  assert.equal(sender.dms.length, 1, "the briefing was sent once and is now recorded");

  await runTick(new Date("2026-11-23T01:01:00Z"));
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  assert.equal(sender.dms.length, 1, "no second briefing");

  await runTick(new Date("2026-11-23T01:02:00Z"));
  assert.equal(store.slotRan("2026-11-23", "M"), true, "three failures close the slot");
  assert.equal(sender.dms.length, 2, "one failure DM");
  assert.match(sender.dms[1], /^zy-assistant: M 2026-11-23 failed 3 times: slack is down$/);
  assert.equal(sender.sent.length, 0);
  assert.match(logs.join("\n"), /failed 3 times, giving up/);

  await runTick(new Date("2026-11-23T01:03:00Z"));
  assert.equal(sender.dms.length, 2, "a closed slot is not retried");
});
