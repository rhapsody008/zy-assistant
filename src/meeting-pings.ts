// What to ask ZY about after a meeting, and what the briefing says about his day.
// Pure: the clock, the sent keys and the held snapshot all arrive as arguments,
// and what leaves this module is text and keys. The caller sends the DM, stores
// the key and files the reply.
//
// An ask is a question, so every limit here is about not asking a false one: a
// meeting that has just ended needs a few minutes before "how did it go?" means
// anything, one that ended while the bot was down is a stale ask that reads as
// the bot inventing news, a Saturday asks nothing because the scheduler's slots
// are weekdays only, and a meeting of a few minutes was a check-in that was
// answered by being held, so it is not a question at all.
//
// The snapshot is the intake's, so its freshness decides what is worth saying: an
// expired window holds yesterday's meetings and "how did it go?" about yesterday
// is worse than silence, while a stale one is worked from as it stands (the
// caller already logs the staleness).

import { escapeData } from "./ask.ts";
import type { CalendarEvent, CalendarState } from "./calendar.ts";
import { oneLine } from "./scribe.ts";
import { addDays, isWeekend, localNow, parseHHMM, TZ } from "./time.ts";

const MINUTE = 60_000;

/** The key prefix: a meeting's key is its event id and nothing else's is. */
const KEY_PREFIX = "meeting:";

/** A title past this is cut for the DM. The snapshot has already cut it at 200 characters. */
const TITLE_MAX = 120;

/** The briefing's section never grows past this many lines, the "and N more" one included. */
const SECTION_MAX = 8;

/** One ask: the DM about a meeting that has ended, and the key that makes it once. */
export interface MeetingPing {
  key: string; // "meeting:<event id>", stable per occurrence: the dedupe key
  eventId: string;
  title: string; // as the snapshot holds it, unescaped: `text` carries the escaped line
  start: string; // ISO, as the snapshot holds it
  end: string;
  date: string; // the local date the meeting ended
  text: string; // the DM's text (mrkdwn, no blocks)
}

export interface MeetingPlan {
  pings: MeetingPing[];
}

export interface MeetingPolicy {
  graceMinutes: number; // wait this long after the end before asking (default 5)
  catchUpMinutes: number; // and give up after this long (default 45)
  earliestEnd: string; // HH:MM; a meeting ending before this is not asked about (default "08:00")
  latestEnd: string; // HH:MM; nor after this (default "19:00")
  perDay: number; // at most this many asks a day, however full the day (default 6)
  perDayFloor: number; // and room for at least this many, however light the day (default 4)
  meetingsPerAsk: number; // one ask for every this many askable meetings of the day, rounded up (default 2)
  minAttendees: number; // skip what looks like a personal block (default 1)
  minMinutes: number; // a meeting shorter than this is a check-in, not a question (default 20)
}

/**
 * Today's behaviour, as data: the caller may override any of it. It is exported
 * because the manual quotes these numbers instead of a second copy of them, so
 * what the bot does and what it says it does cannot drift apart.
 */
export const MEETING_POLICY: MeetingPolicy = {
  graceMinutes: 5,
  catchUpMinutes: 45,
  earliestEnd: "08:00",
  latestEnd: "19:00",
  perDay: 6,
  perDayFloor: 4,
  meetingsPerAsk: 2,
  minAttendees: 1,
  minMinutes: 20,
};

/** "HH:MM" from minutes since local midnight. */
function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Cut to `max` characters: the way ask.ts cuts an answer or a reason. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A title as one escaped line: a calendar writes titles by hand, so a newline or
 * a "<" in one must not become a line of its own or a block of its own. Cut
 * before it is escaped, so the cut never lands inside an entity. Pure.
 */
function titleLine(event: CalendarEvent): string {
  return escapeData(cut(oneLine(event.title) || "(no title)", TITLE_MAX));
}

/** "09:00", or "all day" for a block with no clock of its own. */
function whenField(event: CalendarEvent): string {
  return event.allDay ? "all day" : clock(localNow(new Date(event.start), TZ).minutes);
}

const attending = (n: number): string => `${n} attendee${n === 1 ? "" : "s"}`;

/**
 * The DM about one meeting: its title, when it ran, how many were in it, and the
 * ask. It promises only what the caller does, which is file the reply as a note
 * about this meeting. The start is named as well as the end, because "ended at
 * 09:30" alone leaves the length of the meeting to be guessed. Pure.
 */
function pingText(event: CalendarEvent): string {
  const start = clock(localNow(new Date(event.start), TZ).minutes);
  const end = clock(localNow(new Date(event.end), TZ).minutes);
  return (
    `「${titleLine(event)}」 ended at ${end} (${start}–${end}, ${attending(event.attendees)}). ` +
    `How did it go? Reply in this thread and I'll file it as a note about that meeting.`
  );
}

/**
 * Whether an event is ever a candidate for an ask today, apart from how long ago
 * it ended: an all-day block and a solo hold are not meetings, an invitation ZY
 * never answered is nothing to ask about, a meeting too short to have been a
 * conversation is a check-in, and only a meeting that ended on `today`, inside
 * the workday, is a question about work. Pure.
 */
function askable(event: CalendarEvent, today: string, policy: MeetingPolicy): boolean {
  // An all-day block has no "how did it go", and a solo hold is not a meeting.
  if (event.allDay || event.attendees < policy.minAttendees) return false;
  // An invitation ZY never answered is no meeting to ask "how did it go?" about:
  // there is nothing to ask about a meeting that may not happen. The briefing is
  // the other way round and keeps every status, `none` included: it is his day,
  // and an unanswered invite is exactly what he needs to see there.
  if (event.status === "none") return false;
  // A meeting of a few minutes is a check-in that was answered by being held, so
  // there is nothing left to ask. A start or an end that does not parse cannot
  // reach here at all: the snapshot is validated whole before it is held, so a
  // value that does not parse is refused there and never becomes an event.
  if (Date.parse(event.end) - Date.parse(event.start) < policy.minMinutes * MINUTE) return false;
  // The local date of the end, never of the start: a meeting that began yesterday
  // and ends today is today's, and one still running at midnight is not.
  const end = localNow(new Date(event.end), TZ);
  if (end.date !== today) return false;
  // A meeting ending before the workday or after it is not a question about work.
  if (end.minutes < parseHHMM(policy.earliestEnd) || end.minutes > parseHHMM(policy.latestEnd)) return false;
  return true;
}

/**
 * The day's meetings in the order the cap is spent on them: the longest first,
 * then the most attended, then the earliest end, then the id. The id last is what
 * makes the order total, so no pair of meetings can fall back to the snapshot's
 * order, which is the Mac's push order and can swap two double-booked meetings
 * between one push and the next. The same day ranks the same way, at 09:00 and at
 * 17:00, whatever order it arrives in. Pure.
 */
function byWorth(a: CalendarEvent, b: CalendarEvent): number {
  return (
    Date.parse(b.end) - Date.parse(b.start) - (Date.parse(a.end) - Date.parse(a.start)) ||
    b.attendees - a.attendees ||
    Date.parse(a.end) - Date.parse(b.end) ||
    (a.id < b.id ? -1 : 1)
  );
}

/**
 * The asks this moment owes, earliest end first. `sent` is the keys the caller
 * has already stored, and it is the only memory of the day: a key that is in it
 * is never offered again, and the day's cap counts the meeting ones in it.
 */
export function planMeetingPings(args: {
  state: CalendarState | null; // what the intake holds right now
  now: Date;
  sent: ReadonlySet<string>; // keys already asked about today
  policy?: Partial<MeetingPolicy>;
}): MeetingPlan {
  const { state, now } = args;
  // No snapshot is nothing to say, and an expired one is worse than nothing: its
  // window holds yesterday's meetings, so every ask in it would be about a day
  // that is already a note. A stale one is used as it stands.
  if (state === null || state.freshness === "expired") return { pings: [] };

  const policy: MeetingPolicy = { ...MEETING_POLICY, ...args.policy };
  const today = localNow(now, TZ).date;
  // The scheduler's slots are weekdays only: asking on a Saturday about a Saturday
  // meeting would be the bot inventing work.
  if (isWeekend(today)) return { pings: [] };

  const nowMs = now.getTime();
  const graceMs = nowMs - policy.graceMinutes * MINUTE;
  const catchUpMs = nowMs - policy.catchUpMinutes * MINUTE;

  // The day's cap comes from the whole day, not from the asks in flight: a ceiling
  // counted from what is due this minute would drift as the day went on, and the
  // same day would answer differently at 09:00 and at 17:00. What it counts is the
  // meetings that can be asked about at all, so the number the briefing lists is
  // not the number this uses: the briefing keeps the short meetings and the
  // unanswered invites on purpose. A meeting whose ask was missed while the bot was
  // down is still one of the day's meetings, so it counts here even though it is
  // never asked about now.
  const askableToday = state.snapshot.events.filter((event) => askable(event, today, policy));
  const cap = Math.min(
    policy.perDay,
    Math.max(policy.perDayFloor, Math.ceil(askableToday.length / policy.meetingsPerAsk)),
  );

  // Which of the day's meetings the cap is spent on: the ones worth a note. Not by
  // lateness, which is how the day used to be taken: the cap first binds at five
  // askable meetings, and slicing the earliest ends spent it on the morning while the
  // afternoon was silently never asked about. The longest meeting of the day is the
  // one a note is worth most, so length ranks first, and a tie falls back to
  // attendees, then to the end, then to the id, so the order is never the snapshot's.
  // What that costs is a short meeting that has already ended, outranked by a longer
  // one later in the same day that has not happened yet: it is never asked about, and
  // it is still in the briefing. Fewer asks is the point of the release.
  const chosen = new Set(
    // A copy of the day's list, not the snapshot's array: the snapshot is the intake's.
    [...askableToday]
      .sort(byWorth)
      .slice(0, cap)
      .map((event) => event.id),
  );

  const due: CalendarEvent[] = [];
  for (const event of askableToday) {
    // Too soon and ZY is still walking out of the room; too late and the bot was
    // down, and a stale ask is worse than none.
    const endMs = Date.parse(event.end);
    if (endMs > graceMs || endMs < catchUpMs) continue;
    // Not one of the day's chosen few: the cap is for the meetings worth a note.
    if (!chosen.has(event.id)) continue;
    // Already asked about: the key is the ask, so a second one is a second DM.
    if (args.sent.has(`${KEY_PREFIX}${event.id}`)) continue;
    due.push(event);
  }
  // Earliest end first: the day's asks arrive in the order its meetings happened.
  due.sort((a, b) => Date.parse(a.end) - Date.parse(b.end) || Date.parse(a.start) - Date.parse(b.start));

  // The caller passes the keys it has stored for today, so counting the meeting
  // ones is counting today's asks: a key carries no date of its own to read twice,
  // and the set starts again empty at the day's first tick.
  const asked = [...args.sent].filter((key) => key.startsWith(KEY_PREFIX)).length;
  const room = Math.max(0, cap - asked);

  const pings = due.slice(0, room).map(
    (event): MeetingPing => ({
      key: `${KEY_PREFIX}${event.id}`,
      eventId: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      // The end's local date, which the filter above made today's: that is the one
      // day an ask can be about.
      date: today,
      text: pingText(event),
    }),
  );
  return { pings };
}

/**
 * True when an event is on `today` in local time. What counts is the overlap, not
 * the day the start falls on: an all-day block or a late meeting that began
 * yesterday and has not ended is still on today. The end is exclusive, so an event
 * ending at local midnight ends the day before it, the way an all-day block does.
 * Pure.
 */
function onDay(event: CalendarEvent, today: string): boolean {
  if (localNow(new Date(event.start), TZ).date > today) return false;
  const end = localNow(new Date(event.end), TZ);
  const last = end.minutes === 0 ? addDays(end.date, -1) : end.date;
  return last >= today;
}

/**
 * The briefing's section for today: one line per meeting in start order, an
 * all-day block said as such, and no attendees or domains (the briefing is about
 * ZY's day, not the guest list). A day with nothing on it returns []: the
 * briefing must not grow a line that says nothing every single day.
 */
export function meetingSection(state: CalendarState | null, today: string): string[] {
  // No snapshot is nothing to say, and an expired window holds another day's.
  if (state === null || state.freshness === "expired") return [];
  const events = state.snapshot.events
    .filter((event) => onDay(event, today))
    // A solo hold is no more a meeting here than it is to the asks: this is the
    // planner's floor, kept the same on purpose, so the two name the same meetings.
    // The status is not filtered at all, and that part differs on purpose: every
    // answer, `none` included, is ZY's day, and an invitation he has not answered is
    // exactly what the section is for. The asks skip `none`.
    .filter((event) => event.attendees >= MEETING_POLICY.minAttendees)
    // Ordered by start: the day as it runs, whatever order the snapshot holds.
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));
  if (events.length === 0) return [];
  // A crowded day must not swamp the briefing, and the last line says what the cut
  // left out: with a recap line to add, one meeting fewer is shown.
  const room = events.length > SECTION_MAX ? SECTION_MAX - 1 : events.length;
  const lines = events.slice(0, room).map((event) => `• ${whenField(event)} ${titleLine(event)}`);
  if (events.length > room) {
    const left = events.length - room;
    lines.push(`• and ${left} more meeting${left === 1 ? "" : "s"}`);
  }
  return lines;
}
