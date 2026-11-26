// `zya note`: one scribe-format entry into one folder of the notes repo. The
// folder is checked against the repo's own listing before anything is read, and
// the README is read again for every attempt, because a sha is only good for the
// text it was read with. A dry run is the same work, stopping before the write.

import { ShaConflict, type NotesClient } from "./notes.ts";
import { insertEntry, newReadme, oneLine, renderEntry, writeFolder, type Note } from "./scribe.ts";

/** How many writes one note may make: each attempt reads the sha it writes with. */
const ATTEMPTS = 3;

/** What one note was written as: where it goes, what it says, and the commit that put it there. */
export interface NoteWrite {
  folder: string; // "Accounts/Acme"
  path: string; // "Accounts/Acme/README.md"
  entry: string;
  /** The commit's url; null after a dry run, which wrote nothing. */
  url: string | null;
}

/**
 * One note into its folder's README. The folder is one the repo lists or a new
 * Accounts/<name>, and anything else is refused before a read; the folder's
 * README is read and the entry goes under its "## Log" line, newest first, or a
 * new README is its first entry. A write that lost the sha to another writer is
 * read again and retried, at most ATTEMPTS times: every attempt writes the text
 * it read. A dry run returns the same result with no url, having written nothing.
 */
export async function writeNote(notes: NotesClient, note: Note, options: { dryRun: boolean }): Promise<NoteWrite> {
  const requested = note.folder ?? `Accounts/${note.newFolderName ?? ""}`;
  const folder = writeFolder(requested, await notes.listFolders());
  if (folder === null) {
    throw new Error(`note: refusing ${JSON.stringify(requested)}: it is no folder of the repo, and no new Accounts/<name>`);
  }

  const path = `${folder}/README.md`;
  const entry = renderEntry(note);
  if (options.dryRun) return { folder, path, entry, url: null };

  // The folder, the day, the topic, and the tool that wrote it: one message for
  // every attempt, whether the first write lands or a later one does.
  const message = `notes(${folder}): ${note.date} ${oneLine(note.topic)} [zya]`;
  for (let attempt = 1; ; attempt += 1) {
    // Every attempt reads the file it is about to write: a sha is only good for
    // the text it came with, and another writer's commit replaced it.
    const existing = await notes.readFile(path);
    const text = existing === null ? newReadme(folder, entry) : insertEntry(existing.text, entry);
    try {
      const url = await notes.writeFile(path, text, existing?.sha ?? null, message);
      return { folder, path, entry, url };
    } catch (err) {
      // Another writer got there first: the retry writes on top of their text.
      if (!(err instanceof ShaConflict) || attempt >= ATTEMPTS) throw err;
    }
  }
}
