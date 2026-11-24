// The SQLite store, in memory: a ping round-trip, the ack, the message lookup
// and the slot marker.

import assert from "node:assert/strict";
import { test } from "node:test";
import { askCutoff, openStore } from "../src/store.ts";

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

test("a proposal is stored as it was typed, and a redelivery does not overwrite it", () => {
  const store = openStore(":memory:");
  const first = { id: "add:1700.1", kind: "add", source: "Acme pilots the VPC in January", createdAt: "2026-11-29T01:00:00.000Z" };
  assert.equal(store.recordProposal(first), true);
  assert.equal(store.recordProposal({ ...first, source: "other words", createdAt: "2026-11-29T01:05:00.000Z" }), false, "the id is the dedupe");

  assert.deepEqual(store.findProposal("add:1700.1"), {
    id: "add:1700.1",
    kind: "add",
    status: "drafting",
    source: "Acme pilots the VPC in January",
    payload: null,
    context: null,
    progress: null,
    rev: 0,
    channel: null,
    messageTs: null,
    createdAt: "2026-11-29T01:00:00.000Z",
    error: null,
  });
  assert.equal(store.findProposal("add:nope"), null);
  store.close();
});

test("a proposal is claimed once: a second click, or a second delivery, gets false", () => {
  const store = openStore(":memory:");
  store.recordProposal({ id: "add:1700.1", kind: "add", source: "ten nodes", createdAt: "2026-11-29T01:00:00.000Z" });

  assert.equal(store.claimProposal("add:1700.1", ["open"], "applying"), false, "a draft has no card to click yet");
  assert.equal(store.claimProposal("add:1700.1", ["drafting"], "open"), true, "the card is drawn once");
  assert.equal(store.findProposal("add:1700.1")?.status, "open");
  assert.equal(store.claimProposal("add:1700.1", ["drafting"], "open"), false, "a redelivery does not draw a second card");

  assert.equal(store.claimProposal("add:1700.1", ["open"], "applying"), true, "Create takes it");
  assert.equal(store.findProposal("add:1700.1")?.status, "applying");
  assert.equal(store.claimProposal("add:1700.1", ["open"], "applying"), false, "the second click of a double click loses");
  assert.equal(store.claimProposal("add:1700.1", ["open"], "cancelled"), false, "a cancel racing a Create loses too");

  assert.equal(store.claimProposal("add:nope", ["open"], "applying"), false);
  assert.equal(store.claimProposal("add:1700.1", [], "applying"), false);
  store.close();
});

test("a proposal is patched field by field, and what is not patched stays", () => {
  const store = openStore(":memory:");
  store.recordProposal({ id: "add:1700.1", kind: "add", source: "ten nodes", createdAt: "2026-11-29T01:00:00.000Z" });

  store.updateProposal("add:1700.1", { payload: '{"title":"Acme VPC"}', context: '{"items":[]}' });
  assert.equal(store.findProposal("add:1700.1")?.payload, '{"title":"Acme VPC"}');
  assert.equal(store.findProposal("add:1700.1")?.context, '{"items":[]}');
  assert.equal(store.findProposal("add:1700.1")?.status, "drafting", "a patch leaves the status where it was");
  assert.equal(store.findProposal("add:1700.1")?.source, "ten nodes");

  store.updateProposal("add:1700.1", { status: "open", channel: "D123", messageTs: "1700.5" });
  const row = store.findProposal("add:1700.1");
  assert.equal(row?.status, "open");
  assert.equal(row?.channel, "D123");
  assert.equal(row?.messageTs, "1700.5");
  assert.equal(row?.payload, '{"title":"Acme VPC"}', "the card's payload survives the status change");

  store.updateProposal("add:1700.1", { progress: '{"written":[1]}' });
  assert.equal(store.findProposal("add:1700.1")?.progress, '{"written":[1]}');
  store.updateProposal("add:1700.1", { progress: null });
  assert.equal(store.findProposal("add:1700.1")?.progress, null, "a null in the patch clears the field");

  store.updateProposal("add:1700.1", {});
  assert.equal(store.findProposal("add:1700.1")?.status, "open", "an empty patch changes nothing");
  assert.equal(store.findProposal("add:1700.1")?.rev, 0, "and a patch never moves the rev");
  store.close();
});

test("an edit bumps the rev, and one on a card that has moved on is refused", () => {
  const store = openStore(":memory:");
  const id = "add:1700.1";
  store.recordProposal({ id, kind: "add", source: "ten nodes", createdAt: "2026-11-29T01:00:00.000Z" });

  assert.equal(store.editProposal(id, 0, '{"title":"x"}'), false, "a draft has no card to edit");
  store.claimProposal(id, ["drafting"], "open");
  assert.equal(store.editProposal(id, 0, '{"title":"Acme VPC"}'), true);
  assert.equal(store.findProposal(id)?.rev, 1);
  assert.equal(store.findProposal(id)?.payload, '{"title":"Acme VPC"}');

  assert.equal(store.editProposal(id, 0, '{"title":"stale"}'), false, "a stale rev is a card that has moved on");
  assert.equal(store.findProposal(id)?.payload, '{"title":"Acme VPC"}', "a refused edit writes nothing");
  assert.equal(store.editProposal(id, 1, '{"title":"Globex VPC"}'), true);
  assert.equal(store.findProposal(id)?.rev, 2);

  store.updateProposal(id, { progress: '{"written":[0]}' });
  assert.equal(store.editProposal(id, 2, '{"title":"mid-apply"}'), false, "the writes have started");
  store.updateProposal(id, { progress: null });

  store.updateProposal(id, { status: "cancelled" });
  assert.equal(store.editProposal(id, 2, '{"title":"after cancel"}'), false, "a cancelled card is not edited");
  assert.equal(store.findProposal(id)?.payload, '{"title":"Globex VPC"}');
  store.close();
});

test("a proposal left mid-life by a dead process comes back after a restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openStore } = await import("../src/store.ts");
  const path = join(mkdtempSync(join(tmpdir(), "zya-")), "s.db");
  const first = openStore(path);
  first.recordProposal({ id: "add:1.1", kind: "add", source: "x", createdAt: "2026-11-29T00:00:00.000Z" });
  assert.equal(first.claimProposal("add:1.1", ["drafting"], "open"), true);
  assert.equal(first.claimProposal("add:1.1", ["open"], "applying"), true);
  first.updateProposal("add:1.1", { progress: '{"written":[1]}' });
  first.recordProposal({ id: "add:2.2", kind: "add", source: "y", createdAt: "2026-11-29T00:01:00.000Z" });
  first.close?.();

  const second = openStore(path);
  const applying = second.findProposal("add:1.1");
  assert.equal(applying?.status, "open", "the card is still on screen");
  assert.equal(applying?.error, "interrupted by a restart");
  assert.equal(applying?.progress, '{"written":[1]}', "the writes already done are kept, so the retry resumes");
  assert.equal(second.claimProposal("add:1.1", ["open"], "applying"), true, "and the next click takes it again");

  const drafting = second.findProposal("add:2.2");
  assert.equal(drafting?.status, "cancelled", "no card was ever drawn, so there is nothing to come back to");
  assert.equal(drafting?.error, "interrupted by a restart");
  assert.equal(second.claimProposal("add:2.2", ["drafting"], "open"), false, "and a late draft does not revive it");
});

test("a restart hands back the rows it reset, in the order it reset them, once", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "zya-")), "s.db");
  const first = openStore(path);
  // A draft that never reached a card, an apply that was in flight, and one that was over.
  first.recordProposal({ id: "add:d", kind: "add", source: "x", createdAt: "2026-11-29T00:00:00.000Z" });
  first.recordProposal({ id: "add:a", kind: "add", source: "y", createdAt: "2026-11-29T00:01:00.000Z" });
  assert.equal(first.claimProposal("add:a", ["drafting"], "open"), true);
  assert.equal(first.claimProposal("add:a", ["open"], "applying"), true);
  first.recordProposal({ id: "add:done", kind: "add", source: "z", createdAt: "2026-11-29T00:02:00.000Z" });
  assert.equal(first.claimProposal("add:done", ["drafting"], "done"), true);
  first.close();

  const second = openStore(path);

  assert.deepEqual(
    second.interrupted().map((row) => [row.id, row.status, row.error]),
    [
      ["add:a", "open", "interrupted by a restart"],
      ["add:d", "cancelled", "interrupted by a restart"],
    ],
    "the applies it reopened, then the drafts it cancelled, and nothing that was over",
  );
  assert.deepEqual(second.interrupted(), [], "the list is handed back once");
  second.close();
});

test("an answered question comes back for the thread it was asked in, oldest first", () => {
  const store = openStore(":memory:");
  store.recordAsk({ ts: "a1", threadTs: "q1", question: "how is Acme?", answer: "On track.", createdAt: "2026-11-27T01:00:00.000Z" });
  store.recordAsk({ ts: "a2", threadTs: "q1", question: "and Globex?", answer: "Waiting.", createdAt: "2026-11-27T02:00:00.000Z" });
  store.recordAsk({ ts: "a3", threadTs: "q9", question: "other thread", answer: "Other.", createdAt: "2026-11-27T03:00:00.000Z" });

  assert.deepEqual(
    store.asksInThread("q1", 3).map((row) => row.ts),
    ["a1", "a2"],
    "the thread's own answers, in the order they were said",
  );
  assert.deepEqual(store.asksInThread("q1", 1).map((row) => row.ts), ["a2"], "the last one, for a follow-up");
  assert.deepEqual(store.asksInThread("q1", 0), []);
  assert.deepEqual(store.asksInThread("nope", 3), []);

  const row = store.asksInThread("q1", 3)[0];
  assert.equal(row.question, "how is Acme?");
  assert.equal(row.answer, "On track.");
  assert.equal(row.createdAt, "2026-11-27T01:00:00.000Z");
  store.close();
});

test("answers older than the cut are pruned, and the rest stays", () => {
  const store = openStore(":memory:");
  store.recordAsk({ ts: "old", threadTs: "q1", question: "an old one", answer: "x", createdAt: "2026-10-01T00:00:00.000Z" });
  store.recordAsk({ ts: "new", threadTs: "q1", question: "a new one", answer: "y", createdAt: "2026-11-27T00:00:00.000Z" });

  assert.equal(store.pruneAsks("2026-10-28T00:00:00.000Z"), 1);
  assert.deepEqual(store.asksInThread("q1", 5).map((row) => row.ts), ["new"], "the column stays for the follow-up");
  assert.equal(store.pruneAsks("2026-10-28T00:00:00.000Z"), 0, "nothing left to prune");
  store.close();
});

test("a question's message ts is claimed once, and the claim survives a failed answer", () => {
  const store = openStore(":memory:");

  assert.equal(store.claimAsk("msg-1", "2026-11-27T01:00:00.000Z"), true, "the first delivery takes it");
  assert.equal(store.claimAsk("msg-1", "2026-11-27T01:00:01.000Z"), false, "a redelivery does not");
  assert.equal(store.claimAsk("msg-2", "2026-11-27T01:00:02.000Z"), true, "another question, another claim");
  assert.equal(store.asksInThread("msg-1", 3).length, 0, "a claim is not an answer: nothing was said yet");
  store.close();
});

test("pruning takes the claims with the answers, and the cutoff is 30 days back", () => {
  const store = openStore(":memory:");
  assert.equal(askCutoff(new Date("2026-11-27T01:00:00.000Z")), "2026-10-28T01:00:00.000Z");

  store.claimAsk("old-claim", "2026-10-01T00:00:00.000Z");
  store.claimAsk("new-claim", "2026-11-27T00:00:00.000Z");
  store.pruneAsks(askCutoff(new Date("2026-11-27T01:00:00.000Z")));

  assert.equal(store.claimAsk("old-claim", "2026-11-27T02:00:00.000Z"), true, "an old claim is gone with its month");
  assert.equal(store.claimAsk("new-claim", "2026-11-27T02:00:00.000Z"), false, "a fresh one stays");
  store.close();
});
