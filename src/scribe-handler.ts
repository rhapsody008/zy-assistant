// The scribe's pipeline: a dictation in, a committed note entry with a link out.
// The Slack handler and the CLI both go through here, so what ZY tries from the
// Mac is what the bot does in a DM.
//
// Nothing dictated is lost. The raw text is stored before the model is called;
// the extracted note is stored before a folder is asked about, so answering the
// question never calls the model again; and a model that cannot answer still
// leaves the words to be committed, verbatim, once ZY says where they go.
//
// Where a write may land is decided in one place, writeEntry: a folder the model
// answered with is only a folder the repo lists, and a folder to create is only
// Accounts/<a name the pattern accepts>. Nothing the model says becomes a path.
//
// Step 2 (board proposals) is not here: the note's actions are rendered, stored
// and listed back, and nothing is proposed to the board yet.

import { errMessage } from "./errors.ts";
import { completeJson, type Llm } from "./llm.ts";
import { ShaConflict, type NotesClient } from "./notes.ts";
import {
  insertEntry,
  newReadme,
  oneLine,
  rawEntry,
  renderEntry,
  safeFolder,
  safeNewFolder,
  scribeSystemPrompt,
  scribeUserPrompt,
  validateNote,
  type Note,
} from "./scribe.ts";
import type { Dictation, DictationStatus, DictationStore } from "./store.ts";
import { localNow, TZ } from "./time.ts";

/** Read, insert, write: a README that changes under us gets this many tries. */
const WRITE_ATTEMPTS = 3;

/** The statuses a click may take over: the dictation waits for an answer or a retry. */
const CLAIM_FROM: DictationStatus[] = ["asked", "failed"];

/** One `note: ...` DM. */
export interface ScribeDictation {
  ts: string; // the Slack message ts: the dedupe key and the thread parent
  text: string; // the dictation, without the "note:" prefix
  hint: string | null; // the title of the ping this was dictated under, if any
}

/** The folder question: create a new folder, put it in an existing one, or retry a write. */
export interface ScribeAsk {
  ts: string; // the dictation the answer belongs to
  text: string;
  folders: string[]; // the existing folders to offer
  create: string | null; // the new folder name to offer creating (Accounts/<name>), or null
  retry: boolean; // the last write failed: offer to try the same folder again
}

/** How the pipeline talks to whoever is watching: Slack, or the CLI's stdout. */
export interface ScribeUi {
  /** A reply in the dictation's thread; the ts it returns can be edited later. */
  reply(text: string): Promise<string>;
  edit(ts: string, text: string): Promise<void>;
  ask(ask: ScribeAsk): Promise<void>;
}

export interface ScribeDeps {
  llm: Llm;
  notes: NotesClient;
  dictations: DictationStore;
  now: () => Date;
  log: (line: string) => void;
  /** The model's own budget, LLM_TIMEOUT_MS. */
  timeoutMs: number;
  /** How long its reply may be, LLM_MAX_TOKENS. */
  maxTokens: number;
}

/**
 * The model's one attempt (plus its one retry): the system prompt carries the
 * folders it may pick from. The caller lists them, because a note that names no
 * folder becomes a question about them.
 */
export async function extractNote(
  deps: Pick<ScribeDeps, "llm" | "timeoutMs" | "maxTokens">,
  args: { text: string; hint: string | null; today: string; folders: string[] },
): Promise<Note> {
  return completeJson(
    deps.llm,
    {
      system: scribeSystemPrompt(args.today, args.folders),
      user: scribeUserPrompt(args.text, args.hint),
      maxTokens: deps.maxTokens,
      timeoutMs: deps.timeoutMs,
    },
    validateNote,
  );
}

/**
 * Where a write may land: one of the folders the repo lists right now, or a new
 * Accounts/<name> whose name the pattern accepts. Pure.
 */
export function writeFolder(folder: string, listed: string[]): string | null {
  const existing = safeFolder(folder, listed);
  if (existing !== null) return existing;
  return folder.startsWith("Accounts/") ? safeNewFolder(folder.slice("Accounts/".length)) : null;
}

/**
 * The README of the folder with the entry in it, and the commit's html_url. The
 * folder is checked here, the one place that writes, against a fresh list: an
 * existing folder has to be one the repo has, or it is a failure and the
 * dictation stays. A write that lost the race for the file is read again, up to
 * WRITE_ATTEMPTS.
 */
export async function writeEntry(
  deps: Pick<ScribeDeps, "notes" | "log">,
  args: { folder: string; entry: string; date: string; topic: string },
): Promise<string> {
  const folder = writeFolder(args.folder, await deps.notes.listFolders());
  if (folder === null) throw new Error(`${JSON.stringify(args.folder)} is not a folder of the notes repo`);
  const path = `${folder}/README.md`;
  const message = `notes(${folder}): ${args.date} ${oneLine(args.topic)} [scribe]`;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const existing = await deps.notes.readFile(path);
    const readme = existing === null ? newReadme(folder, args.entry) : insertEntry(existing.text, args.entry);
    try {
      return await deps.notes.writeFile(path, readme, existing?.sha ?? null, message);
    } catch (err) {
      if (!(err instanceof ShaConflict)) throw err;
      deps.log(`scribe: ${path} changed under us (attempt ${attempt} of ${WRITE_ATTEMPTS}), reading it again`);
    }
  }
  throw new Error(`${path} kept changing under us, gave up after ${WRITE_ATTEMPTS} attempts`);
}

/** "✅ Accounts/Acme: size the VPC → https://…", and the actions, which step 2 picks up. */
export function doneMessage(folder: string, topic: string, url: string, actions: Note["actions"]): string {
  const head = `✅ ${folder}: ${topic} → ${url}`;
  if (actions.length === 0) return head;
  const list = actions.map((a) => `• ${a.owner}: ${a.text}${a.due === null ? "" : ` (due ${a.due})`}`);
  return [head, "board proposals: coming in step 2", ...list].join("\n");
}

interface CommitArgs {
  ts: string;
  folder: string;
  entry: string;
  date: string; // for the commit message
  topic: string; // ditto, and in the reply
  actions: Note["actions"];
  /** True: the words go in verbatim, because the model never answered. */
  raw: boolean;
  ui: ScribeUi;
  /** The "writing…" message to turn into the result, or null to reply afresh. */
  ackTs: string | null;
}

/**
 * Writes one entry and says where it landed. A failed write keeps the dictation
 * and asks again, with a Retry button, so there is something to click once
 * GitHub is back: nothing is stranded.
 */
async function commit(deps: ScribeDeps, args: CommitArgs): Promise<void> {
  const startedAt = deps.now().getTime();
  let url: string;
  try {
    url = await writeEntry(deps, { folder: args.folder, entry: args.entry, date: args.date, topic: args.topic });
  } catch (err) {
    const reason = errMessage(err);
    const warning = `⚠️ could not write ${oneLine(args.folder)}: ${reason}`;
    deps.log(`scribe ${args.ts}: writing ${args.folder} failed: ${reason}`);
    deps.dictations.updateDictation(args.ts, { status: "failed", folder: args.folder, error: reason });
    if (args.ackTs === null) {
      await args.ui.ask({ ts: args.ts, text: warning, folders: [], create: null, retry: true });
    } else {
      await args.ui.edit(args.ackTs, warning);
      await args.ui.ask({ ts: args.ts, text: "Try writing it again?", folders: [], create: null, retry: true });
    }
    return;
  }
  deps.dictations.updateDictation(args.ts, { status: "done", folder: args.folder, commitUrl: url, error: null });
  // One line per commit, ids only: no dictation text, no note title, no folder tree.
  if (args.raw) deps.log(`scribe ${args.ts}: committed raw text to ${args.folder}`);
  else deps.log(`scribe ${args.ts}: committed ${args.folder} in ${deps.now().getTime() - startedAt} ms (${args.actions.length} actions) ${url}`);
  await report(args.ui, args.ackTs, doneMessage(args.folder, args.topic, url, args.actions));
}

async function report(ui: ScribeUi, ackTs: string | null, text: string): Promise<void> {
  if (ackTs === null) await ui.reply(text);
  else await ui.edit(ackTs, text);
}

/** The model's new folder, when its name is one a folder may have. */
function suggestedFolder(name: string | null): { path: string; name: string } | null {
  if (name === null) return null;
  const path = safeNewFolder(name);
  return path === null ? null : { path, name };
}

/** The one note `note: ...` DM: store, extract, then write or ask where it goes. */
export async function scribeHandler(deps: ScribeDeps, dictation: ScribeDictation, ui: ScribeUi): Promise<void> {
  const now = deps.now();
  const today = localNow(now, TZ).date;
  // The stored ts is the dedupe: Slack redelivers, and a second socket answers too.
  if (!deps.dictations.recordDictation({ ts: dictation.ts, text: dictation.text, createdAt: now.toISOString() })) {
    deps.log(`scribe ${dictation.ts}: already stored, ignoring the redelivery`);
    return;
  }
  if (!deps.dictations.claimDictation(dictation.ts, ["stored"])) {
    deps.log(`scribe ${dictation.ts}: another run took it first, ignoring this one`);
    return;
  }
  const ackTs = await ui.reply("📝 writing…");

  let folders: string[];
  try {
    folders = await deps.notes.listFolders();
  } catch (err) {
    const reason = errMessage(err);
    deps.log(`scribe ${dictation.ts}: could not list the notes folders: ${reason}`);
    deps.dictations.updateDictation(dictation.ts, { status: "failed", error: reason });
    await ui.edit(ackTs, `⚠️ could not read the notes repo: ${reason}`);
    return;
  }

  let note: Note | null = null;
  let failure: string | null = null;
  try {
    note = await extractNote(deps, { text: dictation.text, hint: dictation.hint, today, folders });
  } catch (err) {
    failure = errMessage(err);
    deps.log(`scribe ${dictation.ts}: the note model failed: ${failure}`);
    deps.dictations.updateDictation(dictation.ts, { status: "failed", error: failure });
  }

  // A folder the repo does not have is no folder: an injected or invented path
  // never reaches a write, the question does.
  const known = note === null || note.folder === null ? null : safeFolder(note.folder, folders);
  if (note !== null && known !== null) {
    // The extracted note is kept before it is written: its actions are what step
    // 2 (board proposals) will read, and a failed write must not lose them.
    deps.dictations.updateDictation(dictation.ts, { noteJson: JSON.stringify(note), folder: known });
    await commit(deps, {
      ts: dictation.ts,
      folder: known,
      entry: renderEntry(note),
      date: note.date,
      topic: note.topic,
      actions: note.actions,
      raw: false,
      ui,
      ackTs,
    });
    return;
  }

  // Either the model found no folder, or it did not answer at all. Both end in
  // the same question, answered from the stored dictation: the model is not asked twice.
  const suggested = note === null ? null : suggestedFolder(note.newFolderName);
  let text: string;
  if (note === null) {
    await ui.edit(ackTs, `⚠️ the note model failed: ${failure}`);
    text = "Where should the raw dictation go? Nothing is lost: the words are stored as they are.";
  } else {
    deps.dictations.updateDictation(dictation.ts, { noteJson: JSON.stringify(note), status: "asked", error: null });
    await ui.edit(ackTs, "📁 needs a folder");
    text = suggested === null ? "Where should this note go?" : `New folder \`${suggested.path}\`?`;
  }
  await ui.ask({ ts: dictation.ts, text, folders, create: suggested?.name ?? null, retry: false });
  deps.log(`scribe ${dictation.ts}: asked for a folder`);
}

/** ZY's answer to the folder question: an existing folder, a new one, a retry, or cancel. */
export interface ScribeChoice {
  ts: string; // the dictation
  action: "create" | "folder" | "retry" | "cancel";
  /** folder: the folder picked; create, retry and cancel: null. */
  value: string | null;
}

const CHOICE_IDS = {
  create: "zy_scribe_create",
  cancel: "zy_scribe_cancel",
  retry: "zy_scribe_retry",
  folder: "zy_scribe_folder",
} as const;

/** The folder select's block_id starts with this: its options carry only a folder. */
export const FOLDER_BLOCK_PREFIX = "zy_scribe_";

/**
 * The button's value, or the select's option and block: what a click means. Pure.
 * The select's options hold a folder and nothing else, so the dictation rides in
 * the block_id instead: an option value stays short whatever the ts is.
 */
export function parseScribeChoice(
  actionId: string,
  value: string | null,
  selected: string | null,
  blockId: string | null,
): ScribeChoice | null {
  if (actionId === CHOICE_IDS.create) return value === null ? null : { ts: value, action: "create", value: null };
  if (actionId === CHOICE_IDS.cancel) return value === null ? null : { ts: value, action: "cancel", value: null };
  if (actionId === CHOICE_IDS.retry) return value === null ? null : { ts: value, action: "retry", value: null };
  if (actionId !== CHOICE_IDS.folder || selected === null || selected === "") return null;
  if (blockId === null || !blockId.startsWith(FOLDER_BLOCK_PREFIX)) return null;
  const ts = blockId.slice(FOLDER_BLOCK_PREFIX.length);
  return ts === "" ? null : { ts, action: "folder", value: selected };
}

function storedNote(json: string | null): Note | null {
  if (json === null) return null;
  try {
    return validateNote(JSON.parse(json));
  } catch {
    return null; // a note we cannot read is a note we never got: the raw text is still there
  }
}

/** The folder a click means: the stored note's new name, a retry's own folder, or the pick. */
function choiceFolder(choice: ScribeChoice, dictation: Dictation, note: Note | null): string | null {
  if (choice.action === "create") {
    // Create writes the name the note suggested, re-validated: never the click's value.
    return note === null || note.newFolderName === null ? null : safeNewFolder(note.newFolderName);
  }
  if (choice.action === "retry") return dictation.folder;
  return choice.value;
}

/** What a click that lost the race is told: the write it wanted already happened. */
async function alreadyHandled(dictation: Dictation, ui: ScribeUi): Promise<void> {
  const written = `already written: ${dictation.commitUrl ?? ""}`.trim();
  await ui.reply(dictation.status === "done" ? written : "already handled");
}

/** The answer to the folder question: the write the model's answer was waiting for. */
export async function scribeChoice(deps: ScribeDeps, choice: ScribeChoice, ui: ScribeUi): Promise<void> {
  const dictation = deps.dictations.findDictation(choice.ts);
  if (dictation === null) {
    deps.log(`scribe ${choice.ts}: no such dictation`);
    return;
  }
  if (choice.action === "cancel") {
    // A cancel races a click on the same question too: only the first one counts.
    if (!deps.dictations.claimDictation(choice.ts, CLAIM_FROM)) {
      deps.log(`scribe ${choice.ts}: already ${dictation.status}, this cancel does nothing`);
      await alreadyHandled(dictation, ui);
      return;
    }
    deps.dictations.updateDictation(choice.ts, { status: "cancelled" });
    await ui.reply("Cancelled. The dictation stays stored.");
    return;
  }

  const note = storedNote(dictation.noteJson);
  const folder = choiceFolder(choice, dictation, note);
  if (folder === null) {
    deps.log(`scribe ${choice.ts}: the choice names no folder this repo may have`);
    return;
  }
  // One click wins: a double click, a click on a written note, or a Create racing
  // a select all end here, and only the first one commits.
  if (!deps.dictations.claimDictation(choice.ts, CLAIM_FROM)) {
    deps.log(`scribe ${choice.ts}: already ${dictation.status}, this choice does nothing`);
    await alreadyHandled(dictation, ui);
    return;
  }

  // The day ZY dictated it, not the day of the click.
  const today = localNow(new Date(dictation.createdAt), TZ).date;
  if (note === null) {
    // The model never answered: the words go in verbatim, and they are not edited.
    await commit(deps, {
      ts: choice.ts,
      folder,
      entry: rawEntry(today, dictation.text),
      date: today,
      topic: "Raw dictation (unprocessed)",
      actions: [],
      raw: true,
      ui,
      ackTs: null,
    });
    return;
  }
  await commit(deps, {
    ts: choice.ts,
    folder,
    entry: renderEntry(note),
    date: note.date,
    topic: note.topic,
    actions: note.actions,
    raw: false,
    ui,
    ackTs: null,
  });
}
