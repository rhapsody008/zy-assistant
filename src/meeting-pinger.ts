// Sending the asks after meetings: one DM per meeting the day's cap picked, and
// recorded the moment it goes out, so a crash between two asks never re-asks the
// ones already sent. It rides the scheduler's tick, which is why nothing here
// throws.
//
// What is owed is the planner's business (meeting-pings.ts); this is the side
// that touches Slack and SQLite. A log line carries ids and counts only: the
// title goes into the store, where the reply's note topic waits for it, and never
// onto a line.

import type { CalendarIntake } from "./calendar.ts";
import { errMessage } from "./errors.ts";
import { planMeetingPings, type MeetingPolicy } from "./meeting-pings.ts";
import type { Sent, Sender } from "./slack.ts";
import type { MeetingPingStore } from "./store.ts";
import { localNow, TZ } from "./time.ts";

export interface MeetingPingerDeps {
  /** The one snapshot the bot holds: the tick before this one has just refreshed it. */
  intake: CalendarIntake;
  store: MeetingPingStore;
  /** Only the DM: an ask has no buttons and nothing to click. */
  sender: Pick<Sender, "sendDm">;
  now: () => Date;
  log: (line: string) => void;
  /** Overrides of the planner's policy: the defaults are today's behaviour. */
  policy?: Partial<MeetingPolicy>;
}

export interface MeetingPinger {
  /** Never rejects: the tick it rides must not die over a DM. */
  run(now: Date): Promise<void>;
}

export function createMeetingPinger(deps: MeetingPingerDeps): MeetingPinger {
  // A run is guarded against the one after it, the way createTicker guards a tick and
  // for the same reason: the tick that starts a run does not wait for it (one sendDm
  // can outlast a minute, with retries and a timeout on it), so the next tick would
  // plan from a store this run has not written yet and ask the same meeting twice.
  // A flag rather than createTicker's promise: a skipped run has nothing to await.
  let inFlight = false;
  return {
    async run(now: Date): Promise<void> {
      if (inFlight) {
        deps.log("meeting pings skipped: the previous run is still running");
        return;
      }
      inFlight = true;
      try {
        await sendDue(deps, now);
      } finally {
        inFlight = false;
      }
    },
  };
}

/**
 * One run's work: the plan, then the DMs, each recorded as it goes out. Never
 * throws, so the flag around it is only ever cleared by the finally.
 */
async function sendDue(deps: MeetingPingerDeps, now: Date): Promise<void> {
  try {
    // The day's asks so far are the planner's only memory, and its cap counts
    // the meeting keys in them: the date is the local one the tick's clock is on.
    const sent = deps.store.meetingPingKeys(localNow(now, TZ).date);
    const state = deps.intake.current(now);
    for (const ping of planMeetingPings({ state, now, sent, policy: deps.policy }).pings) {
      let message: Sent;
      try {
        // One at a time, and each recorded before the next is sent: a crash
        // between two asks must not re-ask the ones that went out.
        message = await deps.sender.sendDm(ping.text);
      } catch (err) {
        // Nothing after a failed send could be trusted to have arrived, so the
        // run stops here rather than at the end: the next tick offers this ask
        // again, and only what the store still lacks.
        deps.log(`meeting ping ${ping.eventId}: failed: ${errMessage(err)}`);
        return;
      }
      deps.store.recordMeetingPing({
        key: ping.key,
        eventId: ping.eventId,
        date: ping.date,
        title: ping.title,
        // When it went out, read after the send rather than at the tick's start.
        sentAt: deps.now().toISOString(),
        channel: message.channel,
        ts: message.ts,
      });
      deps.log(`meeting ping ${ping.eventId}: sent`);
    }
  } catch (err) {
    // The snapshot, the plan or the store: one line for the whole run, and the
    // next tick starts over from the keys that are stored.
    deps.log(`meeting pings: ${errMessage(err)}`);
  }
}
