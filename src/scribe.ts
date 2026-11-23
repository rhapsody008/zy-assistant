// The scribe's pure parts: the prompt a note model answers, the note's shape,
// the entry it renders, and where the entry goes in a folder's README. No I/O
// and no clock in here: every date and every folder list is passed in, so the
// whole file is testable without a model, without GitHub and without Slack.
//
// Format v0 of an entry: a heading line (date, type, topic), then the notes, then
// the attribution. Newest first, directly under the README's "## Log" line.

import { TZ } from "./time.ts";

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
  /** One of the folders the prompt was given, or null: then newFolderName has one. */
  folder: string | null;
  newFolderName: string | null; // a name, not a path: Accounts/<name>
  date: string; // YYYY-MM-DD
  type: NoteType;
  topic: string;
  attendees: string[];
  summary: string;
  decisions: string[];
  /** Step 2's board proposals start from here; the scribe only stores them. */
  actions: NoteAction[];
}

/**
 * What the note model is told, minus the two things that change per dictation
 * (today's date and the folder list): scribeSystemPrompt() appends those.
 */
export const SCRIBE_SYSTEM_PROMPT = `You are the note scribe of ZY's assistant. ZY dictates a meeting or a work note in a Slack DM; you turn that dictation into one entry for ZY's private notes repo.

Reply with ONE JSON object and nothing else: no prose, no explanation, no code fences.

{
  "folder": "<one of the folders listed below, exactly as written, or null>",
  "newFolderName": "<a folder name under Accounts/, or null>",
  "date": "YYYY-MM-DD",
  "type": "POC" | "Workshop" | "Follow-up" | "Demo-Slides" | "Partner" | "Experiment" | "Learning" | "Admin" | "Meeting",
  "topic": "<at most 8 words>",
  "attendees": ["<person>"],
  "summary": "<2 to 5 sentences>",
  "decisions": ["<one decision>"],
  "actions": [{ "owner": "ZY", "text": "<what to do>", "due": "YYYY-MM-DD" | null }]
}

Rules:
- folder: pick it ONLY from the list of existing folders below, exactly as written. If none of them fits, set folder to null and suggest newFolderName instead (a plain name such as "Acme", which becomes Accounts/Acme).
- folder and newFolderName are never both null: if no folder fits, suggest a new one.
- date: the date the meeting or the work happened; today when the dictation does not say.
- type: the closest of the listed types. A plain note with no other fit is "Meeting"; internal admin or process work is "Admin".
- topic: at most 8 words, no trailing punctuation, no date in it: the date is its own field.
- summary: 2 to 5 sentences saying what the dictation says, and nothing more.
- attendees: the people the dictation names, as written; an empty array when it names none.
- decisions: what was decided, one string each; an empty array when nothing was decided.
- actions: one per thing somebody has to do. The owner is "ZY" when ZY does it (the dictation says "I", "me", "my"), otherwise the person or team named. due is a date only when the dictation gives one, otherwise null.
- Never invent facts, names, numbers or dates. What the dictation does not say is not there.
- Relative dates ("tomorrow", "next Friday", "in two weeks", "end of the month") resolve against today's date. "This Friday" is the next Friday on or after today (today itself when today is a Friday); "next Friday" is the Friday of the following week, 7 days after "this Friday". The same holds for every other weekday.
- ZY is the user: "I", "me" and "mine" mean ZY's own words.
- Empty arrays are fine and correct. Never pad a field to look complete.`;

/** The system prompt for one dictation: the rules, today's date, the folders. */
export function scribeSystemPrompt(today: string, folders: readonly string[]): string {
  const list = folders.length === 0 ? ["(none yet)"] : folders.map((folder) => `- ${folder}`);
  return [
    SCRIBE_SYSTEM_PROMPT,
    "",
    `Today is ${today} (${TZ}).`,
    "",
    "Existing folders in the notes repo:",
    ...list,
  ].join("\n");
}

/** The dictation itself, and the board item it was dictated under when there is one. */
export function scribeUserPrompt(text: string, hint: string | null): string {
  const lines = [`Dictation from Slack:`, "", text.trim()];
  if (hint !== null) lines.push("", `It is about the board item "${hint}".`);
  return lines.join("\n");
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

const ATTRIBUTION = "_Scribed by zy-assistant from Slack._";

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

/** A dictation the model could not turn into a note: kept verbatim, never parsed. */
export function rawEntry(today: string, text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line.trim()}`));
  return [`## ${today} · Meeting · Raw dictation (unprocessed)`, "", ...quoted, "", ATTRIBUTION].join("\n");
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
 */
export function insertEntry(readme: string, entry: string): string {
  if (readme.includes(entry)) return readme;

  const lines = readme.split("\n");
  const at = lines.findIndex((line) => line === "## Log");
  if (at === -1) {
    const body = trimmedEnd(readme);
    return body === "" ? `## Log\n\n${entry}\n` : `${body}\n\n## Log\n\n${entry}\n`;
  }

  const head = `${lines.slice(0, at + 1).join("\n")}\n\n`;
  const rest = lines.slice(at + 1);
  while (rest.length > 0 && rest[0].trim() === "") rest.shift();
  // A README that ends with "## Log" has nothing after it but blank lines.
  return rest.length === 0 ? `${head}${entry}\n` : `${head}${entry}\n\n${trimmedEnd(rest.join("\n"))}\n`;
}
