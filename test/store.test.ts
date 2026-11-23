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

test("a dictation is stored as it was dictated, and a redelivery does not overwrite it", () => {
  const store = openStore(":memory:");
  assert.equal(store.recordDictation({ ts: "1700.1", text: "ten nodes\nthe pilot starts in January", createdAt: "2026-11-25T01:00:00.000Z" }), true);
  assert.equal(store.recordDictation({ ts: "1700.1", text: "other words", createdAt: "2026-11-25T01:05:00.000Z" }), false, "the ts is the dedupe");

  assert.deepEqual(store.findDictation("1700.1"), {
    ts: "1700.1",
    text: "ten nodes\nthe pilot starts in January",
    status: "stored",
    folder: null,
    noteJson: null,
    commitUrl: null,
    createdAt: "2026-11-25T01:00:00.000Z",
    error: null,
  });
  assert.equal(store.findDictation("nope"), null);
  store.close();
});

test("a dictation is patched field by field, and what is not patched stays", () => {
  const store = openStore(":memory:");
  store.recordDictation({ ts: "1700.1", text: "ten nodes", createdAt: "2026-11-25T01:00:00.000Z" });

  store.updateDictation("1700.1", { status: "asked", noteJson: '{"topic":"Acme VPC sizing"}' });
  assert.equal(store.findDictation("1700.1")?.status, "asked");
  assert.equal(store.findDictation("1700.1")?.noteJson, '{"topic":"Acme VPC sizing"}');
  assert.equal(store.findDictation("1700.1")?.text, "ten nodes");

  store.updateDictation("1700.1", { status: "done", folder: "Accounts/Acme", commitUrl: "https://github.com/demo/notes/commit/1" });
  const row = store.findDictation("1700.1");
  assert.equal(row?.status, "done");
  assert.equal(row?.folder, "Accounts/Acme");
  assert.equal(row?.commitUrl, "https://github.com/demo/notes/commit/1");
  assert.equal(row?.noteJson, '{"topic":"Acme VPC sizing"}', "the extracted note survives the commit");

  store.updateDictation("1700.1", {});
  assert.equal(store.findDictation("1700.1")?.status, "done", "an empty patch changes nothing");
  store.close();
});

test("a dictation is claimed once: the second claim, or the second click, gets false", () => {
  const store = openStore(":memory:");
  store.recordDictation({ ts: "1700.1", text: "ten nodes", createdAt: "2026-11-25T01:00:00.000Z" });

  assert.equal(store.claimDictation("1700.1", ["asked", "failed"]), false, "a stored dictation is not an answer");
  assert.equal(store.claimDictation("1700.1", ["stored"]), true, "the pipeline takes it");
  assert.equal(store.findDictation("1700.1")?.status, "writing");
  assert.equal(store.claimDictation("1700.1", ["stored"]), false, "a redelivery does not");
  assert.equal(store.claimDictation("1700.1", ["asked", "failed"]), false, "and neither does a click");

  store.updateDictation("1700.1", { status: "asked" });
  assert.equal(store.claimDictation("1700.1", ["asked", "failed"]), true, "an unanswered question can be taken");
  assert.equal(store.findDictation("1700.1")?.status, "writing");
  assert.equal(store.claimDictation("1700.1", ["asked", "failed"]), false, "the second click of a double click loses");

  assert.equal(store.claimDictation("nope", ["asked"]), false);
  assert.equal(store.claimDictation("1700.1", []), false);
  store.close();
});

test("a dictation left writing by a dead process can be claimed again after a restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openStore } = await import("../src/store.ts");
  const path = join(mkdtempSync(join(tmpdir(), "zya-")), "s.db");
  const first = openStore(path);
  first.recordDictation({ ts: "1.1", text: "x", createdAt: "2026-11-23T00:00:00.000Z" });
  assert.equal(first.claimDictation("1.1", ["stored"]), true);
  assert.equal(first.findDictation("1.1")?.status, "writing");
  first.close?.();
  const second = openStore(path);
  assert.equal(second.findDictation("1.1")?.status, "failed");
  assert.equal(second.claimDictation("1.1", ["failed"]), true);
});
