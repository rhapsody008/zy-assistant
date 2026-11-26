// `zya note` without a network and without the real repo: the notes repo is
// FakeNotes, whose files, shas and conflicts are the test's, and a note arrives as
// the JSON a caller pipes in. Synthetic names only: "Acme", "Globex", "Initech".

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runNoteCli, type NoteCliDeps } from "../src/cli.ts";
import { writeNote } from "../src/note.ts";
import { ShaConflict } from "../src/notes.ts";
import { insertEntry, newReadme, renderEntry, validateNote, type Note } from "../src/scribe.ts";
import { FakeNotes } from "./fakes.ts";

const FULL = {
  folder: "Accounts/Acme",
  newFolderName: null,
  date: "2026-11-25",
  type: "Workshop",
  topic: "Acme VPC sizing",
  attendees: ["ZY", "Ana"],
  summary: "We sized the VPC. Ten nodes is enough.",
  decisions: ["Ten nodes"],
  actions: [{ owner: "ZY", text: "send the sizing sheet", due: "2026-11-28" }],
};

const note = (overrides: Partial<Note> = {}): Note => ({ ...validateNote(FULL), ...overrides });

/** A folder's README as it already is: one older entry under its Log. */
const README = ["# Acme", "", "## Log", "", "## 2026-11-20 · Meeting · Older", "", "**Summary:** Old.", ""].join("\n");

/** The notes repo with Acme's folder, and the README in it. */
function fakeNotes(): FakeNotes {
  const notes = new FakeNotes();
  notes.folders.push("Accounts/Acme");
  notes.files.set("Accounts/Acme/README.md", { text: README, sha: "sha-0" });
  return notes;
}

/** The deps of one `zya note` run, and the sink it writes to. */
function setup(notes: FakeNotes, json: string): { deps: NoteCliDeps; written: string[] } {
  const written: string[] = [];
  return { deps: { notes, stdin: async () => json, out: (s) => written.push(s) }, written };
}

/**
 * FakeNotes where the write that loses its sha is a real revision by another
 * writer: their entry is in the README the retry reads. FakeNotes' own `conflicts`
 * changes the sha and keeps the text, which cannot tell a retry that writes what it
 * read again from one that writes what it read first.
 */
class RacingNotes extends FakeNotes {
  /** What the other writer committed between this run's read and its write. */
  readonly theirs = "## 2026-11-24 · Meeting · Theirs\n\n**Summary:** Their edit.";
  raced = false;

  override async writeFile(path: string, text: string, sha: string | null, message: string): Promise<string> {
    if (!this.raced) {
      this.raced = true;
      // Their commit: the README with their entry newest, under a new sha.
      const withTheirs = insertEntry(this.files.get(path)?.text ?? "", this.theirs);
      this.files.set(path, { text: withTheirs, sha: "sha-theirs" });
      throw new ShaConflict(`write ${path}: GitHub API 409: sha does not match`);
    }
    return super.writeFile(path, text, sha, message);
  }
}

/** FakeNotes whose write never answers: a timeout that may have committed all the same. */
class UnansweredNotes extends FakeNotes {
  attempts = 0;

  override async writeFile(path: string): Promise<string> {
    this.attempts += 1;
    throw new Error(`write ${path}: the request timed out`);
  }
}

test("a dry run returns the folder, the path and the entry, and writes nothing", async () => {
  const notes = fakeNotes();
  const written = await writeNote(notes, note(), { dryRun: true });

  assert.deepEqual(written, {
    folder: "Accounts/Acme",
    path: "Accounts/Acme/README.md",
    entry: renderEntry(note()),
    url: null,
  });
  assert.deepEqual(notes.writes, [], "no write");
  assert.deepEqual(notes.reads, [], "the README is not even read");
  assert.equal(notes.files.get("Accounts/Acme/README.md")?.text, README, "the repo is as it was");
});

test("an existing README gets the entry under its Log, newest first, with the sha it was read with", async () => {
  const notes = fakeNotes();
  const written = await writeNote(notes, note(), { dryRun: false });
  const entry = renderEntry(note());

  assert.equal(written.url, "https://github.com/demo/notes/commit/1");
  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].path, "Accounts/Acme/README.md");
  assert.equal(notes.writes[0].sha, "sha-0");
  assert.equal(notes.writes[0].message, "notes(Accounts/Acme): 2026-11-25 Acme VPC sizing [zya]");
  assert.equal(
    notes.writes[0].text,
    ["# Acme", "", "## Log", "", entry, "", "## 2026-11-20 · Meeting · Older", "", "**Summary:** Old.", ""].join("\n"),
    "the new entry is first under the Log, the old one is under it",
  );
  assert.equal(notes.files.get("Accounts/Acme/README.md")?.text, notes.writes[0].text, "and the repo holds it");
});

test("a README written with CRLF keeps its ending: one Log, the new entry first", async () => {
  const notes = new FakeNotes();
  notes.folders.push("Accounts/Acme");
  const crlf = [
    "# Acme",
    "",
    "## Log",
    "",
    "## 2026-11-20 · Meeting · Older",
    "",
    "**Summary:** Old.",
    "",
  ].join("\r\n");
  notes.files.set("Accounts/Acme/README.md", { text: crlf, sha: "sha-0" });

  await writeNote(notes, note(), { dryRun: false });
  const text = notes.writes[0].text;
  assert.equal(text.split("## Log").length - 1, 1, "one Log heading, not a second one at the end");
  assert.equal(
    text,
    ["# Acme", "", "## Log", "", renderEntry(note()).replace(/\n/g, "\r\n"), "", "## 2026-11-20 · Meeting · Older", "", "**Summary:** Old.", ""].join("\r\n"),
    "and the new entry is the first line under it",
  );
});

test("a folder the repo does not list, suggested as new, gets a new README as its first entry", async () => {
  const notes = new FakeNotes();
  const fresh = note({ folder: null, newFolderName: "Initech" });
  const written = await writeNote(notes, fresh, { dryRun: false });
  const entry = renderEntry(fresh);

  assert.equal(written.folder, "Accounts/Initech");
  assert.equal(written.path, "Accounts/Initech/README.md");
  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].sha, null, "a file that is not there yet is written without a sha");
  assert.equal(notes.writes[0].text, newReadme("Accounts/Initech", entry));
  assert.equal(notes.writes[0].message, "notes(Accounts/Initech): 2026-11-25 Acme VPC sizing [zya]");

  // An Accounts/<name> the listing does not have is a new folder under the same
  // rule: it is a name no other root may invent, and writeFolder says which.
  assert.equal((await writeNote(new FakeNotes(), note({ folder: "Accounts/Globex" }), { dryRun: true })).folder, "Accounts/Globex");
});

test("an unknown folder, and an unsafe new name, are both refused before anything is read or written", async () => {
  const notes = fakeNotes();
  const unknown = note({ folder: "Partners/Globex" }); // another root, and no such folder there
  const unsafe = note({ folder: null, newFolderName: ".github" }); // a name no folder may have

  await assert.rejects(writeNote(notes, unknown, { dryRun: false }), /note: refusing "Partners\/Globex"/);
  await assert.rejects(writeNote(notes, unsafe, { dryRun: false }), /note: refusing "Accounts\/\.github"/);
  // A dry run checks the folder too: a refused folder is no more writable there.
  await assert.rejects(writeNote(notes, unknown, { dryRun: true }), /note: refusing/);

  assert.deepEqual(notes.reads, [], "no README was read");
  assert.deepEqual(notes.writes, [], "nothing was written");
});

test("a write that lost its sha is retried on what it reads again, so the other writer's edit survives", async () => {
  const notes = new RacingNotes();
  notes.folders.push("Accounts/Acme");
  notes.files.set("Accounts/Acme/README.md", { text: README, sha: "sha-0" });

  const written = await writeNote(notes, note(), { dryRun: false });
  const entry = renderEntry(note());
  const text = notes.writes[0].text;

  assert.equal(written.url, "https://github.com/demo/notes/commit/1", "the commit of the write that landed");
  assert.equal(notes.writes.length, 1, "one write landed");
  assert.equal(notes.reads.length, 2, "read, refused by another writer, read again");
  assert.equal(notes.writes[0].sha, "sha-theirs", "the retry writes the sha the second read gave it");
  assert.equal(text.includes(notes.theirs), true, "the other writer's entry is still in the README");
  assert.equal(text.split(entry).length - 1, 1, "this note is in the README once");
  assert.equal(text.split("## Log").length - 1, 1, "under the one Log heading");
  assert.equal(text.indexOf(entry) < text.indexOf(notes.theirs), true, "and newest first, so above theirs");
});

test("a repo that keeps conflicting is given up on after three writes, not retried forever", async () => {
  const notes = fakeNotes();
  notes.conflicts = 3;
  await assert.rejects(writeNote(notes, note(), { dryRun: false }), ShaConflict);
  assert.equal(notes.commits, 3, "three attempts, no fourth");
  assert.deepEqual(notes.writes, [], "and none of them landed");
});

test("a write that failed without an answer is not retried: only a lost sha is", async () => {
  const notes = new UnansweredNotes();
  notes.folders.push("Accounts/Acme");
  notes.files.set("Accounts/Acme/README.md", { text: README, sha: "sha-0" });

  await assert.rejects(writeNote(notes, note(), { dryRun: false }), /the request timed out/);
  assert.equal(notes.attempts, 1, "one attempt, and no second one");
  assert.equal(notes.reads.length, 1, "no second read either");
  assert.deepEqual(notes.writes, [], "nothing landed");
});

test("the CLI prints the folder, the path, the entry and the url as JSON", async () => {
  const notes = fakeNotes();
  const { deps, written } = setup(notes, JSON.stringify(FULL));
  assert.equal(await runNoteCli(["note"], deps), 0);

  const json = JSON.parse(written.join("")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json), ["folder", "path", "entry", "url"]);
  assert.equal(json.folder, "Accounts/Acme");
  assert.equal(json.path, "Accounts/Acme/README.md");
  assert.equal(json.entry, renderEntry(note()));
  assert.equal(json.url, "https://github.com/demo/notes/commit/1");
});

test("the CLI's --dry-run writes nothing and prints the entry with no url", async () => {
  const notes = fakeNotes();
  const { deps, written } = setup(notes, JSON.stringify(FULL));
  assert.equal(await runNoteCli(["note", "--dry-run"], deps), 0);

  const json = JSON.parse(written.join("")) as { entry: string; url: unknown };
  assert.equal(json.entry, renderEntry(note()));
  assert.equal(json.url, null);
  assert.deepEqual(notes.writes, []);
  assert.deepEqual(notes.reads, []);
});

test("a note that is not the JSON a note has throws before the repo is touched", async () => {
  const bad: Array<[string, RegExp]> = [
    ["not json at all", /note: stdin is not JSON/],
    ["[]", /not a JSON object/],
    [JSON.stringify({ ...FULL, date: "25 Nov" }), /date must be a date like 2026-11-25/],
    [JSON.stringify({ ...FULL, folder: null, newFolderName: null }), /either folder or newFolderName/],
  ];
  for (const [json, expected] of bad) {
    const notes = fakeNotes();
    const { deps, written } = setup(notes, json);
    await assert.rejects(runNoteCli(["note"], deps), expected);
    assert.deepEqual(written, []);
    assert.deepEqual(notes.reads, []);
    assert.deepEqual(notes.writes, []);
  }
});

test("a command line that is not a note's is a usage error: 2, usage on stderr, nothing on stdout", async (t) => {
  // The runner's own mock: restored when this test ends, so no other test sees it.
  const stderr = t.mock.method(process.stderr, "write", () => true);

  const bad = [
    ["note", "--date", "2026-11-25"],
    ["note", "--format", "json"],
    ["note", "--ref", "demo#52"],
    ["note", "extra"],
    ["nope", "--dry-run"],
  ];
  for (const argv of bad) {
    const notes = fakeNotes();
    const { deps, written } = setup(notes, JSON.stringify(FULL));
    assert.equal(await runNoteCli(argv, deps), 2, `${argv.join(" ")} must exit 2`);
    assert.deepEqual(written, [], `${argv.join(" ")} must print nothing`);
    assert.deepEqual(notes.writes, [], `${argv.join(" ")} must write nothing`);
  }

  const err = stderr.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.match(err, /zya note \[--dry-run\]/);
});

/** The entry `bin/zya` execs: the same file, so the dispatch is what this test runs. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * The entry as a process, with a fetch of our own and the note piped in. The
 * preload is a data: URL, so nothing is written to disk, and the machine's own
 * credentials and env file are out of reach (HOME points nowhere, the token is a
 * synthetic one). `env` overrides the settings a run is given.
 */
function zya(hook: string, env: Record<string, string>, args: string[], input: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, CLI, ...args], {
    encoding: "utf8",
    input,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      HOME: join(tmpdir(), "zya-test-no-home"),
      GITHUB_TOKEN: "test-token",
      NOTES_REPO: "demo/notes",
      ASSISTANT_TZ: "Asia/Singapore",
      ...env,
    },
  });
  assert.equal(run.error, undefined);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("the real entry writes no board: a listed partner dry-runs even with an invalid board number", () => {
  // The notes repo is demo/notes, listed by its complete URLs: any other repo, and
  // any URL this run has no business asking for, throws. Partners/Globex is the
  // only folder; Accounts and Events are 404, and a write throws, so a dry run that
  // wrote anything at all would exit 1.
  const hook = `
    const listing = {
      "https://api.github.com/repos/demo/notes/contents/Partners": JSON.stringify([{ name: "Globex", type: "dir" }]),
      "https://api.github.com/repos/demo/notes/contents/Accounts": null,
      "https://api.github.com/repos/demo/notes/contents/Events": null,
    };
    globalThis.fetch = async (url, init) => {
      if (String(init?.method ?? "GET") !== "GET") throw new Error("a dry run wrote to the notes repo");
      const key = String(url);
      if (!Object.prototype.hasOwnProperty.call(listing, key)) throw new Error("unexpected URL " + key);
      const body = listing[key];
      return body === null ? new Response("Not Found", { status: 404 }) : new Response(body, { status: 200 });
    };
  `;
  const partner = { ...FULL, folder: "Partners/Globex" };

  const { status, stdout, stderr } = zya(hook, { PROJECT_NUMBER: "invalid" }, ["note", "--dry-run"], JSON.stringify(partner));

  assert.equal(stderr, "");
  assert.equal(status, 0);
  const json = JSON.parse(stdout) as { folder: string; path: string; entry: string; url: unknown };
  assert.deepEqual(Object.keys(json), ["folder", "path", "entry", "url"]);
  assert.equal(json.folder, "Partners/Globex", "the folder came from the repo's own listing");
  assert.equal(json.path, "Partners/Globex/README.md");
  assert.equal(json.entry, renderEntry(validateNote(partner)));
  assert.equal(json.url, null);
});
