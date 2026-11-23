// The SQLite store, in memory: a ping round-trip, the ack, the message lookup
// and the slot marker.

import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../src/store.ts";

const PING = {
  key: "2026-11-23:M:ITEM_1",
  itemId: "ITEM_1",
  date: "2026-11-23",
  slot: "M",
  kind: "ping",
  sentAt: "2026-11-23T01:00:00.000Z",
  channel: "D123",
  ts: "1700000000.000100",
} as const;

test("a recorded ping comes back in the history and by key and message", () => {
  const store = openStore(":memory:");
  store.recordPing(PING);

  const history = store.historySince("2026-11-16");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    key: PING.key,
    itemId: PING.itemId,
    date: PING.date,
    slot: "M",
    kind: "ping",
    sentAt: PING.sentAt,
    ackedAt: null,
  });

  assert.equal(store.historySince("2026-11-24").length, 0, "the window is inclusive from its start");

  const byKey = store.findByKey(PING.key);
  assert.equal(byKey?.channel, "D123");
  assert.equal(byKey?.ts, PING.ts);

  const byMessage = store.findByMessage("D123", PING.ts);
  assert.equal(byMessage?.key, PING.key);
  assert.equal(store.findByMessage("D123", "nope"), null);
  store.close();
});

test("marking a ping acked sticks", () => {
  const store = openStore(":memory:");
  store.recordPing(PING);
  store.markAcked(PING.key, "2026-11-23T02:00:00.000Z");
  assert.equal(store.historySince("2026-11-16")[0].ackedAt, "2026-11-23T02:00:00.000Z");
  store.close();
});

test("a slot is unmarked until it is marked", () => {
  const store = openStore(":memory:");
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  store.markSlotRan("2026-11-23", "M", "2026-11-23T01:00:00.000Z");
  assert.equal(store.slotRan("2026-11-23", "M"), true);
  assert.equal(store.slotRan("2026-11-23", "E"), false);
  assert.equal(store.slotRan("2026-11-24", "M"), false);
  store.close();
});

test("a recorded briefing never shows up as a ping", () => {
  const store = openStore(":memory:");
  assert.equal(store.briefingSent("2026-11-23", "M"), false);
  store.recordBriefing("2026-11-23", "M", "2026-11-23T01:00:00.000Z");

  assert.equal(store.briefingSent("2026-11-23", "M"), true);
  assert.equal(store.briefingSent("2026-11-23", "E"), false);
  assert.deepEqual(store.historySince("2026-11-01"), []);
  assert.equal(store.findByKey("2026-11-23:M:briefing"), null);
  store.close();
});

test("failed attempts at a slot are counted per slot", () => {
  const store = openStore(":memory:");
  assert.equal(store.recordSlotFailure("2026-11-23", "M", "slack is down"), 1);
  assert.equal(store.recordSlotFailure("2026-11-23", "M", "slack is still down"), 2);
  assert.equal(store.recordSlotFailure("2026-11-23", "M", "again"), 3);
  assert.equal(store.recordSlotFailure("2026-11-23", "E", "other slot"), 1);
  store.close();
});
