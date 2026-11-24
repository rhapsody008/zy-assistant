// The asks after a meeting and the briefing's section, with the clock, the sent
// keys and the snapshot all passed in: no Mac, no store, no Slack. Wall-clock
// times are Singapore's, the suite's default ASSISTANT_TZ, and the days are real
// ones (Tue 1 Dec 2026 is a Tuesday).
//
// Synthetic names only: "demo.example", and the event ids the Mac would derive.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarEvent, CalendarState } from "../src/calendar.ts";
import { meetingSection, planMeetingPings, type MeetingPlan, type MeetingPolicy } from "../src/meeting-pings.ts";

const MINUTE = 60_000;

/** A Singapore wall-clock instant. */
const sg = (text: string): Date => new Date(`${text}+08:00`);

/** The same instant as the ISO text the snapshot holds. */
const at = (text: string): string => sg(text).toISOString();

/** Tue 1 Dec 2026, 10:00 local: the clock nearly every test is read at. */
const NOW = sg("2026-12-01T10:00");

/** Sat 5 Dec 2026, 10:00 local. */
const SAT = sg("2026-12-05T10:00");

/** Sun 6 Dec 2026, 10:00 local. */
const SUN = sg("2026-12-06T10:00");

/** One event as the snapshot holds it, with whatever the test changes. */
function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "9f2c41d07ab3e6c1",
    start: at("2026-12-01T09:00"),
    end: at("2026-12-01T09:30"),
    allDay: false,
    title: "Acme weekly sync",
    domains: ["demo.example"],
    attendees: 6,
    status: "accepted",
    ...over,
  };
}

/** A meeting that ended `minutes` before `from`, after running half an hour. */
function ended(minutes: number, over: Partial<CalendarEvent> = {}, from: Date = NOW): CalendarEvent {
  const end = from.getTime() - minutes * MINUTE;
  return event({ start: new Date(end - 30 * MINUTE).toISOString(), end: new Date(end).toISOString(), ...over });
}

/** The state the intake would hold, with the freshness the test wants. */
function held(events: CalendarEvent[], over: Partial<CalendarState> = {}): CalendarState {
  return {
    snapshot: {
      generatedAt: at("2026-12-01T07:30"),
      window: { start: at("2026-12-01T00:00"), end: at("2026-12-02T00:00") },
      events,
    },
    readAt: NOW,
    freshness: "fresh",
    ...over,
  };
}

/** The plan, defaulted to the test's clock and to nothing sent yet. */
function planned(args: {
  state: CalendarState | null;
  now?: Date;
  sent?: Iterable<string>;
  policy?: Partial<MeetingPolicy>;
}): MeetingPlan {
  return planMeetingPings({
    state: args.state,
    now: args.now ?? NOW,
    sent: new Set(args.sent ?? []),
    policy: args.policy,
  });
}

const keys = (plan: MeetingPlan): string[] => plan.pings.map((ping) => ping.key);

// ---- Which meetings ---------------------------------------------------------

test("a meeting that ended six minutes ago is asked about, in the bot's voice", () => {
  const plan = planned({ state: held([ended(6)]) });
  assert.deepEqual(plan.pings, [
    {
      key: "meeting:9f2c41d07ab3e6c1",
      eventId: "9f2c41d07ab3e6c1",
      title: "Acme weekly sync",
      start: new Date(NOW.getTime() - 36 * MINUTE).toISOString(),
      end: new Date(NOW.getTime() - 6 * MINUTE).toISOString(),
      date: "2026-12-01",
      text:
        "「Acme weekly sync」 ended at 09:54 (09:24–09:54, 6 attendees). " +
        "How did it go? Reply in this thread and I'll file it as a note about that meeting.",
    },
  ]);
});

test("a meeting that ended four minutes ago is too fresh: ZY is still walking out", () => {
  assert.deepEqual(planned({ state: held([ended(4)]) }).pings, []);
  // Five minutes is the bound itself, and a meeting that ended exactly then is asked about.
  assert.equal(planned({ state: held([ended(5)]) }).pings.length, 1);
});

test("a meeting that ended fifty minutes ago is too old: the bot was down", () => {
  assert.deepEqual(planned({ state: held([ended(50)]) }).pings, []);
  // Forty-five minutes is the bound itself, and is still today's question.
  assert.equal(planned({ state: held([ended(45)]) }).pings.length, 1);
});

test("a meeting ending after the latest end, or before the earliest, is not a question about work", () => {
  // The 20:00 meeting is ten minutes old: only the bound of the workday leaves it out.
  const evening = sg("2026-12-01T20:10");
  const atEight = event({ start: at("2026-12-01T19:30"), end: at("2026-12-01T20:00") });
  assert.deepEqual(planned({ state: held([atEight]), now: evening }).pings, []);
  assert.deepEqual(keys(planned({ state: held([atEight]), now: evening, policy: { latestEnd: "20:00" } })), [
    "meeting:9f2c41d07ab3e6c1",
  ]);

  const morning = sg("2026-12-01T08:20");
  const early = event({ start: at("2026-12-01T07:20"), end: at("2026-12-01T07:50") });
  assert.deepEqual(planned({ state: held([early]), now: morning }).pings, []);
  assert.deepEqual(keys(planned({ state: held([early]), now: morning, policy: { earliestEnd: "07:30" } })), [
    "meeting:9f2c41d07ab3e6c1",
  ]);
});

test("a meeting ending exactly at the workday's edges is still a question", () => {
  // 08:00 and 19:00 are the bounds themselves, and both are kept: a meeting that
  // ended then ended inside the workday.
  const early = event({ start: at("2026-12-01T07:30"), end: at("2026-12-01T08:00") });
  assert.deepEqual(keys(planned({ state: held([early]), now: sg("2026-12-01T08:10") })), ["meeting:9f2c41d07ab3e6c1"]);

  const late = event({ id: "0000000000000002", start: at("2026-12-01T18:30"), end: at("2026-12-01T19:00") });
  assert.deepEqual(keys(planned({ state: held([late]), now: sg("2026-12-01T19:10") })), ["meeting:0000000000000002"]);
});

test("a meeting that ended just before midnight is not asked about the next morning", () => {
  const late = event({ start: at("2026-12-01T23:20"), end: at("2026-12-01T23:50") });
  // The window is open and latestEnd allows it: what leaves it out is the day.
  assert.equal(planned({ state: held([late]), now: sg("2026-12-01T23:55"), policy: { latestEnd: "23:59" } }).pings.length, 1);
  assert.deepEqual(planned({ state: held([late]), now: sg("2026-12-02T00:20"), policy: { latestEnd: "23:59" } }).pings, []);
});

test("a weekend day asks nothing, and the same meeting on a Tuesday is asked about", () => {
  assert.deepEqual(planned({ state: held([ended(10, {}, SAT)]), now: SAT }).pings, []);
  assert.deepEqual(planned({ state: held([ended(10, {}, SUN)]), now: SUN }).pings, []);
  assert.equal(planned({ state: held([ended(10)]), now: NOW }).pings.length, 1);
});

test("an all-day block and a solo hold are skipped, and the meeting beside them is asked about", () => {
  const offsite = event({
    id: "0000000000000001",
    allDay: true,
    title: "Offsite",
    start: at("2026-12-01T00:00"),
    end: at("2026-12-02T00:00"),
  });
  const solo = ended(10, { id: "0000000000000002", title: "Hold", attendees: 0 });
  assert.deepEqual(keys(planned({ state: held([offsite, solo, ended(15)]) })), ["meeting:9f2c41d07ab3e6c1"]);
  // minAttendees is the caller's: one attendee passes the default floor of one.
  const one = ended(20, { id: "0000000000000003", title: "Focus", attendees: 1 });
  assert.deepEqual(keys(planned({ state: held([one]) })), ["meeting:0000000000000003"]);
  assert.deepEqual(planned({ state: held([one]), policy: { minAttendees: 2 } }).pings, [], "a solo hold is not a meeting");
});

test("the asks arrive in the order the meetings ended, whatever order the snapshot holds", () => {
  const byEnd = (minutes: number, id: string): CalendarEvent => ended(minutes, { id });
  const plan = planned({
    state: held([byEnd(10, "0000000000000003"), byEnd(30, "0000000000000001"), byEnd(20, "0000000000000002")]),
  });
  assert.deepEqual(keys(plan), ["meeting:0000000000000001", "meeting:0000000000000002", "meeting:0000000000000003"], "the oldest end first");
});

test("a meeting that began yesterday and ends today is asked about today", () => {
  const late = sg("2026-12-01T08:30");
  const overnight = event({ start: at("2026-11-30T23:00"), end: at("2026-12-01T08:10") });
  const plan = planned({ state: held([overnight]), now: late });
  assert.equal(plan.pings.length, 1);
  assert.equal(plan.pings[0].date, "2026-12-01");
  assert.match(plan.pings[0].text, /^「Acme weekly sync」 ended at 08:10 \(23:00–08:10, 6 attendees\)\. /);
});

// ---- The cap and the dedupe ------------------------------------------------

test("the cap counts the asks already made today and stops at it", () => {
  const sent = ["meeting:0000000000000011", "meeting:0000000000000012", "meeting:0000000000000013", "meeting:0000000000000014", "meeting:0000000000000015"];
  // The item pings of the day are in the same set and are not asks about meetings.
  const withItems = [...sent, "2026-12-01:M:notes#52", "2026-12-01:E:notes#53"];
  const three = [ended(10, { id: "0000000000000002" }), ended(20, { id: "0000000000000001" }), ended(30, { id: "0000000000000003" })];
  const plan = planned({ state: held(three), sent: withItems });
  assert.deepEqual(keys(plan), ["meeting:0000000000000003"], "one left of the day's six, and it is the earliest end");

  assert.deepEqual(planned({ state: held(three), sent: [...withItems, "meeting:0000000000000016"] }).pings, [], "the day is full");
  // perDay is the caller's, and a smaller day says so.
  assert.deepEqual(keys(planned({ state: held(three), sent, policy: { perDay: 5 } })), []);
});

test("the day's cap counts meeting asks only, not the pings beside them", () => {
  // Six keys of the day that are no asks about a meeting: they fill none of the cap.
  const others = Array.from({ length: 6 }, (_, i) => `2026-12-01:E:notes#${i}`);
  const one = ended(10, { id: "0000000000000002" });
  assert.deepEqual(keys(planned({ state: held([one]), sent: others })), ["meeting:0000000000000002"]);
});

test("an invitation ZY never answered is skipped, and a tentative one is asked about", () => {
  assert.deepEqual(planned({ state: held([ended(10, { status: "none" })]) }).pings, [], "nothing to ask about a meeting that may not happen");
  assert.deepEqual(keys(planned({ state: held([ended(10, { status: "tentative" })]) })), ["meeting:9f2c41d07ab3e6c1"]);
  assert.deepEqual(keys(planned({ state: held([ended(10, { status: "organizer" })]) })), ["meeting:9f2c41d07ab3e6c1"]);
});

test("a key already in sent is not offered again", () => {
  const once = ended(10, { id: "0000000000000001" });
  const twice = ended(20, { id: "0000000000000002" });
  const plan = planned({ state: held([once, twice]), sent: ["meeting:0000000000000001"] });
  assert.deepEqual(keys(plan), ["meeting:0000000000000002"]);
  assert.deepEqual(planned({ state: held([once, twice]), sent: ["meeting:0000000000000001", "meeting:0000000000000002"] }).pings, []);
});

// ---- Nothing to say, say nothing -------------------------------------------

test("no snapshot and an expired one both ask nothing", () => {
  assert.deepEqual(planned({ state: null }), { pings: [] });
  assert.deepEqual(planned({ state: held([ended(10)], { freshness: "expired" }) }), { pings: [] });
  assert.deepEqual(meetingSection(null, "2026-12-01"), []);
  assert.deepEqual(meetingSection(held([event()], { freshness: "expired" }), "2026-12-01"), []);
});

test("a stale snapshot is worked from as it stands", () => {
  // Today's push has not arrived: the caller logs that, and today's meetings are still today's.
  assert.equal(planned({ state: held([ended(10)], { freshness: "stale" }) }).pings.length, 1);
  assert.deepEqual(meetingSection(held([event()], { freshness: "stale" }), "2026-12-01"), ["• 09:00 Acme weekly sync"]);
});

// ---- The text --------------------------------------------------------------

test("a title is escaped, collapsed to one line, and clipped when it is absurd", () => {
  const plan = planned({ state: held([ended(10, { title: "R&D sync\n  with   demo <b>demo.example</b>" })]) });
  assert.match(plan.pings[0].text, /^「R&amp;D sync with demo &lt;b&gt;demo\.example&lt;\/b&gt;」 /);

  const long = planned({ state: held([ended(10, { title: "a".repeat(300) })]) });
  const title = long.pings[0].text.slice(1, long.pings[0].text.indexOf("」"));
  assert.equal(title.length, 120);
  assert.ok(title.endsWith("…"), "the cut is said");
  assert.equal(long.pings[0].title.length, 300, "the title field stays as the snapshot holds it");

  assert.match(planned({ state: held([ended(10, { title: "   " })]) }).pings[0].text, /^「\(no title\)」 /);
});

// ---- The briefing's section ------------------------------------------------

test("the section renders today's meetings in start order, an all-day one as all day", () => {
  const meetings = [
    event({ id: "0000000000000003", title: "Offsite", allDay: true, start: at("2026-12-01T00:00"), end: at("2026-12-02T00:00") }),
    event({ id: "0000000000000002", title: "Demo recap", start: at("2026-12-01T14:00"), end: at("2026-12-01T15:00") }),
    event({ id: "0000000000000001", title: "Acme weekly sync", start: at("2026-12-01T09:00"), end: at("2026-12-01T09:30") }),
  ];
  assert.deepEqual(meetingSection(held(meetings), "2026-12-01"), [
    "• all day Offsite",
    "• 09:00 Acme weekly sync",
    "• 14:00 Demo recap",
  ]);
});

test("the section caps at eight lines and says how many it left out", () => {
  const busy = Array.from({ length: 10 }, (_, i) =>
    event({
      id: `${i}`.padStart(16, "0"),
      title: `Meeting ${i}`,
      start: at(`2026-12-01T${String(9 + i).padStart(2, "0")}:00`),
      end: at(`2026-12-01T${String(9 + i).padStart(2, "0")}:30`),
    }),
  );
  const lines = meetingSection(held(busy), "2026-12-01");
  assert.equal(lines.length, 8);
  assert.equal(lines[0], "• 09:00 Meeting 0");
  assert.equal(lines[6], "• 15:00 Meeting 6");
  assert.equal(lines[7], "• and 3 more meetings");

  const nine = busy.slice(0, 9);
  assert.equal(meetingSection(held(nine), "2026-12-01").at(-1), "• and 2 more meetings");
  assert.deepEqual(
    meetingSection(held(busy.slice(0, 8)), "2026-12-01").length,
    8,
    "eight fit, so no recap line is added",
  );
});

test("the section is the day as it overlaps, not the day the start falls on", () => {
  // A block that began yesterday and has not ended is still on today.
  const twoDays = event({ id: "0000000000000001", title: "Offsite", allDay: true, start: at("2026-11-30T00:00"), end: at("2026-12-02T00:00") });
  // One that began yesterday and ran past midnight is today's, at its start's clock.
  const overnight = event({ id: "0000000000000002", title: "Came from yesterday", start: at("2026-11-30T23:00"), end: at("2026-12-01T01:00") });
  // One that ended at midnight does not reach into today.
  const endedAtMidnight = event({ id: "0000000000000003", title: "Yesterday's offsite", allDay: true, start: at("2026-11-30T00:00"), end: at("2026-12-01T00:00") });
  // And one that has not started yet is not today's either.
  const tomorrow = event({ id: "0000000000000004", title: "Tomorrow's sync", start: at("2026-12-02T09:00"), end: at("2026-12-02T09:30") });
  assert.deepEqual(meetingSection(held([twoDays, overnight, endedAtMidnight, tomorrow]), "2026-12-01"), [
    "• all day Offsite",
    "• 23:00 Came from yesterday",
  ]);
});

test("the section keeps every status, an invitation ZY has not answered included", () => {
  // It is his day, and an unanswered invite is exactly what he needs to see: the
  // asks are the other way round and skip it.
  const meetings = [
    event({ id: "0000000000000001", title: "Acme weekly sync", status: "accepted" }),
    event({ id: "0000000000000002", title: "Globex kickoff", status: "none" }),
    event({ id: "0000000000000003", title: "Initech demo", status: "tentative" }),
  ];
  assert.deepEqual(meetingSection(held(meetings), "2026-12-01"), [
    "• 09:00 Acme weekly sync",
    "• 09:00 Globex kickoff",
    "• 09:00 Initech demo",
  ]);
});

test("the section leaves a solo hold out, the way the asks do", () => {
  const meetings = [event({ id: "0000000000000001", title: "Hold", attendees: 0 }), event({ id: "0000000000000002", title: "Acme weekly sync" })];
  assert.deepEqual(meetingSection(held(meetings), "2026-12-01"), ["• 09:00 Acme weekly sync"]);
});

test("the section escapes a title and says nothing for a day with no meetings", () => {
  assert.deepEqual(meetingSection(held([event({ title: "R&D sync" })]), "2026-12-01"), ["• 09:00 R&amp;D sync"]);
  // Yesterday's meetings, an empty snapshot and another day's: nothing to say, and
  // no line that always says nothing.
  assert.deepEqual(meetingSection(held([event()]), "2026-12-02"), []);
  assert.deepEqual(meetingSection(held([]), "2026-12-01"), []);
  assert.deepEqual(meetingSection(held([event({ start: at("2026-11-30T09:00"), end: at("2026-11-30T09:30") })]), "2026-12-01"), []);
});
