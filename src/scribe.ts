// The scribe's pure parts: the note's shape, the entry it renders, where the
// entry goes in a folder's README, and where a write may land at all. No I/O and
// no clock in here: every date and every folder list is passed in, so the whole
// file is testable without GitHub and without a network.
//
// Format v0 of an entry: a heading line (date, type, topic), then the notes, then
// the attribution. Newest first, directly under the README's "## Log" line.

export const NOTE_TYPES = [
  "POC",
  "Workshop",
  "Follow-up",
  "Demo-Slides",
  "Partner",
  "Experiment",
  "Learning",
  "Admin",
  "Meeting",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

export interface NoteAction {
  owner: string; // "ZY" when it is ZY who does it
  text: string;
  due: string | null; // YYYY-MM-DD
}

export interface Note {
  /** One of the repo's folders, or null: then newFolderName has one. */
  folder: string | null;
  newFolderName: string | null; // a name, not a path: Accounts/<name>
  date: string; // YYYY-MM-DD
  type: NoteType;
  topic: string;
  attendees: string[];
  summary: string;
  decisions: string[];
  /** Where the board items in `note-items.ts` start from: the scribe only stores them. */
  actions: NoteAction[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A folder name under Accounts/: one line, no separator, at most 64 characters. */
const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

/** The one root a new folder goes under. */
const ACCOUNTS = "Accounts/";

/** One line: every run of whitespace, newlines included, becomes a single space. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Cut to `max` characters: what a model wrote longer than the field allows. */
function clipped(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

/** One sanitised line of a note, or its own throw when it is empty. */
function line(value: unknown, what: string, max: number): string {
  return clipped(oneLine(text(value, what)), max);
}

/** An existing folder, checked where it is used: exactly one the repo just listed. */
export function safeFolder(folder: string, listed: string[]): string | null {
  return listed.includes(folder) ? folder : null;
}

/** A new folder's path from a name: Accounts/<name>, or null when the name is unsafe. */
export function safeNewFolder(name: string): string | null {
  return FOLDER_NAME_RE.test(name) ? `${ACCOUNTS}${name}` : null;
}

/**
 * Where a write may land: one of the folders the repo lists right now, or a new
 * Accounts/<name> whose name the pattern accepts. Pure.
 */
export function writeFolder(folder: string, listed: string[]): string | null {
  const existing = safeFolder(folder, listed);
  if (existing !== null) return existing;
  return folder.startsWith(ACCOUNTS) ? safeNewFolder(folder.slice(ACCOUNTS.length)) : null;
}

const TOPIC_MAX = 80;
const FIELD_MAX = 300;
const SUMMARY_MAX = 1500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(what: string): never {
  throw new Error(`the note is not valid: ${what}`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${what} must be a non-empty string`);
  return value.trim();
}

function date(value: unknown, what: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) fail(`${what} must be a date like 2026-11-25`);
  return value;
}

function optionalText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, what);
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) fail(`${what} must be an array of strings`);
  return value.map((item, index) => text(item, `${what}[${index}]`));
}

/**
 * The shape of a note, strictly: every field the entry renders has to be there
 * and be usable. The message of a throw is what the retry hands back to the
 * model, so it names the field it did not like.
 */
export function validateNote(value: unknown): Note {
  if (!isRecord(value)) fail("the reply is not a JSON object");

  const folder = optionalText(value.folder, "folder");
  const newFolderName = optionalText(value.newFolderName, "newFolderName");
  if (folder === null && newFolderName === null) fail("either folder or newFolderName must be set");
  if (newFolderName !== null && newFolderName.includes("/")) fail("newFolderName must be one folder name, not a path");

  const type = text(value.type, "type");
  if (!(NOTE_TYPES as readonly string[]).includes(type)) fail(`type must be one of ${NOTE_TYPES.join(", ")}`);

  if (!Array.isArray(value.actions)) fail("actions must be an array");
  const actions: NoteAction[] = value.actions.map((raw: unknown, index: number) => {
    if (!isRecord(raw)) fail(`actions[${index}] must be an object`);
    return {
      owner: line(raw.owner, `actions[${index}].owner`, FIELD_MAX),
      text: line(raw.text, `actions[${index}].text`, FIELD_MAX),
      due: raw.due === null || raw.due === undefined ? null : date(raw.due, `actions[${index}].due`),
    };
  });

  // Every field here ends up in a README or in a commit message, so every one of
  // them is one line and no longer than its field can be.
  return {
    folder,
    newFolderName,
    date: date(value.date, "date"),
    type: type as NoteType,
    topic: line(value.topic, "topic", TOPIC_MAX),
    attendees: strings(value.attendees, "attendees").map((item) => clipped(oneLine(item), FIELD_MAX)),
    summary: line(value.summary, "summary", SUMMARY_MAX),
    decisions: strings(value.decisions, "decisions").map((item) => clipped(oneLine(item), FIELD_MAX)),
    actions,
  };
}

const ATTRIBUTION = "_Written via zya._";

/** One note as a format v0 entry: no trailing newline, blank lines between blocks. */
export function renderEntry(note: Note): string {
  const blocks: string[][] = [];

  const head = [`## ${note.date} · ${note.type} · ${note.topic}`];
  const lines: string[] = [];
  if (note.attendees.length > 0) lines.push(`**Attendees:** ${note.attendees.join(", ")}`);
  lines.push(`**Summary:** ${note.summary}`);
  if (note.decisions.length > 0) lines.push("**Decisions:**", ...note.decisions.map((d) => `- ${d}`));
  blocks.push([...head, "", ...lines]);

  if (note.actions.length > 0) {
    blocks.push([
      "### Actions",
      ...note.actions.map((a) => `- [ ] ${a.owner}: ${a.text}${a.due === null ? "" : ` (due ${a.due})`}`),
    ]);
  }

  blocks.push([ATTRIBUTION]);
  return blocks.map((block) => block.join("\n")).join("\n\n");
}

/** Where a new README's table sends a note: ZY's accounts and partners first. */
function headerRow(folder: string): { name: string; type: string; track: string } {
  const slash = folder.indexOf("/");
  const name = slash === -1 ? folder : folder.slice(slash + 1);
  const root = slash === -1 ? "" : folder.slice(0, slash);
  return { name, type: root === "Partners" ? "Partner" : "-", track: root === "Accounts" ? "Customer" : "-" };
}

/**
 * A folder's first README: the format v0 status table with nothing filled in,
 * then Context and the Log the entry goes into.
 */
export function newReadme(folder: string, entry: string): string {
  const { name, type, track } = headerRow(folder);
  return [
    `# ${name}`,
    "",
    "| | |",
    "|---|---|",
    `| Track | ${track} |`,
    `| Type | ${type} |`,
    "| Status | Inbox |",
    "| Products | - |",
    "| Next action | - |",
    "| Next touch | - |",
    "| Target date | - |",
    "| Waiting on | - |",
    "| Board | - |",
    "",
    "## Context",
    "",
    "-",
    "",
    "## Contacts",
    "",
    "-",
    "",
    "## Log",
    "",
    entry,
    "",
  ].join("\n");
}

const trimmedEnd = (text: string): string => text.replace(/\s+$/, "");

/**
 * The README with one entry inserted under its first exact "## Log" line, newest
 * first, one blank line each side. No "## Log" line: the section is appended.
 * An entry that is already in there is not inserted twice.
 *
 * Nothing outside the insertion is touched: the text before the heading and the
 * old entries under it are copied through as they are, whatever their endings and
 * trailing whitespace. Only the entry itself is formatted, with the ending the
 * heading line uses — so a CRLF README gets a CRLF entry, and a README with mixed
 * endings keeps them.
 */
export function insertEntry(readme: string, entry: string): string {
  // Compared with one ending, so an entry already in a CRLF README is still found.
  if (readme.replace(/\r\n/g, "\n").includes(entry)) return readme;

  const firstEnding = /\r\n|\n/.exec(readme)?.[0] ?? "\n";
  // The first "## Log" line, with its own ending: the heading, and where the lines
  // under it start. A heading that ends the file has none, and takes the file's.
  const heading = /(^|\r?\n)## Log(\r\n|\n|$)/.exec(readme);
  if (heading === null) {
    const added = entry.split(/\r?\n/).join(firstEnding);
    const body = trimmedEnd(readme);
    return body === ""
      ? `## Log${firstEnding}${firstEnding}${added}${firstEnding}`
      : `${body}${firstEnding}${firstEnding}## Log${firstEnding}${firstEnding}${added}${firstEnding}`;
  }

  const ending = heading[2] === "" ? firstEnding : heading[2];
  const head = readme.slice(0, heading.index) + heading[0] + (heading[2] === "" ? ending : "");
  // The blank lines right under the heading make room for the entry; everything
  // after them is the old entries, copied as it was.
  const rest = readme.slice(heading.index + heading[0].length).replace(/^(?:[^\S\r\n]*\r?\n)+/, "");
  const added = entry.split(/\r?\n/).join(ending);
  // A README that ends with "## Log" has nothing after it but blank lines.
  return rest === "" ? `${head}${ending}${added}${ending}` : `${head}${ending}${added}${ending}${ending}${rest}`;
}
