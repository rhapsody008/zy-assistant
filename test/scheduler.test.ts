// The scheduler with a fake clock in Asia/Singapore (UTC+8), a fake board, a
// fake store and a fake Slack. Nothing here waits for a real minute.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board } from "../src/github.ts";
import type { Item } from "../src/rules.ts";
import { createTicker, tick, type SchedulerConfig, type SchedulerDeps } from "../src/scheduler.ts";
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
    type: null,
    stage: null,
    track: null,
    account: null,
    cadence: null,
    parentUrl: null,
    contentId: null,
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

const CONFIG: SchedulerConfig = {
  projectOwner: "rhapsody008",
  projectNumber: 1,
  githubToken: "test-token",
  briefTime: "09:00",
  eodTime: "17:30",
  notesRepo: null,
  policy: {},
};

function harness(items: Item[], overrides: Partial<SchedulerDeps> = {}) {
  const store = new FakeStore();
  const sender = new FakeSender();
  const logs: string[] = [];
  const board: Board = { projectId: "PVT_1", title: "Board", fields: new Map(), items };
  const deps: SchedulerDeps = {
    config: CONFIG,
    board: { fetchBoard: async () => board },
    store,
    sender,
    now: () => new Date(NINE),
    log: (line) => logs.push(line),
    ...overrides,
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

test("the morning slot sends ONE briefing, records its rows, and never runs twice", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  await at(deps, NINE);

  assert.equal(sender.briefings.length, 1, "one message, whatever it holds");
  assert.equal(sender.dms.length, 0, "the briefing is no plain DM");
  assert.deepEqual(sender.sent, [], "and the morning sends no ping of its own");
  assert.equal(store.slotRan("2026-11-23", "M"), true);
  assert.equal(store.briefingSent("2026-11-23", "M"), true);
  assert.match(logs.join("\n"), /^M 2026-11-23: briefing, 3 rows$/m);

  // Every row is recorded, all on the briefing's own message, so a reply or the
  // evening sweep can find the item behind it.
  const rows = sender.briefings[0].rows;
  assert.deepEqual(rows.map((row) => row.itemId), ["3", "1", "2"], "the late row first, then the deadlines");
  for (const row of rows) {
    const record = store.findByKey(row.key);
    assert.ok(record !== null, `${row.itemId} is recorded`);
    assert.equal(record.channel, "DM");
    assert.equal(record.ts, "brief-1");
    assert.equal(record.slot, "M");
    assert.equal(record.ackedAt, null);
  }

  await at(deps, NINE_OH_ONE);
  assert.equal(sender.briefings.length, 1, "nothing is sent again");
  assert.equal(store.historySince("2026-11-23").length, 3, "and no row is recorded twice");
});

test("a briefing already recorded sends nothing at all", async () => {
  const { deps, sender, store } = harness(ITEMS);
  store.recordBriefing("2026-11-23", "M", NINE);

  await at(deps, NINE);
  assert.deepEqual(sender.briefings, [], "the retry sends nothing: the message is out");
  assert.deepEqual(store.historySince("2026-11-23"), [], "not even the rows");
  assert.equal(store.slotRan("2026-11-23", "M"), true, "and the slot is closed");
});

test("a briefing Slack refuses as blocks goes out as text, and every row is still recorded", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  sender.invalidBlocks = true;

  await at(deps, NINE);
  assert.equal(sender.briefings.length, 1);
  // There is no menu to click, but the rows are recorded all the same, on the
  // text message's ts: the evening's re-ping, the ⚠ line and the chase window
  // all read the history, and a board update still acks a row.
  for (const row of sender.briefings[0].rows) {
    const record = store.findByKey(row.key);
    assert.ok(record !== null, `${row.itemId} is recorded`);
    assert.equal(record.ts, "brief-1", "on the fallback message's own ts");
  }
  assert.equal(store.briefingSent("2026-11-23", "M"), true);
  assert.match(logs.join("\n"), /^M 2026-11-23: briefing, 3 rows$/m);
});

test("a row that got no menu is still recorded: a board update acks it and the evening can re-ping it", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  sender.menuLimit = 2; // the blocks left no room for the third row's menu

  await at(deps, NINE);
  const rows = sender.briefings[0].rows;
  assert.equal(rows.length, 3, "the row is still in the message, as text");
  for (const row of rows) assert.ok(store.findByKey(row.key) !== null, `${row.itemId} is recorded`);
  assert.match(logs.join("\n"), /^M 2026-11-23: briefing, 3 rows$/m);
  assert.equal(store.briefingSent("2026-11-23", "M"), true);
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
  const { deps, sender, store } = harness([item("9", { target: "2026-11-23" })]);
  store.recordPing({
    key: "2026-11-23:E:9",
    itemId: "9",
    date: "2026-11-23",
    slot: "E",
    kind: "ping",
    sentAt: SEVENTEEN_THIRTY,
    channel: "DM",
    ts: "ts-old",
  });
  await at(deps, SEVENTEEN_THIRTY);
  assert.deepEqual(sender.sent, []);
  assert.equal(store.slotRan("2026-11-23", "E"), true);
});

test("a failed briefing leaves the slot unmarked, and the retry sends it once", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  sender.failBriefingOn = 1;

  await at(deps, NINE);
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  assert.equal(store.briefingSent("2026-11-23", "M"), false, "nothing went out, so nothing is recorded");
  assert.deepEqual(store.historySince("2026-11-23"), []);
  assert.match(logs.join("\n"), /slack is down/);

  await at(deps, NINE_OH_ONE);
  assert.equal(store.slotRan("2026-11-23", "M"), true);
  assert.equal(sender.briefings.length, 1, "one briefing, not two");
  assert.equal(store.historySince("2026-11-23").length, 3, "and its rows once, not twice");
});

test("an evening ping that fails leaves the slot unmarked, and the retry sends only the rest", async () => {
  const due = (id: string): Item => item(id, { target: "2026-11-23" });
  const { deps, sender, store, logs } = harness([due("1"), due("2"), due("3")]);
  sender.failOnAttempt = 2;

  await at(deps, SEVENTEEN_THIRTY);
  assert.equal(store.slotRan("2026-11-23", "E"), false);
  assert.deepEqual(sender.sent.map((p) => p.itemId), ["1"]);
  assert.match(logs.join("\n"), /slack is down/);

  await at(deps, "2026-11-23T09:31:00Z");
  assert.equal(store.slotRan("2026-11-23", "E"), true);
  assert.deepEqual(sender.sent.map((p) => p.itemId), ["1", "2", "3"], "item 1 is not sent twice");
});

test("two overlapping ticks send the briefing, and record its rows, exactly once", async () => {
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

  assert.equal(sender.briefings.length, 1, "the briefing went out once");
  assert.equal(store.historySince("2026-11-23").length, 3, "its three rows are recorded once");
  assert.equal(store.slotRan("2026-11-23", "M"), true);
});

test("a slot that fails every time gives up after three tries with a DM", async () => {
  const { deps, sender, store, logs } = harness(ITEMS);
  sender.alwaysFailBriefing = true;
  const runTick = createTicker(deps);

  await runTick(new Date(NINE));
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  assert.equal(sender.briefings.length, 0, "nothing went out");

  await runTick(new Date("2026-11-23T01:01:00Z"));
  assert.equal(store.slotRan("2026-11-23", "M"), false);
  assert.equal(sender.dms.length, 0, "no DM before the third failure");

  await runTick(new Date("2026-11-23T01:02:00Z"));
  assert.equal(store.slotRan("2026-11-23", "M"), true, "three failures close the slot");
  assert.equal(sender.dms.length, 1, "one failure DM");
  assert.match(sender.dms[0], /^zy-assistant: M 2026-11-23 failed 3 times: slack is down$/);
  assert.match(logs.join("\n"), /failed 3 times, giving up/);

  await runTick(new Date("2026-11-23T01:03:00Z"));
  assert.equal(sender.dms.length, 1, "a closed slot is not retried");
});

test("every tick reports when it finished, quiet ticks included", async () => {
  const { deps } = harness(ITEMS);
  const reports: unknown[] = [];
  // The clock advances while the tick works: a report must carry the time the
  // work ended, never the time the tick was handed.
  const finishes = ["2026-11-23T01:00:07.000Z", "2026-11-23T01:01:03.000Z", "2026-11-28T01:00:02.000Z"];
  let next = 0;
  const reporting: SchedulerDeps = {
    ...deps,
    now: () => new Date(finishes[next++] ?? finishes[finishes.length - 1]),
    onTick: (report) => reports.push(report),
  };

  await tick(new Date(NINE), reporting); // runs M
  await tick(new Date(NINE_OH_ONE), reporting); // M already ran
  await tick(new Date(SATURDAY_NINE), reporting); // the weekend is quiet

  assert.deepEqual(
    reports,
    finishes.map((at) => ({ at: new Date(at) })),
    "the report time is the clock after the work, and the report carries nothing else",
  );
});

test("notes activity is read before the plan and an ack clears the evening re-ping", async () => {
  const due = item("9", { target: "2026-11-23", account: "Acme" });
  const urls: string[] = [];
  const { deps, sender } = harness([due], {
    config: { ...CONFIG, notesRepo: "acme/notes" },
    fetchFn: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify([{ commit: { committer: { date: "2026-11-23T03:00:00Z" } } }]), { status: 200 });
    },
  });

  await at(deps, NINE); // the morning's rows are recorded at 01:00Z, nothing is unacked yet
  assert.deepEqual(urls, [], "no unacked row, no notes call");

  await at(deps, SEVENTEEN_THIRTY);
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    "https://api.github.com/repos/acme/notes/commits?path=Accounts/Acme&since=2026-11-23T01%3A00%3A00.000Z&per_page=20",
  );
  assert.deepEqual(sender.sent.map((p) => p.kind), ["ping"], "the commit acked the morning's row, so the sweep does not re-ping");
});

test("a broken notes repo is logged and the slot still runs", async () => {
  const due = item("9", { target: "2026-11-23", account: "Acme" });
  const { deps, sender, store, logs } = harness([due], {
    config: { ...CONFIG, notesRepo: "acme/notes" },
    fetchFn: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  store.recordPing({
    key: "2026-11-23:M:9",
    itemId: "9",
    date: "2026-11-23",
    slot: "M",
    kind: "ping",
    sentAt: NINE,
    channel: "DM",
    ts: "ts-old",
  });

  await at(deps, SEVENTEEN_THIRTY);
  assert.equal(sender.sent.length, 1, "the evening ping still went out");
  assert.match(logs.join("\n"), /notes activity for Acme failed, ignored: getaddrinfo ENOTFOUND/);
});

test("a rejected notes repo is logged and the slot still runs", async () => {
  const due = item("9", { target: "2026-11-23", account: "Acme" });
  const { deps, sender, store, logs } = harness([due], {
    config: { ...CONFIG, notesRepo: "acme/notes" },
    fetchFn: async () => new Response("nope", { status: 404 }),
  });
  store.recordPing({
    key: "2026-11-23:M:9",
    itemId: "9",
    date: "2026-11-23",
    slot: "M",
    kind: "ping",
    sentAt: NINE,
    channel: "DM",
    ts: "ts-old",
  });

  await at(deps, SEVENTEEN_THIRTY);
  assert.equal(sender.sent.length, 1);
  assert.match(logs.join("\n"), /notes activity for Acme: GitHub API 404, ignored/);
});

test("the env's policy knobs reach the rules", async () => {
  const waiting = item("9", { status: "Waiting", updatedAt: "2026-11-21T00:00:00.000Z" }); // 2 days
  const { deps, sender } = harness([waiting], { config: { ...CONFIG, policy: { waitingChaseDays: 1 } } });

  await at(deps, NINE);
  assert.match(sender.briefings[0].rows[0].text, /chase them\?/);
});

test("the history window covers waitingChaseDays, so a chase already made is seen", async () => {
  // 10 days: wider than the seven days the other rules need. The ping below is
  // 9 days old, so only the widened window can see it.
  const waiting = item("9", { status: "Waiting", waitingOn: "Acme", updatedAt: "2026-11-01T00:00:00.000Z" });
  const { deps, sender, store } = harness([waiting], { config: { ...CONFIG, policy: { waitingChaseDays: 10 } } });
  store.recordPing({
    key: "2026-11-14:M:9",
    itemId: "9",
    date: "2026-11-14",
    slot: "M",
    kind: "ping",
    sentAt: "2026-11-14T01:00:00.000Z",
    channel: "DM",
    ts: "ts-old",
  });

  await at(deps, NINE);
  assert.deepEqual(sender.briefings[0].rows, [], "pinged 9 days ago: not chased again this morning");
});
