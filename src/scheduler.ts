// The clock. Every minute the scheduler asks: is a slot open right now, and has
// it already run? Slots are weekdays only, and a slot runs at most once.

import { fetchActivity } from "./activity.ts";
import { errMessage } from "./errors.ts";
import type { BoardSource, FetchLike } from "./github.ts";
import { DEFAULT_POLICY, plan, type Policy, type Slot } from "./rules.ts";
import type { Sender } from "./slack.ts";
import type { PingStore } from "./store.ts";
import { addDays, isWeekend, localNow, parseHHMM } from "./time.ts";

export interface SchedulerConfig {
  projectOwner: string;
  projectNumber: number;
  githubToken: string; // the notes-repo activity calls use the same token
  briefTime: string; // HH:MM, ASSISTANT_TZ
  eodTime: string; // HH:MM, ASSISTANT_TZ
  /** owner/repo of the notes, or null: no notes activity at all. */
  notesRepo: string | null;
  /** The policy knobs the env may override: the rest is DEFAULT_POLICY. */
  policy: Partial<Policy>;
}

export interface SchedulerDeps {
  config: SchedulerConfig;
  board: Pick<BoardSource, "fetchBoard">;
  store: PingStore;
  sender: Sender;
  now: () => Date;
  log: (line: string) => void;
  /** The notes-repo calls, injectable so tests never touch the network. */
  fetchFn?: FetchLike;
  /** After every tick, how it ended, for the health endpoint. */
  onTick?: (report: TickReport) => void;
}

/** When a tick finished: read the clock after the work, not when it started. */
export interface TickReport {
  at: Date;
}

/** A slot stays open for two hours; a later tick treats it as missed. */
const SLOT_WINDOW_MINUTES = 120;

/** How far back the plan's history reaches at least. */
const HISTORY_DAYS = 7;

/** After this many failed attempts a slot is given up on, with one last DM. */
export const MAX_SLOT_ATTEMPTS = 3;

interface OpenSlot {
  slot: Slot;
  start: number; // minutes since local midnight
}

function dailySlots(config: SchedulerConfig): OpenSlot[] {
  return [
    { slot: "M", start: parseHHMM(config.briefTime) },
    { slot: "E", start: parseHHMM(config.eodTime) },
  ];
}

/** Never rejects: a scheduler that throws would kill the interval. */
export async function tick(now: Date, deps: SchedulerDeps): Promise<void> {
  try {
    const { date, minutes } = localNow(now);
    if (!isWeekend(date)) {
      for (const s of dailySlots(deps.config)) {
        if (minutes < s.start || minutes >= s.start + SLOT_WINDOW_MINUTES) continue;
        if (deps.store.slotRan(date, s.slot)) continue;
        await runSlot(date, s.slot, now, deps);
      }
    }
  } catch (err) {
    deps.log(`tick failed: ${errMessage(err)}`);
  }
  // The work is done: this is when the tick finished, and what the health
  // endpoint judges for freshness. A slow board or Slack makes it later.
  deps.onTick?.({ at: deps.now() });
}

/**
 * Pings are recorded one by one as they are sent, and the slot is marked only at
 * the end: an error half way leaves the slot unmarked, and the next tick resends
 * only the pings that never went out and, for M, never resends the briefing.
 * After MAX_SLOT_ATTEMPTS failures the slot is closed and the failure is DMed.
 */
async function runSlot(date: string, slot: Slot, now: Date, deps: SchedulerDeps): Promise<void> {
  const { config, store, sender, log } = deps;
  try {
    const board = await deps.board.fetchBoard(config.projectOwner, config.projectNumber);
    // The chase rule looks back waitingChaseDays for a ping of the same item, so
    // the window has to cover that many days.
    const historyDays = Math.max(HISTORY_DAYS, config.policy.waitingChaseDays ?? DEFAULT_POLICY.waitingChaseDays);
    const history = store.historySince(addDays(date, -historyDays));
    const alreadySent = new Set(history.map((p) => p.key));
    const activity = config.notesRepo
      ? await fetchActivity({
          token: config.githubToken,
          repo: config.notesRepo,
          items: board.items,
          history,
          log,
          fetchFn: deps.fetchFn,
        })
      : undefined;
    const result = plan(board.items, date, slot, history, { policy: config.policy, activity });
    const targets = new Map(board.items.map((i) => [i.id, i.target]));

    // The morning is one message, sent once: its rows are recorded in one go, all
    // on that message, and the briefing is recorded last so a retry after any
    // error resends the message and nothing else.
    let rows = 0;
    if (slot === "M" && result.briefing && !store.briefingSent(date, slot)) {
      const message = await sender.sendBriefing(result.briefing, targets);
      // Every row is recorded, menu or not (past the block cap, or a briefing
      // Slack refused as blocks): a board update acks any of them, and the record
      // is what keeps the evening re-ping, the ⚠ line and the chase window alive.
      // menuKeys only says which rows can be acked from the message itself.
      for (const row of result.briefing.rows) {
        store.recordPing({
          key: row.key,
          itemId: row.itemId,
          date,
          slot,
          kind: row.kind,
          sentAt: now.toISOString(),
          channel: message.channel,
          ts: message.ts,
        });
        rows += 1;
      }
      store.recordBriefing(date, slot, now.toISOString());
    }

    // The evening's pings, one message each. The morning sends none: it is all
    // in the briefing, so this loop only has work to do at E.
    let sent = 0;
    for (const ping of result.pings) {
      if (alreadySent.has(ping.key)) continue;
      const message = await sender.sendPing(ping, targets.get(ping.itemId) ?? null);
      store.recordPing({
        key: ping.key,
        itemId: ping.itemId,
        date,
        slot,
        kind: ping.kind,
        sentAt: now.toISOString(),
        channel: message.channel,
        ts: message.ts,
      });
      sent += 1;
    }

    store.markSlotRan(date, slot, now.toISOString());
    log(`${slot} ${date}: ${summary(slot, sent, rows)}`);
  } catch (err) {
    const message = errMessage(err);
    const attempts = store.recordSlotFailure(date, slot, message);
    if (attempts < MAX_SLOT_ATTEMPTS) {
      log(`${slot} ${date} failed (attempt ${attempts} of ${MAX_SLOT_ATTEMPTS}), will retry on the next tick: ${message}`);
      return;
    }
    store.markSlotRan(date, slot, now.toISOString());
    log(`${slot} ${date} failed ${attempts} times, giving up: ${message}`);
    try {
      await sender.sendDm(`zy-assistant: ${slot} ${date} failed ${attempts} times: ${message}`);
    } catch (dmErr) {
      log(`could not report the ${slot} ${date} failure: ${errMessage(dmErr)}`);
    }
  }
}

/** The log line: the morning counts its rows, the evening its pings. */
function summary(slot: Slot, pings: number, rows: number): string {
  if (slot === "M") return `briefing, ${rows} row${rows === 1 ? "" : "s"}`;
  return `${pings} ping${pings === 1 ? "" : "s"}`;
}

/**
 * A tick runner that never overlaps itself: while one tick is in flight, the
 * next one is skipped (the minute after will pick the slot up).
 */
export function createTicker(deps: SchedulerDeps): (now: Date) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return (now: Date): Promise<void> => {
    if (inFlight) {
      deps.log("tick skipped: the previous tick is still running");
      return Promise.resolve();
    }
    inFlight = tick(now, deps).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** Ticks once now and then every intervalMs. Returns a stop function. */
export function startScheduler(deps: SchedulerDeps, intervalMs = 60_000): () => void {
  const runTick = createTicker(deps);
  void runTick(deps.now());
  const timer = setInterval(() => {
    void runTick(deps.now());
  }, intervalMs);
  return () => clearInterval(timer);
}
