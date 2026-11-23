// The scribe's pipeline end to end, with a fake model, a fake notes repo and a
// fake store: no network, no Slack, no GitHub, no timers. Synthetic names only:
// "Acme", "Globex", "Initech", "demo/notes".

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  doneMessage,
  parseScribeChoice,
  scribeChoice,
  scribeHandler,
  writeEntry,
  writeFolder,
  type ScribeAsk,
  type ScribeDeps,
  type ScribeUi,
} from "../src/scribe-handler.ts";
import { FakeDictations, FakeLlm, FakeNotes } from "./fakes.ts";

/** Wed 2026-11-25, 09:00 in Singapore. */
const NOW = new Date("2026-11-25T01:00:00Z");
const TS = "1700000000.000100";
const DICTATION = "the Acme workshop settled on ten nodes\nthe pilot starts in January";

const NOTE = {
  folder: "Accounts/Acme",
  newFolderName: null,
  date: "2026-11-25",
  type: "Workshop",
  topic: "Acme VPC sizing",
  attendees: ["ZY", "Ana"],
  summary: "Ten nodes is enough for the pilot.",
  decisions: ["Ten nodes"],
  actions: [{ owner: "ZY", text: "send the sizing sheet", due: "2026-11-28" }],
};

const json = (value: unknown): string => JSON.stringify(value);

class FakeUi implements ScribeUi {
  readonly replies: string[] = [];
  readonly edits: Array<{ ts: string; text: string }> = [];
  readonly asks: ScribeAsk[] = [];

  async reply(text: string): Promise<string> {
    this.replies.push(text);
    return `reply-${this.replies.length}`;
  }

  async edit(ts: string, text: string): Promise<void> {
    this.edits.push({ ts, text });
  }

  async ask(ask: ScribeAsk): Promise<void> {
    this.asks.push(ask);
  }
}

function harness(...replies: string[]) {
  const llm = new FakeLlm();
  llm.replies.push(...replies);
  const notes = new FakeNotes();
  notes.folders.push("Accounts/Acme", "Partners/Globex");
  const dictations = new FakeDictations();
  const logs: string[] = [];
  const deps: ScribeDeps = {
    llm,
    notes,
    dictations,
    now: () => NOW,
    log: (line) => logs.push(line),
    timeoutMs: 1000,
    maxTokens: 8192,
  };
  return { deps, llm, notes, dictations, logs, ui: new FakeUi() };
}

const README = "# Acme\n\n## Log\n\n## 2026-11-20 · Meeting · Older\n\n**Summary:** Old.\n";

test("a note in a known folder is written under the Log line and answered with the link", async () => {
  const { deps, llm, notes, dictations, ui } = harness(`<think>Acme, ten nodes.</think>\n\`\`\`json\n${json(NOTE)}\n\`\`\``);

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.deepEqual(ui.replies, ["📝 writing…"], "one ack, in the thread");
  assert.deepEqual(ui.asks, [], "no question: the folder is known");
  assert.equal(ui.edits.length, 1);
  assert.equal(ui.edits[0].ts, "reply-1", "the ack is what gets edited");
  assert.equal(
    ui.edits[0].text,
    "✅ Accounts/Acme: Acme VPC sizing → https://github.com/demo/notes/commit/1\nboard proposals: coming in step 2\n• ZY: send the sizing sheet (due 2026-11-28)",
  );

  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].path, "Accounts/Acme/README.md");
  assert.equal(notes.writes[0].sha, null, "a folder with no README yet");
  assert.equal(notes.writes[0].message, "notes(Accounts/Acme): 2026-11-25 Acme VPC sizing [scribe]");
  assert.match(notes.writes[0].text, /^# Acme\n\n\| \| \|\n\|---\|---\|\n\| Track \| Customer \|/);
  assert.match(notes.writes[0].text, /## Log\n\n## 2026-11-25 · Workshop · Acme VPC sizing/);

  const row = dictations.rows.get(TS);
  assert.equal(row?.status, "done");
  assert.equal(row?.folder, "Accounts/Acme");
  assert.equal(row?.commitUrl, "https://github.com/demo/notes/commit/1");
  assert.equal(row?.text, DICTATION, "the raw words stay, as dictated");
  assert.deepEqual(JSON.parse(row?.noteJson ?? "{}").actions, NOTE.actions, "the actions are stored for step 2");

  assert.equal(llm.requests.length, 1);
  assert.match(llm.requests[0].system, /^- Accounts\/Acme$/m);
  assert.match(llm.requests[0].user, /^Dictation from Slack:\n\nthe Acme workshop settled on ten nodes/);
});

test("an existing README is read and written back with its sha, newest entry first", async () => {
  const { deps, notes, ui } = harness(json(NOTE));
  notes.files.set("Accounts/Acme/README.md", { text: README, sha: "sha-1" });

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].sha, "sha-1");
  assert.match(notes.writes[0].text, /## 2026-11-25 · Workshop · Acme VPC sizing[\s\S]*## 2026-11-20 · Meeting · Older/, "the new entry is above the old one");
});

test("a folder the model cannot place becomes a question, and the answer does not call the model again", async () => {
  const { deps, llm, notes, dictations, ui } = harness(json({ ...NOTE, folder: null, newFolderName: "Initech" }));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(ui.asks.length, 1);
  assert.deepEqual(ui.asks[0], {
    ts: TS,
    text: "New folder `Accounts/Initech`?",
    folders: ["Accounts/Acme", "Partners/Globex"],
    create: "Initech",
    retry: false,
  });
  assert.equal(ui.edits.at(-1)?.text, "📁 needs a folder");
  assert.equal(notes.writes.length, 0, "nothing is written before ZY answers");
  assert.equal(dictations.rows.get(TS)?.status, "asked");
  assert.equal(dictations.rows.get(TS)?.folder, null);

  // ZY picks an existing folder instead of the new one.
  await scribeChoice(deps, { ts: TS, action: "folder", value: "Partners/Globex" }, ui);

  assert.equal(llm.requests.length, 1, "the extracted note is reused, the model is not asked twice");
  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].path, "Partners/Globex/README.md");
  assert.match(ui.replies.at(-1) ?? "", /^✅ Partners\/Globex: Acme VPC sizing → https:\/\/github\.com\/demo\/notes\/commit\/1/);
  assert.equal(dictations.rows.get(TS)?.status, "done");
  assert.equal(dictations.rows.get(TS)?.folder, "Partners/Globex");
});

test("Create makes the recommended folder under Accounts, named by the stored note", async () => {
  const { deps, notes, ui } = harness(json({ ...NOTE, folder: null, newFolderName: "Initech" }));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);
  // The button carries the dictation and nothing else: the name is the note's.
  const choice = parseScribeChoice("zy_scribe_create", TS, null, null);
  assert.ok(choice !== null);
  await scribeChoice(deps, choice, ui);

  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].path, "Accounts/Initech/README.md");
  assert.equal(notes.writes[0].message, "notes(Accounts/Initech): 2026-11-25 Acme VPC sizing [scribe]");
  assert.match(ui.replies.at(-1) ?? "", /^✅ Accounts\/Initech: Acme VPC sizing → /);
});

test("a model that fails twice is reported, and the raw dictation lands once ZY says where", async () => {
  // Two unusable replies: the attempt and its one retry, then the pipeline gives up.
  const { deps, llm, notes, dictations, ui } = harness("I cannot make a note of that.", "Still no JSON.");

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(llm.requests.length, 2, "one attempt and one retry");
  assert.equal(ui.edits.at(-1)?.text, "⚠️ the note model failed: the reply holds no JSON object");
  assert.equal(ui.asks.length, 1);
  assert.equal(ui.asks[0].create, null, "there is no name to offer: the words are already there");
  assert.match(ui.asks[0].text, /Where should the raw dictation go\?/);
  assert.deepEqual(ui.asks[0].folders, ["Accounts/Acme", "Partners/Globex"]);
  assert.equal(notes.writes.length, 0, "nothing is written without a folder");
  assert.equal(dictations.rows.get(TS)?.status, "failed");
  assert.equal(dictations.rows.get(TS)?.text, DICTATION, "the words are stored, as dictated");
  assert.match(dictations.rows.get(TS)?.error ?? "", /no JSON object/);

  await scribeChoice(deps, { ts: TS, action: "folder", value: "Accounts/Acme" }, ui);

  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].message, "notes(Accounts/Acme): 2026-11-25 Raw dictation (unprocessed) [scribe]");
  assert.match(notes.writes[0].text, /## 2026-11-25 · Meeting · Raw dictation \(unprocessed\)/);
  assert.match(notes.writes[0].text, /> the Acme workshop settled on ten nodes\n> the pilot starts in January/);
  assert.match(ui.replies.at(-1) ?? "", /^✅ Accounts\/Acme: Raw dictation \(unprocessed\) → /);
  assert.equal(dictations.rows.get(TS)?.status, "done");
  assert.equal(llm.requests.length, 2, "answering the question asks the model nothing");
});

test("a redelivered message is stored once and scribed once", async () => {
  const { deps, llm, notes, logs, ui } = harness(json(NOTE), json(NOTE));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);
  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(llm.requests.length, 1);
  assert.equal(notes.writes.length, 1);
  assert.deepEqual(ui.replies, ["📝 writing…"], "the second delivery says nothing at all");
  assert.match(logs.join("\n"), /already stored, ignoring the redelivery/);
});

test("a README that changed under us is read again and written with the new sha", async () => {
  const { deps, notes, dictations, logs, ui } = harness(json(NOTE));
  notes.conflicts = 1;

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.deepEqual(notes.reads, ["Accounts/Acme/README.md", "Accounts/Acme/README.md"], "read, lost the race, read again");
  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].sha, "sha-1", "the sha the second read saw");
  assert.match(logs.join("\n"), /changed under us \(attempt 1 of 3\), reading it again/);
  assert.equal(dictations.rows.get(TS)?.status, "done");
});

test("three lost races give up, say so, and keep the dictation", async () => {
  const { deps, notes, dictations, ui } = harness(json(NOTE));
  notes.conflicts = 3;

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(notes.writes.length, 0);
  assert.match(ui.edits.at(-1)?.text ?? "", /^⚠️ could not write Accounts\/Acme: .*kept changing under us, gave up after 3 attempts/);
  assert.equal(dictations.rows.get(TS)?.status, "failed");
  assert.match(dictations.rows.get(TS)?.error ?? "", /gave up after 3 attempts/);
  assert.equal(dictations.rows.get(TS)?.text, DICTATION, "the words are still there");
  assert.equal(ui.asks.at(-1)?.retry, true, "a retry button is posted, so there is something to click");
  assert.equal(ui.asks.at(-1)?.text, "Try writing it again?");

  // The retry carries the dictation, and writes the folder that failed.
  const retry = parseScribeChoice("zy_scribe_retry", TS, null, null);
  assert.ok(retry !== null);
  await scribeChoice(deps, retry, ui);
  assert.equal(notes.writes.length, 1, "the same dictation, the same folder, one commit");
  assert.equal(notes.writes[0].path, "Accounts/Acme/README.md");
  assert.equal(dictations.rows.get(TS)?.status, "done");
});

test("Cancel writes nothing and keeps the words", async () => {
  const { deps, notes, dictations, ui } = harness(json({ ...NOTE, folder: null, newFolderName: "Initech" }));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);
  await scribeChoice(deps, { ts: TS, action: "cancel", value: null }, ui);

  assert.equal(notes.writes.length, 0);
  assert.equal(ui.replies.at(-1), "Cancelled. The dictation stays stored.");
  assert.equal(dictations.rows.get(TS)?.status, "cancelled");
});

test("a second click on a written note changes nothing and says so", async () => {
  const { deps, notes, ui } = harness(json(NOTE));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);
  await scribeChoice(deps, { ts: TS, action: "folder", value: "Accounts/Acme" }, ui);

  assert.equal(notes.writes.length, 1, "no second commit");
  assert.equal(ui.replies.at(-1), "already written: https://github.com/demo/notes/commit/1");
});

test("a choice for a dictation the bot never stored is logged, not thrown", async () => {
  const { deps, notes, logs, ui } = harness();

  await scribeChoice(deps, { ts: "999.9", action: "folder", value: "Accounts/Acme" }, ui);

  assert.equal(notes.writes.length, 0);
  assert.deepEqual(ui.replies, []);
  assert.match(logs.join("\n"), /scribe 999\.9: no such dictation/);
});

test("the ping's item rides in the user prompt as context", async () => {
  const { deps, llm, ui } = harness(json(NOTE));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: "Acme VPC sizing" }, ui);

  assert.match(llm.requests[0].user, /It is about the board item "Acme VPC sizing"\./);
});

test("a click is read back as the dictation and the folder it means", () => {
  assert.deepEqual(parseScribeChoice("zy_scribe_create", "1700.1", null, null), { ts: "1700.1", action: "create", value: null });
  assert.deepEqual(parseScribeChoice("zy_scribe_cancel", "1700.1", null, null), { ts: "1700.1", action: "cancel", value: null });
  assert.deepEqual(parseScribeChoice("zy_scribe_retry", "1700.1", null, null), { ts: "1700.1", action: "retry", value: null });
  assert.deepEqual(parseScribeChoice("zy_scribe_folder", null, "Accounts/Acme", "zy_scribe_1700.1"), {
    ts: "1700.1",
    action: "folder",
    value: "Accounts/Acme",
  });
  assert.equal(parseScribeChoice("zy_ack", "1700.1", null, null), null, "a ping button is not a choice");
  assert.equal(parseScribeChoice("zy_scribe_create", null, null, null), null, "no dictation, no choice");
  assert.equal(parseScribeChoice("zy_scribe_folder", null, "Accounts/Acme", null), null, "no block_id, no dictation");
  assert.equal(parseScribeChoice("zy_scribe_folder", null, "", "zy_scribe_1700.1"), null, "no folder, no choice");
});

test("the reply names the actions only when there are some", () => {
  assert.equal(doneMessage("Accounts/Acme", "Timesheet", "u", []), "✅ Accounts/Acme: Timesheet → u");
});

test("a folder the model invents is a question, never a write", async () => {
  for (const folder of ["../../x", "Accounts/../README", ".github/workflows"]) {
    const { deps, notes, dictations, ui } = harness(json({ ...NOTE, folder, newFolderName: null }));

    await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

    assert.equal(notes.writes.length, 0, `${folder} is not written`);
    assert.equal(ui.asks.length, 1);
    assert.equal(ui.asks[0].text, "Where should this note go?");
    assert.equal(ui.asks[0].create, null, "there is no safe name to offer creating");
    assert.equal(dictations.rows.get(TS)?.status, "asked");
  }
});

test("an unsafe new folder name is a question without a Create button", async () => {
  // Names the note validator lets through but a folder may not have: a dotfile,
  // a backslash, a name a byte too long. None of them becomes a button.
  for (const name of [".github", "Acme\\Ltd", "A".repeat(65)]) {
    const { deps, notes, ui } = harness(json({ ...NOTE, folder: null, newFolderName: name }));

    await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

    assert.equal(ui.asks.length, 1, `${name} still ends in a question`);
    assert.equal(ui.asks[0].create, null, `${name} gets no Create button`);
    assert.equal(ui.asks[0].text, "Where should this note go?");
    assert.deepEqual(ui.asks[0].folders, ["Accounts/Acme", "Partners/Globex"], "the existing folders are still offered");
    assert.equal(notes.writes.length, 0);
  }
});

test("the write itself refuses any folder the notes repo does not offer", async () => {
  const { deps, notes } = harness();

  assert.equal(writeFolder("Accounts/Acme", ["Accounts/Acme"]), "Accounts/Acme", "an existing folder");
  assert.equal(writeFolder("Accounts/Initech", []), "Accounts/Initech", "a new one under Accounts");
  for (const folder of ["../../x", "Accounts/../README", ".github", "Acme\\Ltd", "Accounts/Acme\n", ""]) {
    assert.equal(writeFolder(folder, ["Accounts/Acme"]), null, `${JSON.stringify(folder)} may not be written`);
    await assert.rejects(writeEntry(deps, { folder, entry: "x", date: "2026-11-25", topic: "t" }), /is not a folder of the notes repo/);
  }
  assert.equal(notes.writes.length, 0);
  assert.equal(
    await writeEntry(deps, { folder: "Accounts/Initech", entry: "x", date: "2026-11-25", topic: "Acme\nVPC  sizing" }),
    "https://github.com/demo/notes/commit/1",
  );
  assert.equal(notes.writes[0].path, "Accounts/Initech/README.md");
  assert.equal(notes.writes[0].message, "notes(Accounts/Initech): 2026-11-25 Acme VPC sizing [scribe]", "one line, whatever the topic was");
});

test("the commit message carries the sanitised topic and nothing else", async () => {
  const { deps, notes, ui } = harness(json({ ...NOTE, topic: "Acme  VPC\nsizing" }));

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(notes.writes[0].message, "notes(Accounts/Acme): 2026-11-25 Acme VPC sizing [scribe]");
});

test("a double click on the folder question commits once", async () => {
  const { deps, notes, dictations, ui } = harness(json({ ...NOTE, folder: null, newFolderName: "Initech" }));
  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  const click = { ts: TS, action: "folder", value: "Partners/Globex" } as const;
  await Promise.all([scribeChoice(deps, click, ui), scribeChoice(deps, click, ui)]);

  assert.equal(notes.commits, 1, "one click reached the write");
  assert.equal(notes.writes.length, 1);
  assert.equal(ui.replies.filter((reply) => reply === "already handled").length, 1, "the other click is told so");
  assert.equal(dictations.rows.get(TS)?.status, "done");
});

test("Create racing a select commits once", async () => {
  const { deps, notes, dictations, ui } = harness(json({ ...NOTE, folder: null, newFolderName: "Initech" }));
  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  const create = parseScribeChoice("zy_scribe_create", TS, null, null);
  assert.ok(create !== null);
  await Promise.all([
    scribeChoice(deps, create, ui),
    scribeChoice(deps, { ts: TS, action: "folder", value: "Partners/Globex" }, ui),
  ]);

  assert.equal(notes.commits, 1);
  assert.equal(notes.writes.length, 1);
  assert.equal(notes.writes[0].path, "Accounts/Initech/README.md", "the click that got there first is the one that counts");
  assert.equal(ui.replies.filter((reply) => reply === "already handled").length, 1);
  assert.equal(dictations.rows.get(TS)?.status, "done");
});

test("a notes repo that cannot be read fails the write and asks for a retry", async () => {
  const { deps, notes, dictations, ui } = harness(json(NOTE));
  notes.failReads = new Error("network down");

  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);

  assert.equal(notes.writes.length, 0, "nothing is written blind");
  assert.equal(dictations.rows.get(TS)?.status, "failed");
  assert.match(dictations.rows.get(TS)?.error ?? "", /network down/);
  assert.equal(ui.asks.at(-1)?.retry, true);
  assert.match(ui.edits.at(-1)?.text ?? "", /^⚠️ could not write Accounts\/Acme: network down/);

  // The repo is back: the same retry commits the words that were kept.
  notes.failReads = null;
  const retry = parseScribeChoice("zy_scribe_retry", TS, null, null);
  assert.ok(retry !== null);
  await scribeChoice(deps, retry, ui);
  assert.equal(notes.writes.length, 1);
  assert.equal(dictations.rows.get(TS)?.status, "done");
});

test("the model's reply budget is the configured one", async () => {
  const { deps, llm, ui } = harness(json(NOTE));
  await scribeHandler(deps, { ts: TS, text: DICTATION, hint: null }, ui);
  assert.equal(llm.requests[0].maxTokens, 8192);
});
