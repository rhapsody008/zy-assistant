// The scribe's pure parts, pinned exactly: the note's shape, the entry format v0,
// where the entry goes in a README, a folder's first README, and the prompt the
// model is given. Synthetic names only: "Acme", "Globex", "Initech".

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  insertEntry,
  newReadme,
  NOTE_TYPES,
  rawEntry,
  renderEntry,
  safeFolder,
  safeNewFolder,
  scribeSystemPrompt,
  scribeUserPrompt,
  validateNote,
  type Note,
} from "../src/scribe.ts";

const FULL = {
  folder: "Accounts/Acme",
  newFolderName: null,
  date: "2026-11-25",
  type: "Workshop",
  topic: "Acme VPC sizing",
  attendees: ["ZY", "Ana"],
  summary: "We sized the VPC. Ten nodes is enough.",
  decisions: ["Ten nodes", "Pilot in January"],
  actions: [
    { owner: "ZY", text: "send the sizing sheet", due: "2026-11-28" },
    { owner: "Globex", text: "confirm the date", due: null },
  ],
};

const QUITE = {
  folder: "Accounts/Acme",
  newFolderName: null,
  date: "2026-11-25",
  type: "Admin",
  topic: "Timesheet",
  attendees: [],
  summary: "Filed it.",
  decisions: [],
  actions: [],
};

const note = (overrides: Partial<Note> = {}): Note => ({ ...validateNote(FULL), ...overrides });

test("a full note passes the validator, and so does a folder to create", () => {
  assert.deepEqual(validateNote(FULL), FULL);
  assert.deepEqual(validateNote({ ...FULL, folder: null, newFolderName: "Initech" }), { ...FULL, folder: null, newFolderName: "Initech" });
  assert.deepEqual(validateNote({ ...QUITE, folder: null, newFolderName: "Initech" }).attendees, []);
});

test("every field the entry renders is checked, and the throw names it", () => {
  const bad: Array<[unknown, RegExp]> = [
    ["not an object", /not a JSON object/],
    [{ ...FULL, folder: null, newFolderName: null }, /either folder or newFolderName/],
    [{ ...FULL, newFolderName: "Accounts/Initech" }, /one folder name, not a path/],
    [{ ...FULL, date: "25 Nov" }, /date must be a date like 2026-11-25/],
    [{ ...FULL, type: "Meeting notes" }, /type must be one of POC, Workshop/],
    [{ ...FULL, topic: "   " }, /topic must be a non-empty string/],
    [{ ...FULL, attendees: "ZY" }, /attendees must be an array of strings/],
    [{ ...FULL, summary: "" }, /summary must be a non-empty string/],
    [{ ...FULL, decisions: [1] }, /decisions\[0\] must be a non-empty string/],
    [{ ...FULL, actions: {} }, /actions must be an array/],
    [{ ...FULL, actions: [{ owner: "ZY", text: "x", due: "soon" }] }, /actions\[0\]\.due must be a date/],
    [{ ...FULL, actions: [{ owner: "", text: "x", due: null }] }, /actions\[0\]\.owner must be a non-empty string/],
  ];
  for (const [value, expected] of bad) assert.throws(() => validateNote(value), expected);
});

test("a new folder name is one line of letters, digits, spaces, _ and -, nothing else", () => {
  assert.equal(safeNewFolder("Initech"), "Accounts/Initech");
  assert.equal(safeNewFolder("Acme Ltd-2_x"), "Accounts/Acme Ltd-2_x");
  assert.equal(safeNewFolder("A".repeat(64)), `Accounts/${"A".repeat(64)}`, "64 characters is the longest name");

  for (const name of [
    "../../x",
    "Accounts/../README",
    ".github",
    "Acme\\Ltd",
    "Acme\nLtd",
    "A".repeat(65),
    "",
    " Acme",
    "Acme/",
  ]) {
    assert.equal(safeNewFolder(name), null, `${JSON.stringify(name)} is not a folder name`);
  }
});

test("an existing folder is exactly one the repo listed, and nothing else", () => {
  const listed = ["Accounts/Acme", "Partners/Globex"];
  assert.equal(safeFolder("Accounts/Acme", listed), "Accounts/Acme");
  for (const folder of [
    "../../x",
    "Accounts/../README",
    ".github",
    "Accounts\\Acme",
    "Accounts/Acme\n",
    "accounts/Acme",
    "Accounts/",
    "",
  ]) {
    assert.equal(safeFolder(folder, listed), null, `${JSON.stringify(folder)} is not in the list`);
  }
});

test("topic, attendees, decisions, actions and summary are sanitised to one short line each", () => {
  const sanitised = validateNote({
    ...FULL,
    topic: `  Acme VPC\n sizing\tand  more ${"x".repeat(100)}  `,
    attendees: ["ZY\nAna", `B${"o".repeat(400)}`],
    summary: `line one\n\nline two ${"y".repeat(1600)}`,
    decisions: ["ten\n nodes"],
    actions: [{ owner: "ZY\n", text: `send\n the sheet ${"z".repeat(400)}`, due: null }],
  });

  assert.equal(sanitised.topic.startsWith("Acme VPC sizing and more xxx"), true);
  assert.equal(sanitised.topic.includes("\n"), false, "the topic is one line");
  assert.equal(sanitised.topic.length, 80, "the topic is cut to 80 characters");
  assert.deepEqual(sanitised.attendees[0], "ZY Ana", "a newline becomes a space");
  assert.equal(sanitised.attendees[1].length, 300);
  assert.equal(sanitised.summary.startsWith("line one line two y"), true);
  assert.equal(sanitised.summary.length, 1500);
  assert.deepEqual(sanitised.decisions, ["ten nodes"]);
  assert.equal(sanitised.actions[0].owner, "ZY");
  assert.equal(sanitised.actions[0].text.length, 300);
  assert.equal(sanitised.actions[0].text.startsWith("send the sheet z"), true);
});

test("all nine note types are accepted", () => {
  assert.deepEqual([...NOTE_TYPES], ["POC", "Workshop", "Follow-up", "Demo-Slides", "Partner", "Experiment", "Learning", "Admin", "Meeting"]);
  for (const type of NOTE_TYPES) assert.equal(validateNote({ ...FULL, type }).type, type);
});

test("an entry is the heading, the notes, the actions and the attribution", () => {
  assert.equal(
    renderEntry(note()),
    [
      "## 2026-11-25 · Workshop · Acme VPC sizing",
      "",
      "**Attendees:** ZY, Ana",
      "**Summary:** We sized the VPC. Ten nodes is enough.",
      "**Decisions:**",
      "- Ten nodes",
      "- Pilot in January",
      "",
      "### Actions",
      "- [ ] ZY: send the sizing sheet (due 2026-11-28)",
      "- [ ] Globex: confirm the date",
      "",
      "_Scribed by zy-assistant from Slack._",
    ].join("\n"),
  );
});

test("with no attendees, decisions or actions the entry is just the summary", () => {
  assert.equal(
    renderEntry(note({ type: "Admin", topic: "Timesheet", attendees: [], summary: "Filed it.", decisions: [], actions: [] })),
    ["## 2026-11-25 · Admin · Timesheet", "", "**Summary:** Filed it.", "", "_Scribed by zy-assistant from Slack._"].join("\n"),
  );
});

test("a raw dictation is quoted, never parsed", () => {
  assert.equal(
    rawEntry("2026-11-25", "the workshop decided ten nodes\n\nsend the sheet by Friday"),
    [
      "## 2026-11-25 · Meeting · Raw dictation (unprocessed)",
      "",
      "> the workshop decided ten nodes",
      ">",
      "> send the sheet by Friday",
      "",
      "_Scribed by zy-assistant from Slack._",
    ].join("\n"),
  );
});

test("an entry goes in under the Log line, newest first, one blank line each side", () => {
  const readme = [
    "# Acme",
    "",
    "## Context",
    "",
    "- a bank",
    "",
    "## Log",
    "",
    "## 2026-11-20 · Meeting · Older",
    "",
    "**Summary:** Old.",
    "",
  ].join("\n");
  const entry = "## 2026-11-25 · Meeting · Newer\n\n**Summary:** New.";

  assert.equal(
    insertEntry(readme, entry),
    [
      "# Acme",
      "",
      "## Context",
      "",
      "- a bank",
      "",
      "## Log",
      "",
      "## 2026-11-25 · Meeting · Newer",
      "",
      "**Summary:** New.",
      "",
      "## 2026-11-20 · Meeting · Older",
      "",
      "**Summary:** Old.",
      "",
    ].join("\n"),
  );
});

test("a README with no Log section gets one at the end", () => {
  const entry = "## 2026-11-25 · Meeting · Newer\n\n**Summary:** New.";
  assert.equal(
    insertEntry("# Acme\n\n## Context\n\n- a bank\n", entry),
    `# Acme\n\n## Context\n\n- a bank\n\n## Log\n\n${entry}\n`,
  );
  assert.equal(insertEntry("", entry), `## Log\n\n${entry}\n`);
  assert.equal(insertEntry("# Acme\n\n## Log", entry), `# Acme\n\n## Log\n\n${entry}\n`, "a Log line with nothing under it");
});

test("the same entry is never inserted twice", () => {
  const entry = "## 2026-11-25 · Meeting · Newer\n\n**Summary:** New.";
  const once = insertEntry("# Acme\n\n## Log\n\n", entry);
  assert.equal(insertEntry(once, entry), once);
  assert.equal(insertEntry(once, entry).split(entry).length - 1, 1);
});

test("a folder's first README is the format v0 table, a Context, and the entry under Log", () => {
  const entry = "## 2026-11-25 · Meeting · Newer\n\n**Summary:** New.";
  assert.equal(
    newReadme("Accounts/Acme", entry),
    [
      "# Acme",
      "",
      "| | |",
      "|---|---|",
      "| Track | Customer |",
      "| Type | - |",
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
    ].join("\n"),
  );
  assert.equal(newReadme("Accounts/Acme", entry), newReadme("Accounts/Acme", entry), "pure");
  assert.equal(insertEntry(newReadme("Accounts/Acme", entry), entry), newReadme("Accounts/Acme", entry), "and already holds it");
});

test("a partner folder is a Partner, an event folder is neither", () => {
  const entry = "x";
  assert.match(newReadme("Partners/Globex", entry), /\| Type \| Partner \|/);
  assert.match(newReadme("Partners/Globex", entry), /\| Track \| - \|/);
  assert.match(newReadme("Events/Summit-2027", entry), /\| Track \| - \|[\s\S]*\| Type \| - \|/);
  assert.match(newReadme("Events/Summit-2027", entry), /^# Summit-2027$/m, "the heading is the folder's name");
});

test("the system prompt carries the rules, today's date and every folder", () => {
  const prompt = scribeSystemPrompt("2026-11-25", ["Accounts/Acme", "Partners/Globex", "Events/Summit-2027"]);

  assert.match(prompt, /Reply with ONE JSON object/);
  assert.match(prompt, /Today is 2026-11-25 \(Asia\/Singapore\)/);
  for (const folder of ["Accounts/Acme", "Partners/Globex", "Events/Summit-2027"]) assert.match(prompt, new RegExp(`^- ${folder}$`, "m"));
  assert.match(prompt, /pick it ONLY from the list/);
  assert.match(prompt, /never invent facts, names, numbers or dates/i);
  assert.match(prompt, /Relative dates .* resolve against today/);
  assert.match(prompt, /"This Friday" is the next Friday on or after today \(today itself when today is a Friday\)/);
  assert.match(prompt, /"next Friday" is the Friday of the following week, 7 days after "this Friday"/);
  assert.match(prompt, /The same holds for every other weekday/);
  assert.match(prompt, /"I", "me" and "mine" mean ZY/);
  assert.match(scribeSystemPrompt("2026-11-25", []), /\(none yet\)/);
});

test("the user prompt is the dictation, and the ping's item when there is one", () => {
  assert.equal(scribeUserPrompt("  ten nodes is enough  ", null), "Dictation from Slack:\n\nten nodes is enough");
  assert.equal(
    scribeUserPrompt("ten nodes is enough", "Acme VPC sizing"),
    'Dictation from Slack:\n\nten nodes is enough\n\nIt is about the board item "Acme VPC sizing".',
  );
});
