// The clock. Every minute the scheduler asks: is a slot open right now, and has
// it already run? Slots are weekdays only, and a slot runs at most once.

import type { BoardSource } from "./github.ts";
import { plan, type Slot } from "./rules.ts";
import type { Sender } from "./slack.ts";
import type { PingStore } from "./store.ts";
import { addDays, isWeekend, localNow, parseHHMM } from "./time.ts";

export interface SchedulerConfig {
  projectOwner: string;
  projectNumber: number;
  briefTime: string; // HH:MM, ASSISTANT_TZ
  eodTime: string; // HH:MM, ASSISTANT_TZ
}

export interface SchedulerDeps {
  config: SchedulerConfig;
  board: Pick<BoardSource, "fetchBoard">;
  store: PingStore;
  sender: Sender;
  now: () => Date;
  log: (line: string) => void;
  /** After every tick, how it ended, for the health endpoint. */
  onTick?: (report: TickReport) => void;
}

/** When a tick finished: read the clock after the work, not when it started. */
export interface TickReport {
  at: Date;
}

/** A slot stays open for two hours; a later tick treats it as missed. */
const SLOT_WINDOW_MINUTES = 120;

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

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    deps.log(`tick failed: ${reason(err)}`);
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
    const history = store.historySince(addDays(date, -7));
    const alreadySent = new Set(history.map((p) => p.key));
    const result = plan(board.items, date, slot, history);

    if (slot === "M" && result.briefing && !store.briefingSent(date, slot)) {
      await sender.sendDm(result.briefing);
      store.recordBriefing(date, slot, now.toISOString());
    }

    let sent = 0;
    for (const ping of result.pings) {
      if (alreadySent.has(ping.key)) continue;
      const message = await sender.sendPing(ping);
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
    log(`${slot} ${date}: ${summary(sent, result.briefing !== null && slot === "M")}`);
  } catch (err) {
    const message = reason(err);
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
      log(`could not report the ${slot} ${date} failure: ${reason(dmErr)}`);
    }
  }
}

function summary(pings: number, briefing: boolean): string {
  const parts = [`${pings} ping${pings === 1 ? "" : "s"}`];
  if (briefing) parts.push("briefing");
  return parts.join(", ");
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
