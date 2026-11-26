// The Mac's calendar, exported on demand. `zya calendar` opens the bundle in
// mac/calendar/ through LaunchServices and reads back the snapshot it printed, so
// the reader is the process that has the Calendar grant: `open` is what gives the
// app a GUI session to own the TCC request, and waiting for it is what makes the
// output a file that is complete when it is read.
//
// Two files in a private temp directory, both created at mode 600 and both removed
// whichever way the export ends: a snapshot left behind is a meeting title on disk,
// and titles are the one thing this repo does not leave lying around.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseSnapshot, type CalendarEvent, type CalendarSnapshot } from "./calendar.ts";
import { fmtDate, localNow } from "./time.ts";

/** The bundle this repo builds: what `zya calendar` opens unless ZY_CALENDAR_APP names another. */
export const DEFAULT_APP = join(homedir(), "zyworkspace", "gitrepo", "zy-assistant", "mac", "calendar", "zy-calendar-export.app");

/** The variable that points the CLI at a bundle built somewhere else. */
export const APP_ENV = "ZY_CALENDAR_APP";

/** The bundle to open: ZY_CALENDAR_APP when it says something, DEFAULT_APP otherwise. */
export function appFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[APP_ENV] ?? "";
  return named === "" ? DEFAULT_APP : named;
}

/** The window to export: whole days from today, all of them before it. */
export interface CalendarRequest {
  from: number; // 0 today, -1 yesterday: how far back the window starts
  days: number;
  app: string; // the .app bundle LaunchServices opens
}

/**
 * What one export needs from the world. All of it is injected, so a test runs the
 * whole command without `open`, a disk or a Calendar.
 */
export interface ExportDeps {
  /** Runs a command to completion and answers its exit code: `open -W` waits for the app. */
  run: (cmd: string, args: string[]) => Promise<number>;
  /** A fresh directory only this user can read (mkdtemp, mode 700). */
  tmpDir: () => string;
  /** An empty file at `path`, created with the mode given: 0o600, before the app writes it. */
  createFile: (path: string, mode: number) => void;
  readFile: (path: string) => string;
  /** Removes a path and everything under it, and nothing when it is already gone. */
  rm: (path: string) => void;
  now: () => Date;
}

/** The first line of a file's text that says anything: a failure is one line. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/**
 * The snapshot of one window, parsed by calendar.ts and no further trusted here.
 * An export that printed nothing failed: the app's own reason is on its stderr, and
 * `open` says nothing else, so a failed launch is its exit code and no line.
 *
 * The directory is made once and removed once, in the `finally`, so a run that made
 * one file or both or neither leaves nothing behind: the files are created inside
 * the `try` for the same reason, and a failure to make the second one is still a
 * directory to remove.
 */
export async function exportCalendar(request: CalendarRequest, deps: ExportDeps): Promise<CalendarSnapshot> {
  const dir = deps.tmpDir();
  const out = join(dir, "out");
  const err = join(dir, "err");
  try {
    deps.createFile(out, 0o600);
    deps.createFile(err, 0o600);
    const args = [
      "-W", // wait for the app: a file read while it is still writing is half a snapshot
      "-n", // a new instance, even when one is already open
      "--stdout",
      out,
      "--stderr",
      err,
      "-a",
      request.app,
      "--args",
      "--days",
      String(request.days),
    ];
    // Only when it says something: a window from today is the app's own default.
    if (request.from !== 0) args.push("--from", String(request.from));
    const code = await deps.run("open", args);
    const text = deps.readFile(out);
    if (text === "") {
      const why = firstLine(deps.readFile(err));
      throw new Error(`calendar export failed: ${why === "" ? `open exited ${code}` : why}`);
    }
    return parseSnapshot(text, deps.now());
  } finally {
    // The whole directory goes, whatever happened above: one call, and no try/catch
    // around it, because a cleanup that silently failed would leave a meeting title
    // on disk with nobody told. `rm` is recursive and forced in MAC_DEPS, so a
    // directory that is already gone is not an error and a real one is.
    deps.rm(dir);
  }
}

/** The real world: LaunchServices, the file system and the wall clock. */
export const MAC_DEPS: ExportDeps = {
  run: (cmd, args) =>
    new Promise((resolve, reject) => {
      // Nothing inherited: the app's own words are on its stderr file, and `open`'s
      // failure is read from its exit code rather than mixed into this command's.
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    }),
  tmpDir: () => mkdtempSync(join(tmpdir(), "zy-calendar-")),
  createFile: (path, mode) => writeFileSync(path, "", { mode }),
  readFile: (path) => readFileSync(path, "utf8"),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  now: () => new Date(),
};

/** The three fields a snapshot event gains when it is rendered: where it is, in this zone. */
interface Local {
  localDate: string; // YYYY-MM-DD
  localStart: string; // HH:MM
  localEnd: string; // HH:MM
}

/** Minutes since midnight as HH:MM. */
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * One event's day and its two times in `tz`. The snapshot's own instants are in
 * UTC, and a meeting is read in the reader's zone: an event that starts at 16:00Z
 * is 00:00 the next day in Singapore, and belongs under that day.
 */
function local(event: CalendarEvent, tz: string): Local {
  const start = localNow(new Date(event.start), tz);
  const end = localNow(new Date(event.end), tz);
  return { localDate: start.date, localStart: hhmm(start.minutes), localEnd: hhmm(end.minutes) };
}

/**
 * One event as one markdown line. An all-day event carries no times, because
 * midnight to midnight says nothing but where its day ends; the rest say what the
 * snapshot knows: the answer ZY gave, how many are coming and whose companies they
 * are with. An event with no domains stops after the count rather than leaving a
 * comma hanging.
 */
function mdLine(event: CalendarEvent, at: Local): string {
  if (event.allDay) return `- all day ${event.title}`;
  const domains = event.domains.length === 0 ? "" : `, ${event.domains.join(", ")}`;
  return `- ${at.localStart}-${at.localEnd} ${event.title} (${event.status}, ${event.attendees} attendees${domains})`;
}

/**
 * A snapshot as the CLI prints it: markdown grouped under one `## Tue 1 Dec` per
 * local day that has a meeting, or JSON, which is the same events with `localDate`,
 * `localStart` and `localEnd` added. A window with no events renders as nothing at
 * all: there is no day to head.
 */
export function renderCalendar(snapshot: CalendarSnapshot, tz: string, format: "md" | "json"): string {
  // The Mac sorts by start, and the render does not rely on it: a day's lines are
  // its meetings in the order they happen, whatever order the file held them in.
  const events = snapshot.events.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (format === "json") {
    return `${JSON.stringify(events.map((event) => ({ ...event, ...local(event, tz) })), null, 2)}\n`;
  }

  const lines: string[] = [];
  let day = "";
  for (const event of events) {
    const at = local(event, tz);
    if (at.localDate !== day) {
      day = at.localDate;
      lines.push(`## ${fmtDate(day)}`);
    }
    lines.push(mdLine(event, at));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
