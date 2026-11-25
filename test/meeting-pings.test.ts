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

test("an hour-long meeting is asked about, and a fifteen-minute one beside it is not", () => {
  // Both ended inside the window; only the length tells them apart.
  const long = event({ id: "0000000000000001", start: at("2026-12-01T09:00"), end: at("2026-12-01T09:45") });
  const short = event({ id: "0000000000000002", start: at("2026-12-01T09:39"), end: at("2026-12-01T09:54") });
  const plan = planned({ state: held([long, short]) });
  assert.deepEqual(keys(plan), ["meeting:0000000000000001"], "the meeting, not the check-in");
  assert.ok(!keys(plan).includes("meeting:0000000000000002"), "a fifteen-minute check-in asks nothing");
});

test("a meeting of exactly twenty minutes is a question, and one of nineteen is not", () => {
  const twenty = event({ start: at("2026-12-01T09:30"), end: at("2026-12-01T09:50") });
  assert.deepEqual(keys(planned({ state: held([twenty]) })), ["meeting:9f2c41d07ab3e6c1"], "twenty is the floor itself");
  const nineteen = event({ start: at("2026-12-01T09:31"), end: at("2026-12-01T09:50") });
  assert.deepEqual(planned({ state: held([nineteen]) }).pings, [], "a minute under it is not");
});

test("a short meeting does not take a slot of the day's cap", () => {
  // The fifteen-minute one ends first, so a cap that counted it would spend a slot on it.
  const short = event({ id: "0000000000000001", start: at("2026-12-01T09:20"), end: at("2026-12-01T09:35") });
  const first = event({ id: "0000000000000002", start: at("2026-12-01T09:20"), end: at("2026-12-01T09:45") });
  const second = event({ id: "0000000000000003", start: at("2026-12-01T09:30"), end: at("2026-12-01T09:50") });
  assert.deepEqual(
    keys(planned({ state: held([short, first, second]), policy: { perDay: 2 } })),
    ["meeting:0000000000000002", "meeting:0000000000000003"],
    "the two meetings, in the order they ended",
  );
});

test("a long meeting that ended inside the catch-up window is still a question", () => {
  // The floor is about the length of the meeting, not about how late the ask is.
  const late = event({ start: at("2026-12-01T08:15"), end: at("2026-12-01T09:15") });
  assert.deepEqual(keys(planned({ state: held([late]) })), ["meeting:9f2c41d07ab3e6c1"], "an hour long, and still today's");
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

/** The id a test's nth meeting carries: padded as the Mac derives them, so a day's ids never collide. */
const id = (n: number): string => `${n}`.padStart(16, "0");

/** The key of the meeting that `dayOf` numbers `n`. */
const ask = (n: number): string => `meeting:${id(n)}`;

/**
 * A day of `n` meetings that all ended inside the window, the earliest end first:
 * the first one is id 1. Thirty-minute meetings, so the length floor leaves them
 * all alone.
 */
function dayOf(n: number): CalendarEvent[] {
  return Array.from({ length: n }, (_, i) => ended(6 + (n - 1 - i), { id: id(i + 1) }));
}

/**
 * The meeting that `id(n)` names, `minutes` long and ended `ago` minutes before the
 * clock. Length is what the ranking reads, so a test that cares which of the day's
 * meetings is asked about says it here.
 */
function sized(n: number, ago: number, minutes: number, over: Partial<CalendarEvent> = {}): CalendarEvent {
  const end = NOW.getTime() - ago * MINUTE;
  return event({ id: id(n), start: new Date(end - minutes * MINUTE).toISOString(), end: new Date(end).toISOString(), ...over });
}

/**
 * A day of the lengths given, in the order it ran: the first entry ends earliest and
 * is id 1, and the ends are four minutes apart so no two are the same. All of them
 * ended inside the window, and all are long enough to be a question.
 */
function byLength(lengths: number[], over: (i: number) => Partial<CalendarEvent> = () => ({})): CalendarEvent[] {
  return lengths.map((minutes, i) => sized(i + 1, 6 + (lengths.length - 1 - i) * 4, minutes, over(i)));
}

test("the cap counts the asks already made today and stops at it", () => {
  const sent = ["meeting:0000000000000011", "meeting:0000000000000012", "meeting:0000000000000013", "meeting:0000000000000014", "meeting:0000000000000015"];
  // The item pings of the day are in the same set and are not asks about meetings.
  const withItems = [...sent, "2026-12-01:M:notes#52", "2026-12-01:E:notes#53"];
  const three = [ended(10, { id: "0000000000000002" }), ended(20, { id: "0000000000000001" }), ended(30, { id: "0000000000000003" })];
  // The flat cap of six, so what is left is the count of asks and nothing else.
  const plan = planned({ state: held(three), sent: withItems, policy: { perDayFloor: 6 } });
  assert.deepEqual(keys(plan), ["meeting:0000000000000003"], "one left of the day's six, and it is the earliest end");

  assert.deepEqual(planned({ state: held(three), sent: [...withItems, "meeting:0000000000000016"], policy: { perDayFloor: 6 } }).pings, [], "the day is full");
  // perDay is the caller's, and a smaller day says so.
  assert.deepEqual(keys(planned({ state: held(three), sent, policy: { perDay: 5, perDayFloor: 6 } })), []);
});

test("the day's cap counts meeting asks only, not the pings beside them", () => {
  // Six keys of the day that are no asks about a meeting: they fill none of the cap.
  const others = Array.from({ length: 6 }, (_, i) => `2026-12-01:E:notes#${i}`);
  const one = ended(10, { id: "0000000000000002" });
  assert.deepEqual(keys(planned({ state: held([one]), sent: others })), ["meeting:0000000000000002"]);
});

test("a day of eight meetings asks four times: half the day, floored at four", () => {
  // The floor is the cap for a day this light: ceil(8 / 2) is four, which is the floor.
  assert.deepEqual(keys(planned({ state: held(dayOf(8)) })), [ask(1), ask(2), ask(3), ask(4)], "four, the earliest four to end");
  // Four meetings with a cap above them are four asks: the floor is room, not asks.
  assert.deepEqual(keys(planned({ state: held(dayOf(4)) })), [ask(1), ask(2), ask(3), ask(4)], "four meetings, four asks");
});

test("a light day asks both its meetings: the floor never invents an ask", () => {
  assert.deepEqual(keys(planned({ state: held(dayOf(2)) })), [ask(1), ask(2)], "two meetings under a cap of four, and two asks");
});

test("a nine-meeting day asks five times, and they are the earliest five here", () => {
  // ceil(9 / 2) is five, above the floor and under the ceiling. The five earliest to
  // end are made the five longest of the day as well, so the ranked five and the
  // earliest five are the same five: what this framing proves is the count. The day
  // where rank and end disagree has its own tests below.
  const day = byLength([90, 80, 70, 60, 50, 45, 40, 35, 30]);
  assert.deepEqual(
    keys(planned({ state: held(day) })),
    [ask(1), ask(2), ask(3), ask(4), ask(5)],
    "five of the nine, and the longest of them ends first",
  );
});

test("an eleven-meeting day asks six times: perDay is still the ceiling", () => {
  // ceil(11 / 2) is six, and a fuller day is not allowed a seventh.
  assert.deepEqual(
    keys(planned({ state: held(dayOf(11)) })),
    [ask(1), ask(2), ask(3), ask(4), ask(5), ask(6)],
    "six, the ceiling itself",
  );
});

test("the cap counts the meetings that can be asked about, and the unanswered invites are neither counted nor asked", () => {
  // Four accepted meetings and three invitations ZY never answered, all ending inside the window.
  const fourAndThree = dayOf(7).map((e, i) => (i < 4 ? e : { ...e, status: "none" as const }));
  assert.deepEqual(keys(planned({ state: held(fourAndThree) })), [ask(1), ask(2), ask(3), ask(4)], "the four meetings, and no ask of an invite");

  // Five accepted meetings and five unanswered invites: ten meetings would be a
  // five-ask day, and the unanswered five are not meetings to ask about, so the
  // day is the five-meeting one and asks four times.
  const fiveAndFive = dayOf(10).map((e, i) => (i < 5 ? e : { ...e, status: "none" as const }));
  assert.deepEqual(
    keys(planned({ state: held(fiveAndFive) })),
    [ask(1), ask(2), ask(3), ask(4)],
    "a five-meeting day's four asks, not a ten-meeting day's five",
  );
});

test("a meeting whose ask was missed while the bot was down still counts as one of the day's meetings", () => {
  // It ended two hours ago, outside the catch-up window, so it is never asked about
  // now: it is still one of the day's nine meetings, and a nine-meeting day asks five
  // times where a day of the eight that are due asks four. It is the shortest meeting
  // of the day, so the fifth slot is one the meetings still to be asked can use.
  const missed = sized(99, 120, 20);
  assert.deepEqual(
    keys(planned({ state: held([...dayOf(8), missed]) })),
    [ask(1), ask(2), ask(3), ask(4), ask(5)],
    "five, counted over the whole day",
  );
});

test("a perDay of one asks once, whatever the day holds", () => {
  // The floor is below the ceiling the caller set, so one is the cap.
  assert.deepEqual(keys(planned({ state: held(dayOf(6)), policy: { perDay: 1 } })), [ask(1)], "the earliest end and nothing after it");
  assert.deepEqual(planned({ state: held(dayOf(6)), policy: { perDay: 1 }, sent: [ask(1)] }).pings, [], "and the day is spent");
});

test("perDayFloor at the ceiling and no length floor is the flat six of today", () => {
  // A fifteen-minute check-in that ended earliest of all: under minMinutes 20 it is
  // not a question, and with the floor off it is one, asked first.
  const checkIn = event({ id: id(9), start: at("2026-12-01T09:15"), end: at("2026-12-01T09:30") });
  const day = [checkIn, ...dayOf(5)];
  assert.deepEqual(
    keys(planned({ state: held(day), policy: { perDayFloor: 6, minMinutes: 0 } })),
    [ask(9), ask(1), ask(2), ask(3), ask(4), ask(5)],
    "the check-in first, then the five meetings: six asks, the flat ceiling",
  );
  // And with the length floor back on, the five meetings are the day, and all five are asked.
  assert.deepEqual(
    keys(planned({ state: held(day), policy: { perDayFloor: 6 } })),
    [ask(1), ask(2), ask(3), ask(4), ask(5)],
    "the check-in is no question, and the five meetings fill the flat six",
  );
  // Six meetings under the same floor: the flat six of today, all six asked.
  assert.deepEqual(
    keys(planned({ state: held(dayOf(6)), policy: { perDayFloor: 6 } })),
    [ask(1), ask(2), ask(3), ask(4), ask(5), ask(6)],
    "today's flat six",
  );
});

// ---- Which of the day's meetings the cap is spent on -----------------------

test("the five longest meetings of a nine-meeting day are asked about, and the four shortest are not", () => {
  // Nine lengths, none of them twice, and the ends in a different order from the
  // lengths: a cap spent earliest-end-first would ask about the four shortest here.
  const day = byLength([30, 120, 45, 25, 90, 20, 60, 35, 180]);
  const plan = planned({ state: held(day) });
  assert.deepEqual(keys(plan), [ask(2), ask(3), ask(5), ask(7), ask(9)], "the five longest, in the order they ended");
  const asked = new Set(keys(plan));
  const never = day.map((e) => `meeting:${e.id}`).filter((key) => !asked.has(key));
  assert.deepEqual(never, [ask(1), ask(4), ask(6), ask(8)], "thirty, twenty-five, twenty and thirty-five minutes: the four shortest");
});

test("the asks go out in the order the meetings ended, though the day is ranked by length", () => {
  // The longest meeting of the day is the last one to end. Five meetings, a cap of
  // four, so the shortest — the first to end — is the one left out.
  const day = byLength([25, 30, 40, 45, 120]);
  const plan = planned({ state: held(day) });
  assert.deepEqual(keys(plan), [ask(2), ask(3), ask(4), ask(5)], "the four longest, and the earliest end first");
  const ends = plan.pings.map((ping) => Date.parse(ping.end));
  assert.deepEqual(ends, [...ends].sort((a, b) => a - b), "the day's order, not the ranking's");
});

test("two meetings of one length: the one with more in it takes the last of the cap", () => {
  // Four longer meetings, then two of fifty minutes with one slot of the cap left for
  // them. The one with nine in it ends later, so length and end alone would take the
  // other one: attendees decide.
  const day = byLength([25, 35, 40, 50, 60, 50, 70, 80, 90], (i) => (i === 3 ? { attendees: 3 } : i === 5 ? { attendees: 9 } : {}));
  const plan = planned({ state: held(day) });
  assert.deepEqual(keys(plan), [ask(5), ask(6), ask(7), ask(8), ask(9)], "the nine-attendee fifty, not the three-attendee one");
  assert.ok(!keys(plan).includes(ask(4)), "the same fifty minutes with three in it, and ending first, is the sixth of the nine");
});

test("two meetings that tie all the way down rank by id, not by the snapshot's order", () => {
  // Five meetings under a cap of four, and the two of fifty minutes tie on length,
  // attendees and end alike, so only the id can separate them. Handing the same day
  // over in the opposite order must choose the same four: without the id the
  // snapshot's order decides, and that is the Mac's push order, which can swap two
  // double-booked meetings between one push and the next.
  const tieEnd = new Date(NOW.getTime() - 20 * MINUTE).toISOString();
  const tieStart = new Date(NOW.getTime() - 70 * MINUTE).toISOString();
  const tied = (n: number): CalendarEvent => event({ id: id(n), start: tieStart, end: tieEnd, attendees: 6 });
  const day = [...byLength([90, 80, 70]), tied(4), tied(5)];
  const forward = planned({ state: held(day) });
  const backward = planned({ state: held([...day].reverse()) });
  assert.deepEqual(forward.pings, backward.pings, "the same asks, whichever order the day arrives in");
  assert.deepEqual(keys(forward), [ask(4), ask(1), ask(2), ask(3)], "the fifty with the smaller id, and the three longest");
  assert.ok(!keys(forward).includes(ask(5)), "the fifty with the larger id is the fifth of the five");
});

test("two meetings of one length and one headcount: the earlier end takes the last of the cap", () => {
  // Four longer meetings, then two of fifty minutes with six in each. Attendees cannot
  // separate them, so the end does, and the later one is left out. The day is handed
  // over in the reverse of the order it ran, so a sort that kept the snapshot's order
  // would take the other one: the ranking itself has to read the end.
  const day = byLength([25, 30, 35, 60, 70, 50, 80, 90, 50]).reverse();
  const plan = planned({ state: held(day) });
  assert.deepEqual(keys(plan), [ask(4), ask(5), ask(6), ask(7), ask(8)], "the fifty that ended first, and the four longer ones");
  assert.ok(!keys(plan).includes(ask(9)), "the same fifty minutes with the same six in it, ending later, is the sixth");
});

test("a long meeting that has not ended takes no ask now and no room from the ones that have", () => {
  // The longest meeting of the day runs until eleven. It is one of the cap's five, and
  // it is not due: the four next-longest that are due are asked, and nothing is held
  // back for it.
  const later = event({ id: id(9), start: at("2026-12-01T08:00"), end: at("2026-12-01T11:00") });
  const day = byLength([25, 30, 35, 40, 90, 60, 55, 45]);
  assert.deepEqual(
    keys(planned({ state: held([...day, later]) })),
    [ask(5), ask(6), ask(7), ask(8)],
    "the four next-longest, all of them due",
  );
});

test("a meeting already asked about is not asked again, and the room shrinks by it", () => {
  // The same nine-meeting day: the longest one of all is already asked about, so four
  // of the chosen five are left, and the sixth of the ranking is not promoted.
  const day = byLength([30, 120, 45, 25, 90, 20, 60, 35, 180]);
  const plan = planned({ state: held(day), sent: [ask(9)] });
  assert.deepEqual(keys(plan), [ask(2), ask(3), ask(5), ask(7)], "the other four of the chosen five");
  assert.ok(!keys(plan).includes(ask(8)), "the six of the nine is not promoted into the room");
});

test("a chosen meeting whose ask window has passed keeps its slot, and the next-ranked is not promoted", () => {
  // The longest meeting of the day ended two hours ago, before the bot came back, so
  // it holds one of the cap's four and is never asked about now. The fifth of the
  // ranking does not take the room its silence leaves: five of the day's six
  // meetings would be asked about if it did.
  const missed = sized(99, 120, 180);
  const plan = planned({ state: held([...byLength([25, 30, 35, 40, 45]), missed]) });
  assert.deepEqual(keys(plan), [ask(3), ask(4), ask(5)], "the three chosen meetings that are due");
  assert.ok(!keys(plan).includes(ask(2)), "the fifth of the six is not promoted into the room");
});

test("an ask about a meeting the ranking would not choose still uses up the day's room", () => {
  // The shortest meeting of the day was asked about earlier: the cap would never have
  // spent a slot on it, but the ask was real, so it takes one of the day's four all the
  // same, and the fourth of the chosen is left unasked.
  const plan = planned({ state: held(byLength([90, 80, 70, 60, 50, 40])), sent: [ask(6)] });
  assert.deepEqual(keys(plan), [ask(1), ask(2), ask(3)], "three of the chosen four, one of them already spent");
  assert.ok(!keys(plan).includes(ask(4)), "the fourth of the chosen is not asked in the sixth's place");
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
