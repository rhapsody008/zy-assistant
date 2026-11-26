// `zya yesterday`: what happened since the previous workday, in one report — the
// board items that moved, the comments on their issues, the notes-repo commits
// and the meetings.
//
// The window is [previous workday 00:00, date 00:00) in the assistant's zone, so
// a Monday covers the weekend nobody watched, and a day is a whole day even where
// a zone moves its clocks. Read-only. A notes or comments read that fails stops
// the report, because half of one would lie; a Mac that refused the calendar is a
// line in it, because the rest of the window happened all the same.

import { fetchIssueComments, fetchNotesCommits, type IssueComment, type NotesCommit } from "./activity.ts";
import { renderCalendar, type CalendarRequest } from "./calendar-export.ts";
import type { CalendarSnapshot } from "./calendar.ts";
import type { Env } from "./env.ts";
import { errMessage } from "./errors.ts";
import type { BoardSource, FetchLike } from "./github.ts";
import { dayDiff, fmtDate, localNow, prevWorkday } from "./time.ts";

/**
 * How far back the Mac's export reaches: the floor `zya calendar --from` offers
 * too (cli.ts's FROM_MIN is this number), and a window starting past it cannot
 * be read at all.
 */
export const CALENDAR_DAYS_BACK = 14;

/** The Mac's snapshot of a window, exported on demand: the app is the caller's to name. */
export type CalendarSource = (request: Omit<CalendarRequest, "app">) => Promise<CalendarSnapshot>;

/** One board item that moved inside the window. */
export interface BoardUpdate {
  itemId: string;
  ref: string; // "demo#70"
  title: string;
  url: string;
  updatedAt: string; // ISO-8601
}

/** A comment, and the item it belongs to. */
export interface CommentReport extends IssueComment {
  ref: string; // "demo#70", the same ref the board's item carries
}

/** The commits of one note folder, together. */
export interface NotesGroup {
  folder: string; // "Accounts/Acme"
  commits: NotesCommit[];
}

/** The window's meetings, or why there are none to show. */
export type CalendarReport = { snapshot: CalendarSnapshot } | { error: string };

/** Everything one report says, which is also the JSON `zya yesterday` prints. */
export interface Yesterday {
  date: string; // YYYY-MM-DD: the day the window ends on
  window: { from: string; until: string; tz: string };
  calendar: CalendarReport;
  board: BoardUpdate[];
  comments: CommentReport[];
  notes: { truncated: boolean; groups: NotesGroup[] };
}

/** The window a report covers: [previous workday 00:00, date 00:00) in `tz`. */
export interface YesterdayWindow {
  from: string; // ISO-8601, inclusive
  until: string; // ISO-8601, exclusive
  days: number; // how far back it starts: 3 on a Monday
}

export interface YesterdayArgs {
  /** The day the window ends on: the report is about the days before it. */
  date: string;
  env: Env;
  board: BoardSource;
  /** The Mac's calendar, exported on demand for the window. */
  calendar: CalendarSource;
  /** The clock: the export counts its days back from this one's today, not from `date`. */
  now: () => Date;
  fetchFn?: FetchLike;
}

/** Every read the report needs, done, or a throw from the one that failed. */
export async function yesterday(args: YesterdayArgs): Promise<Yesterday> {
  const { env, date } = args;
  const window = yesterdayWindow(date, env.tz);
  const fromMs = Date.parse(window.from);
  const untilMs = Date.parse(window.until);

  const board = await args.board.fetchBoard(env.owner, env.number);
  // One pass over the board: what moved, and the repos whose comments can be
  // read. Every kind of item is an update — a draft and a pull request moved too —
  // but only an issue's url names a repo to ask about comments.
  const updates: BoardUpdate[] = [];
  const repos = new Set<string>();
  for (const item of board.items) {
    const issue = issueOf(item.url);
    if (issue !== null) repos.add(issue.repo);
    const updated = Date.parse(item.updatedAt);
    if (!(updated >= fromMs && updated < untilMs)) continue;
    updates.push({ itemId: item.id, ref: item.ref, title: item.title, url: item.url, updatedAt: item.updatedAt });
  }

  const noted = await fetchIssueComments({
    token: env.token,
    repos: [...repos],
    since: window.from,
    until: window.until,
    fetchFn: args.fetchFn,
  });
  // A comment names its issue, and an issue's url names the same item the board
  // does: the ref needs no lookup, and a comment on an issue the board does not
  // hold still says which issue it was.
  const comments: CommentReport[] = noted.map((comment) => ({
    ...comment,
    ref: issueOf(comment.issueUrl)?.ref ?? "",
  }));

  const notes = await fetchNotesCommits({
    token: env.token,
    repo: env.notesRepo,
    since: window.from,
    until: window.until,
    fetchFn: args.fetchFn,
  });

  let calendar: CalendarReport;
  try {
    calendar = { snapshot: await args.calendar(calendarRequest(window, date, localNow(args.now(), env.tz).date)) };
  } catch (err) {
    calendar = { error: errMessage(err) };
  }

  return {
    date,
    window: { from: window.from, until: window.until, tz: env.tz },
    calendar,
    board: updates,
    comments,
    notes: { truncated: notes.truncated, groups: groupByFolder(notes.commits) },
  };
}

/** The window of one report: the workday before it, midnight to midnight. */
export function yesterdayWindow(date: string, tz: string): YesterdayWindow {
  const first = prevWorkday(date);
  return {
    from: new Date(startOfDay(first, tz)).toISOString(),
    until: new Date(startOfDay(date, tz)).toISOString(),
    days: dayDiff(date, first),
  };
}

/**
 * The window to export, in the offsets the Mac counts from today: `--from` days
 * before the clock's day, `--days` of them. The report's own window is named by
 * `--date`, which may be any day, so the two are not the same numbers — an
 * export asked for `-days` would print the meetings of days nobody asked about.
 *
 * A window the export cannot reach throws, the same way a refused Calendar does:
 * the caller turns either into the report's unavailable line, never into other
 * days under this report's heading.
 */
function calendarRequest(window: YesterdayWindow, date: string, today: string): Omit<CalendarRequest, "app"> {
  const from = dayDiff(prevWorkday(date), today);
  const end = dayDiff(date, today);
  if (end > 0) throw new Error("the window ends after today, and an export reaches no further");
  if (from < -CALENDAR_DAYS_BACK) {
    throw new Error(`the window starts more than ${CALENDAR_DAYS_BACK} days back, past what an export covers`);
  }
  return { from, days: window.days };
}

/**
 * The instant a local day starts in `tz`: the offset is taken at the day's own
 * midnight and once more at the instant that lands on, because a night a zone
 * changes its offset moves the midnight by an hour.
 */
function startOfDay(date: string, tz: string): number {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const guess = midnight - offsetAt(midnight, tz);
  return midnight - offsetAt(guess, tz);
}

/** How far the wall clock in `tz` stands from UTC at one instant, in minutes. */
function offsetAt(ms: number, tz: string): number {
  const at = localNow(new Date(ms), tz);
  return Date.parse(`${at.date}T00:00:00Z`) + at.minutes * 60_000 - ms;
}

/** The one commit each folder's commits are collected under, folders in name order. */
function groupByFolder(commits: NotesCommit[]): NotesGroup[] {
  const byFolder = new Map<string, NotesCommit[]>();
  for (const commit of commits) {
    for (const folder of commit.folders) {
      const group = byFolder.get(folder);
      if (group === undefined) byFolder.set(folder, [commit]);
      else group.push(commit);
    }
  }
  return [...byFolder.keys()].sort().map((folder) => ({ folder, commits: byFolder.get(folder) ?? [] }));
}

/**
 * The issue a url names, whether it is the board's github.com url or the API's,
 * with the repo its comments are read from and the ref the board gives the item.
 * Null for anything else: a draft's project url names no issue.
 */
function issueOf(url: string): { repo: string; ref: string } | null {
  const m = /github\.com\/(?:repos\/)?([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url);
  if (m === null) return null;
  return { repo: `${m[1]}/${m[2]}`, ref: `${m[2]}#${m[3]}` };
}

/**
 * A report as the CLI prints it: markdown with one section per kind of thing
 * that happened, or JSON, which is the report itself. Everything is read in the
 * zone the report was collected in, so the two can never disagree about a day.
 */
export function renderYesterday(report: Yesterday, format: "md" | "json"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;

  const tz = report.window.tz;
  const lines: string[] = [];
  const first = localNow(new Date(report.window.from), tz).date;
  const end = localNow(new Date(report.window.until), tz).date;
  // The day the window ends on is not one of its own: the last day it covers is a
  // moment before it, and a Monday's report is about the days up to Sunday.
  const last = localNow(new Date(Date.parse(report.window.until) - 1), tz).date;
  lines.push(`# Yesterday, ${fmtDate(last)}`);
  lines.push(`window ${fmtDate(first)} 00:00 – ${fmtDate(end)} 00:00 (${tz})`);

  lines.push("## Calendar");
  if ("error" in report.calendar) {
    // A calendar the Mac would not read says so, in place: the day still happened.
    lines.push(`- calendar: unavailable (${report.calendar.error})`);
  } else {
    // The calendar's own renderer, one heading level down, so its days nest here.
    const md = renderCalendar(report.calendar.snapshot, tz, "md").trimEnd();
    if (md === "") lines.push("- no meetings");
    for (const line of md.split("\n")) {
      if (line === "") continue;
      lines.push(line.startsWith("## ") ? `### ${line.slice(3)}` : line);
    }
  }

  lines.push("## Board updates");
  if (report.board.length === 0) lines.push("- no updates");
  for (const update of report.board) {
    lines.push(`- [${update.ref}](${update.url}) ${update.title} (updated ${stamp(update.updatedAt, tz)})`);
  }

  lines.push("## Comments");
  if (report.comments.length === 0) lines.push("- no comments");
  for (const comment of report.comments) {
    // One line per comment: a body's newlines would each become a bullet's sibling.
    const body = comment.body.replace(/\s*\n\s*/g, " ").trim();
    const what = body === "" ? "" : `: ${body}`;
    lines.push(`- [${comment.ref}](${comment.url}) ${comment.author} ${stamp(comment.createdAt, tz)}${what}`);
  }

  lines.push("## Notes commits");
  if (report.notes.groups.length === 0) lines.push("- no commits");
  for (const group of report.notes.groups) {
    lines.push(`### ${group.folder}`);
    for (const commit of group.commits) {
      const label = commit.message === "" ? commit.sha.slice(0, 7) : commit.message;
      lines.push(`- [${label}](${commit.url}) ${stamp(commit.date, tz)}`);
    }
  }
  if (report.notes.truncated) lines.push("- more commits than this report opens");

  return `${lines.join("\n")}\n`;
}

/** One instant as the reader's day and time: "Fri 27 Nov 10:00". */
function stamp(iso: string, tz: string): string {
  const at = localNow(new Date(iso), tz);
  const hh = String(Math.floor(at.minutes / 60)).padStart(2, "0");
  const mm = String(at.minutes % 60).padStart(2, "0");
  return `${fmtDate(at.date)} ${hh}:${mm}`;
}
