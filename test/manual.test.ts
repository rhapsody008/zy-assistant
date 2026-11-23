// The user manual, pinned: the overview and the page behind every topic say what
// the bot does, quote the live policy rather than a copy of it, and fit in the
// Block Kit limits Slack enforces. Synthetic names only: "Acme", "Globex".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { helpReply, manualTopics, overviewBlocks, overviewText, type ManualSettings } from "../src/manual.ts";
import { DEFAULT_POLICY, type Policy } from "../src/rules.ts";

/** What the bot runs with when nothing overrides it. */
const DEFAULTS: ManualSettings = {
  briefTime: "09:00",
  eodTime: "17:30",
  notesRepo: "demo/notes",
  policy: DEFAULT_POLICY,
};

/** The same, with the scribe off and no notes repo: the smallest deployment. */
const BARE: ManualSettings = { ...DEFAULTS, notesRepo: null };

/** Slack rejects a section over 3000 characters, and a message over 50 blocks. */
const MAX_SECTION_TEXT = 3000;
const MAX_BLOCKS = 50;

function fits(blocks: Array<{ text: { text: string } }>): void {
  assert.ok(blocks.length <= MAX_BLOCKS, `${blocks.length} blocks is over Slack's ${MAX_BLOCKS}`);
  for (const block of blocks) {
    assert.ok(block.text.text.length <= MAX_SECTION_TEXT, `a section of ${block.text.text.length} characters`);
  }
}

const topics = (settings: ManualSettings = DEFAULTS) => manualTopics(settings, true);

test("the overview has one section per topic and ends with how to go deeper", () => {
  const blocks = overviewBlocks(DEFAULTS, true);
  const withScribe = topics().map((topic) => topic.topic);

  assert.deepEqual(withScribe, ["briefing", "pings", "buttons", "note", "updates"]);
  assert.equal(blocks.length, withScribe.length + 1, "one section each, then the hint");
  for (const [index, topic] of topics().entries()) {
    assert.match(blocks[index].text.text, new RegExp(`^\\*${topic.title}\\*\\n• `), `${topic.topic} starts with its header`);
    const lines = blocks[index].text.text.split("\n").length - 1;
    assert.ok(lines >= 2 && lines <= 4, `${topic.topic} has ${lines} lines`);
  }
  assert.equal(
    blocks.at(-1)?.text.text,
    "Reply `help <topic>` for details: `briefing`, `pings`, `buttons`, `note`, `updates`.",
  );
});

test("every overview section and every page fits the Block Kit limits", () => {
  fits(overviewBlocks(DEFAULTS, true));
  fits(overviewBlocks(BARE, false));
  for (const topic of topics()) {
    const reply = helpReply(DEFAULTS, true, topic.topic);
    fits(reply.blocks);
    assert.ok(reply.blocks.length >= 2, `${topic.topic} is a page, not a header`);
  }
  for (const asked of ["horoscope", "BRIEFING "]) fits(helpReply(DEFAULTS, true, asked).blocks);
});

test("the note topic is only there when the scribe is on", () => {
  assert.deepEqual(topics().map((topic) => topic.topic), ["briefing", "pings", "buttons", "note", "updates"]);
  assert.deepEqual(manualTopics(DEFAULTS, false).map((topic) => topic.topic), ["briefing", "pings", "buttons", "updates"]);

  const bare = overviewText(BARE, false);
  assert.doesNotMatch(bare, /note/i, "the scribe is off: nothing of notes is promised");
  assert.match(overviewText(DEFAULTS, true), /\*Notes\*/);
});

test("the notes-commit ack is only mentioned when NOTES_REPO is set", () => {
  const withRepo = helpReply(DEFAULTS, true, "updates").text;
  const without = helpReply(BARE, true, "updates").text;

  assert.match(withRepo, /a commit to the notes repo under `Accounts\/<the item's Account>\/`/);
  assert.match(overviewText(DEFAULTS, true), /A commit under `Accounts\/<Account>\/` in the notes repo does the same\./);
  assert.doesNotMatch(without, /notes repo/);
  assert.doesNotMatch(without, /Accounts\//);
  assert.doesNotMatch(overviewText(BARE, true), /Accounts\//);

  const acks = without.split("\n").filter((line) => line.startsWith("• "));
  assert.equal(acks.length, 3, "a button, a reply, the board item");
});

test("the policy the bot runs with is what the manual quotes", () => {
  const policy: Policy = {
    ...DEFAULT_POLICY,
    pingDays: 2,
    soonDays: [5, 6],
    staleDays: 9,
    wipLimit: 7,
    waitingChaseDays: 11,
    stageStaleDays: 30,
    leadByType: { POC: { heads: 10, milestones: [10, 3] } },
  };
  const settings: ManualSettings = { ...DEFAULTS, briefTime: "08:15", eodTime: "18:45", policy };

  assert.match(overviewText(settings, true), /at `08:15`/);
  assert.match(overviewText(settings, true), /at `18:45`/);

  const pings = helpReply(settings, true, "pings").text;
  assert.match(pings, /Target date T-2 to T-0/);
  assert.match(overviewText(settings, true), /A Target date pings from T-2 down to T-0/);
  assert.match(pings, /9 days/);
  assert.match(pings, /POC at T-10 and T-3/);
  assert.match(pings, /11 days/);
  assert.match(pings, /at `18:45`/);
  assert.doesNotMatch(pings, /T-14|T-7\b|Workshop/, "nothing of the default policy survives");

  const briefing = helpReply(settings, true, "briefing").text;
  assert.match(briefing, /\*Coming up\*: Target dates 5–6 days away, 10 days out for a POC/);
  assert.match(briefing, /limit of 7/);
  assert.match(briefing, /30 days/);

  const page = overviewText(settings, true);
  assert.match(page, /at `08:15`/);
  assert.match(page, /7 days/);
});

test("an unknown topic is the overview with the miss on top", () => {
  const reply = helpReply(DEFAULTS, true, "horoscope");
  assert.equal(reply.blocks[0].text.text, "No topic `horoscope`. Here is the overview.");
  assert.deepEqual(reply.blocks.slice(1), overviewBlocks(DEFAULTS, true));

  const page = helpReply(DEFAULTS, true, "  Buttons ");
  assert.equal(page.blocks[0].text.text, "*Buttons*", "the topic is matched however it is typed");
  assert.match(page.text, /\[\]|Status/, "the page, not the overview");
});

test("help buttons says what each button does, not more and not less", () => {
  const page = helpReply(DEFAULTS, true, "buttons").text;

  assert.match(page, /\*👍 On it\*: nothing on the board changes/);
  assert.match(page, /marked handled and the buttons are replaced by "→ acked"/);
  assert.match(page, /\*✅ Done\*: sets the item's Status to `Done`/);
  assert.match(page, /\*Tomorrow\*: sets Next touch to tomorrow, rolled off the weekend/);
  assert.match(page, /\*\+7 days\*: sets Next touch to 7 days from today/);
  assert.match(page, /comments `Target date moved <old> → <new> by zy-assistant: <reason>` on the issue/);
  assert.match(page, /A draft has no issue, so that line goes in the ping's thread instead/);
  assert.match(page, /a reason that cannot be left empty/);
  assert.match(page, /A ping about a touch or a chase has no \*Move date\*/);
  assert.match(page, /A plain reply in a ping's thread acks it, and answers "Noted\."/);
});

test("the note page says what a dictation becomes, and what it does not do yet", () => {
  const page = helpReply(DEFAULTS, true, "note").text;

  assert.match(page, /`## <date> · <type> · <topic>`/);
  assert.match(page, /`### Actions`/);
  assert.match(page, /suggests `Accounts\/<name>`, and I ask: \*Create\*/);
  assert.match(page, /the raw words are committed verbatim/);
  assert.match(page, /nothing goes to the board\. Board proposals come in step 2/);
  assert.match(page, /"this Friday" is the coming Friday/);
  assert.match(page, /"next Friday" is the Friday of the following week, 7 days after/);
});

test("the README quotes the overview the bot sends", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("## Using the bot"), "the README has the section");
  assert.ok(readme.includes(overviewText(DEFAULTS, true)), "and its text is the manual's own text, not a copy that drifted");
});
