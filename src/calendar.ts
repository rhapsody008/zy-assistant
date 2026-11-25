// The calendar snapshot a Mac exports and the pod mounts, and the intake that
// holds the one it last accepted. The parser is all-or-nothing: a snapshot with
// one bad event is no snapshot, so the intake never half-believes a file.
//
// Nothing here prints: every function returns what it found and the caller owns
// the log. What leaves this module is ids, counts, timestamps, zone identifiers and
// field paths; a title is never rendered on a line built here, and a domain names a
// customer, so both stay inside the held snapshot and off every line built here.
//
// A version 2 file also declares the zone the Mac built its window in, and where the
// bot's own zone is elsewhere the two disagree about where a day starts and ends. The
// snapshot is still held: a declared zone that is not this bot's is a disagreement to
// state, never a fault to reject.
//
// Freshness is read off generatedAt, never off when the file was read: a pod
// that restarts does not make an hour-old snapshot look new. And a snapshot is
// held, not cached: a newer one replaces it whole even when its events are the
// same, because that push is the Mac saying it is still alive.

import { errMessage } from "./errors.ts";
import { localNow, TZ } from "./time.ts";

/** One snapshot file may not be bigger than this: anything larger is not a day and a half of meetings. */
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

/** A window holding more events than this was not filtered by the Mac, so it is refused rather than cut. */
const EVENTS_MAX = 200;

/** A title longer than this is cut, never refused: see event(). */
const TITLE_MAX = 200;

/** More domains than this on one event is a mailing list, not a meeting. */
const DOMAINS_MAX = 20;

/** One domain may hold 100 characters; the Mac drops anything longer rather than pushing it. */
const DOMAIN_MAX = 100;

/**
 * A domain as the Mac sends one: lowercase, dot-separated labels, no trailing dot.
 * It is checked here as well as dropped there, because the parser is the thing a
 * bad domain would cost a whole snapshot.
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A generatedAt further ahead than this is a clock that is wrong, not a push from the future. */
const FUTURE_MS = 5 * 60_000;

/** A 16-hex-character id: what a log line and a later ping name a meeting by. */
const ID_RE = /^[0-9a-f]{16}$/;

/** The longest a zone identifier may be: an IANA name is far shorter, and a zone identifier reaches a log line. */
const ZONE_MAX = 64;

/** A zone identifier is letters, digits and these four separators, and nothing else. */
const ZONE_CHARS_RE = /^[A-Za-z0-9_+/-]+$/;

/** The four answers an invitation can have. */
export const CALENDAR_STATUSES = ["accepted", "tentative", "organizer", "none"] as const;

export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** The span the Mac exported: freshness is judged against its end. */
export interface CalendarWindow {
  start: string; // ISO-8601 with a Z
  end: string;
}

/** One meeting as the Mac derived it: no body, no location, and a title nothing here shows. */
export interface CalendarEvent {
  id: string; // opaque, 16 hex characters: what a log line and a later ping name it by
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  domains: string[]; // lowercase and deduped by the Mac
  attendees: number;
  status: CalendarStatus;
}

/**
 * A parsed snapshot. There is no `v` here: the version is what the parse read, and
 * what a caller holds is the snapshot itself. A version 1 file says nothing about
 * the zone it was built in, so `tz` is absent rather than defaulted: absent is the
 * file saying nothing, while a default here would be this module guessing.
 */
export interface CalendarSnapshot {
  generatedAt: string;
  window: CalendarWindow;
  events: CalendarEvent[];
  /** The IANA zone the Mac built the window in, from a version 2 file only. */
  tz?: string;
}

export type CalendarFreshness = "fresh" | "stale" | "expired";

/** The held snapshot and how much it is worth right now. */
export interface CalendarState {
  snapshot: CalendarSnapshot;
  /** When this snapshot was accepted; freshness is generatedAt's business, not this. */
  readAt: Date;
  freshness: CalendarFreshness;
}

/** What one refresh did. The caller logs it: a duplicate push and a repeated rejection are silent. */
export type CalendarRefresh =
  | { kind: "unchanged" }
  | { kind: "accepted"; snapshot: CalendarSnapshot; events: number; allDay: number }
  | { kind: "rejected"; reason: string; repeat: boolean }
  | { kind: "missing" };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message names the field path and never the value: it is a log line, not an echo. */
function fail(path: string, what: string): never {
  throw new Error(`${path}: ${what}`);
}

/** An ISO-8601 Z timestamp as the text it is and the instant it names. */
function timestamp(value: unknown, path: string): { text: string; ms: number } {
  if (typeof value !== "string" || !ISO_RE.test(value)) fail(path, "not a timestamp");
  const ms = Date.parse(value);
  // A day the month does not have rolls over instead of failing: 2026-02-30 parses
  // as 2 March and is accepted as the timestamp it names. An hour of 25, a month of
  // 13 or a day of 32 parses to NaN, and is no timestamp at all.
  if (!Number.isFinite(ms)) fail(path, "not a timestamp");
  return { text: value, ms };
}

/**
 * The zone a version 2 file declares: an IANA identifier, and nothing that could
 * forge a line. The shape is checked before Intl sees the name, because Intl's own
 * refusal quotes what it was given, and a zone name is calendar-shaped input. An
 * empty name is refused on its own, before the shape check: it is a Mac that meant
 * to declare a zone and lost it, not one writing a string with a bad character in it.
 * Nothing is trimmed, so a name with a space around it is a bad name rather than a
 * quietly repaired one.
 */
function zone(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "not a string");
  if (value === "") fail(path, "empty");
  if (value.length > ZONE_MAX || !ZONE_CHARS_RE.test(value)) fail(path, "not a zone name");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    fail(path, "unknown time zone");
  }
  return value;
}

function domainList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "not an array of strings");
  if (value.length > DOMAINS_MAX) fail(path, `${value.length} domains, over the ${DOMAINS_MAX} cap`);
  return value.map((entry, i) => {
    if (typeof entry !== "string") fail(`${path}[${i}]`, "not a string");
    if (entry.length > DOMAIN_MAX) fail(`${path}[${i}]`, `over ${DOMAIN_MAX} characters`);
    if (!DOMAIN_RE.test(entry)) fail(`${path}[${i}]`, "not a lowercase domain name");
    return entry;
  });
}

function event(raw: unknown, path: string): CalendarEvent {
  if (!isRecord(raw)) fail(path, "not an object");
  // An id reaches output and later log lines, so its shape is enforced here: any
  // other string could carry a newline and forge a line of its own.
  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) fail(`${path}.id`, "not 16 hex characters");
  const start = timestamp(raw.start, `${path}.start`);
  const end = timestamp(raw.end, `${path}.end`);
  if (end.ms <= start.ms) fail(`${path}.end`, "not after its start");
  const allDay = raw.allDay;
  if (typeof allDay !== "boolean") fail(`${path}.allDay`, "not a boolean");
  const title = raw.title;
  if (typeof title !== "string") fail(`${path}.title`, "not a string");
  const domains = domainList(raw.domains, `${path}.domains`);
  const attendees = raw.attendees;
  if (typeof attendees !== "number" || !Number.isInteger(attendees) || attendees < 0) {
    fail(`${path}.attendees`, "not a non-negative integer");
  }
  const status = raw.status;
  if (typeof status !== "string" || !(CALENDAR_STATUSES as readonly string[]).includes(status)) {
    fail(`${path}.status`, `not one of ${CALENDAR_STATUSES.join(", ")}`);
  }
  return {
    id,
    start: start.text,
    end: end.text,
    allDay,
    // The one field a calendar writes long by accident, pasting an agenda into a
    // subject. It is cut rather than refused because nothing here ever shows or
    // logs a title: the cut costs no caller anything, while a refusal would cost
    // the whole window, heartbeat included.
    title: title.slice(0, TITLE_MAX),
    domains,
    attendees,
    status: status as CalendarStatus,
  };
}

/**
 * One snapshot, or a throw that names the first field that is wrong. Over-long
 * titles are cut; every other cap is a refusal, because a snapshot that lost
 * events or domains would make its own counts a lie.
 */
export function parseSnapshot(text: string, now: Date): CalendarSnapshot {
  // Before the parse: a large file is a Mac bug, and nothing is learned by parsing it.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > SNAPSHOT_MAX_BYTES) fail("snapshot", `${bytes} bytes, over the ${SNAPSHOT_MAX_BYTES} cap`);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse's own message quotes the text it choked on, so it is replaced.
    fail("snapshot", "not JSON");
  }
  if (!isRecord(value)) fail("snapshot", "not a JSON object");
  // The version decides how the rest of the file is read, so it is asked first, and
  // a version this parser does not know is refused rather than read as the nearest
  // one it does: a version 3 file may mean anything, and half-believing it is worse
  // than holding the previous snapshot.
  if (value.v !== 1 && value.v !== 2) fail("v", "not 1 or 2");
  // A version 2 file is a version 1 file plus the zone the Mac built the window in.
  // A `tz` key in a version 1 file is ignored, the way every unknown key is: the
  // version says what the file means, and nothing else does.
  const declared = value.v === 2 ? zone(value.tz, "tz") : undefined;

  const generatedAt = timestamp(value.generatedAt, "generatedAt");
  if (generatedAt.ms - now.getTime() > FUTURE_MS) fail("generatedAt", `more than ${FUTURE_MS / 60_000} minutes in the future`);

  if (!isRecord(value.window)) fail("window", "not an object");
  const start = timestamp(value.window.start, "window.start");
  const end = timestamp(value.window.end, "window.end");
  if (end.ms <= start.ms) fail("window.end", "not after window.start");

  if (!Array.isArray(value.events)) fail("events", "not an array");
  if (value.events.length > EVENTS_MAX) fail("events", `${value.events.length} events, over the ${EVENTS_MAX} cap`);

  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.events.length; i += 1) {
    const parsed = event(value.events[i], `events[${i}]`);
    // An id is what a later ping names the meeting by: two of them would make one.
    if (seen.has(parsed.id)) fail(`events[${i}].id`, "duplicate");
    seen.add(parsed.id);
    events.push(parsed);
  }

  // The spread is what keeps a version 1 parse free of a `tz` key: `tz: undefined`
  // would still be a key, and a caller comparing whole snapshots would see it.
  return {
    generatedAt: generatedAt.text,
    window: { start: start.text, end: end.text },
    events,
    ...(declared === undefined ? {} : { tz: declared }),
  };
}

/**
 * The zone a snapshot declared, when it is not this bot's; null when there is no
 * disagreement to state. A version 1 file declared nothing, so it never disagrees.
 * The compare is exact and case-sensitive on purpose: an alias, or a sibling zone
 * that happens to share an offset, still counts as a mismatch, because what the two
 * sides disagree about is where the day boundaries fall, not what the clock reads at
 * one instant. Nothing is concluded here: a foreign snapshot is not stale, and not
 * expired. It was pushed, it parsed, and its days are simply not this bot's.
 */
export function foreignZone(snapshot: CalendarSnapshot): string | null {
  const declared = snapshot.tz;
  return declared !== undefined && declared !== TZ ? declared : null;
}

export interface CalendarIntakeOptions {
  /** CALENDAR_FILE: the snapshot the pod mounts. */
  path: string;
  /** Injected so a test never touches a disk, and so a read can be made to fail. */
  readFile: (path: string) => Promise<string>;
}

/**
 * The one snapshot the bot holds. `refresh` reads the file and decides whether
 * what it found is news; `current` says what the held snapshot is worth now.
 * Neither prints, and `refresh` never throws: the tick that calls it must not die
 * over a file.
 */
export class CalendarIntake {
  #path: string;
  #readFile: (path: string) => Promise<string>;
  #held: { snapshot: CalendarSnapshot; readAt: Date } | null = null;
  #lastReason: string | null = null;

  constructor(options: CalendarIntakeOptions) {
    this.#path = options.path;
    this.#readFile = options.readFile;
  }

  async refresh(now: Date): Promise<CalendarRefresh> {
    let text: string;
    try {
      text = await this.#readFile(this.#path);
    } catch (err) {
      // A Mac that has not pushed yet is not a fault: no file at all is no snapshot.
      // The code is read, never cast: an injected read may reject with anything,
      // and reading a field off undefined would throw inside this catch.
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        this.#lastReason = null;
        return { kind: "missing" };
      }
      // The fs message names the mount path, never anything the payload holds.
      return this.#rejected(`snapshot file: ${errMessage(err)}`);
    }

    let snapshot: CalendarSnapshot;
    try {
      snapshot = parseSnapshot(text, now);
    } catch (err) {
      return this.#rejected(errMessage(err));
    }

    const held = this.#held;
    if (held !== null) {
      // Instants, not strings: the Mac may stop writing milliseconds, and that
      // is the same push, not a new one.
      const age = Date.parse(snapshot.generatedAt) - Date.parse(held.snapshot.generatedAt);
      if (age < 0) return this.#rejected("older than the snapshot held");
      if (age === 0) {
        // The same push twice: a no-op. The held readAt stays where it was, so
        // the state reads as the one snapshot it is.
        this.#lastReason = null;
        return { kind: "unchanged" };
      }
    }

    // A newer snapshot replaces the whole held one even when its events match:
    // that is the heartbeat, and the only thing that keeps a quiet day fresh.
    this.#held = { snapshot, readAt: now };
    this.#lastReason = null;
    return {
      kind: "accepted",
      snapshot,
      events: snapshot.events.length,
      allDay: snapshot.events.filter((e) => e.allDay).length,
    };
  }

  current(now: Date): CalendarState | null {
    const held = this.#held;
    if (held === null) return null;
    const { snapshot } = held;
    // A closed window carries nothing for now, however recently the Mac wrote it,
    // so expiry is asked first: an old window can never read as fresh.
    // Then the local date of the push. The Mac pushes at 07:30 and 18:30, so an age
    // in minutes would call the snapshot stale for most of the day it is about;
    // "pushed today" is what fresh can honestly mean here, and an older push still
    // inside the window is stale but usable. The compare is `>=` because a Mac whose
    // clock is a few minutes ahead (allowed up to five) pushes tomorrow's date
    // around midnight, and that is still this moment's snapshot.
    const freshness: CalendarFreshness =
      now.getTime() > Date.parse(snapshot.window.end)
        ? "expired"
        : localNow(new Date(snapshot.generatedAt), TZ).date >= localNow(now, TZ).date
          ? "fresh"
          : "stale";
    // Expired and stale snapshots are still returned: what to do about their age
    // is the caller's decision, and a sleeping Mac must not empty the state.
    return { snapshot, readAt: held.readAt, freshness };
  }

  /** A rejection, and whether it is the one the caller has already logged. */
  #rejected(reason: string): CalendarRefresh {
    const repeat = reason === this.#lastReason;
    this.#lastReason = reason;
    return { kind: "rejected", reason, repeat };
  }
}

/** Whole minutes since generatedAt; a clock slightly ahead reads as no age at all. */
function ageMinutes(generatedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(generatedAt)) / 60_000));
}

/**
 * What a line says about the zone the snapshot declared: nothing at all for a
 * version 1 file, the zone when it is this bot's, and the disagreement when it is
 * not. The refresh line and the startup line both end with it, so the one I read
 * after a deploy says the same thing as the push that made it. Zone identifiers,
 * counts and instants only, on the same rule as the rest of this module: a title
 * never reaches a line, and a mismatched snapshot's meetings and asks are not this
 * bot's to state, so the line says they are off rather than naming one.
 */
export function zoneSuffix(snapshot: CalendarSnapshot): string {
  if (snapshot.tz === undefined) return "";
  const foreign = foreignZone(snapshot);
  if (foreign === null) return `, tz ${TZ}`;
  return `, tz ${foreign}, not ${TZ}: its meetings and asks are off`;
}

/**
 * What a refresh is worth logging: an accepted snapshot and a first-time
 * rejection say something; the same push again, the same rejection again and a
 * file that is not there yet say nothing.
 */
export function calendarRefreshLine(refresh: CalendarRefresh): string | null {
  if (refresh.kind === "accepted") {
    return (
      `calendar: snapshot ${refresh.snapshot.generatedAt}: ${count(refresh.events, "event")}, ${refresh.allDay} all-day` +
      zoneSuffix(refresh.snapshot)
    );
  }
  if (refresh.kind === "rejected" && !refresh.repeat) return `calendar: snapshot rejected: ${refresh.reason}`;
  return null;
}

/** The freshness, logged once per transition: a stale snapshot is named, not treated as a fault. */
export function calendarFreshnessLine(state: CalendarState, now: Date): string {
  return `calendar: ${state.freshness}, snapshot ${state.snapshot.generatedAt} (age ${ageMinutes(state.snapshot.generatedAt, now)}m)`;
}

/**
 * The `calendar` mode's output: one summary line, then one line per event, ids
 * and counts only. A title is never shown and a domain is only ever counted.
 */
export function snapshotLines(state: CalendarState, now: Date): string[] {
  const { snapshot, freshness } = state;
  const allDay = snapshot.events.filter((e) => e.allDay).length;
  const lines = [
    `snapshot ${snapshot.generatedAt}, window ${snapshot.window.start}..${snapshot.window.end}, ` +
      `${count(snapshot.events.length, "event")}, ${allDay} all-day, ${freshness}, age ${ageMinutes(snapshot.generatedAt, now)}m` +
      zoneSuffix(snapshot),
  ];
  for (const e of snapshot.events) {
    lines.push(`${e.id} ${e.start} ${e.end} ${String(e.allDay)} ${e.status} domains=${e.domains.length}`);
  }
  return lines;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
