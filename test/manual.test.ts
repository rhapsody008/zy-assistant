// The user manual, pinned: the overview separates what ZY types from what the bot
// sends, every page says what the bot does, the text quotes the live policy rather
// than a copy of it, and it fits in the Block Kit limits Slack enforces. Synthetic
// names only: "Acme", "Globex".

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
  ask: true,
  policy: DEFAULT_POLICY,
};

/** The same, with the scribe off and no notes repo: the smallest deployment. */
const BARE: ManualSettings = { ...DEFAULTS, notesRepo: null, ask: false };

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

test("the overview is what you type, what I send you, the buttons, then the pages", () => {
  const blocks = overviewBlocks(DEFAULTS, true);
  assert.equal(blocks.length, 4, "what you type, what I send you, the buttons, then where the pages are");

  const typed = blocks[0].text.text;
  assert.match(typed, /^\*What you can type\*\n• /);
  assert.match(typed, /• `today`: the plan for today, the same view as the morning briefing\./);
  assert.match(typed, /• Ask me anything about your board or notes, e\.g\. `how's the Acme POC going\?` or `what's waiting on others\?` I answer from the board and your notes, and I never change anything\./);
  assert.match(typed, /• `note: <text>`: `note: Acme call, they want a POC in January\. I send the sizing by Friday\.`/);
  assert.match(typed, /• `help`, or `help <topic>`/);
  assert.match(typed, /• Reply under a ping: marks it seen\./);
  assert.match(typed, /• Anything else you write, in a new message or a thread, is read as a question\./);
  assert.doesNotMatch(typed, /one of my messages/, "no reply anywhere is an ack but a ping's");

  const sent = blocks[1].text.text;
  assert.match(sent, /^\*What I send you\* \(automatic; you never type these\)\n• /);
  assert.match(sent, /• The briefing at `09:00` and the wrap-up at `17:30` on weekdays: one message listing everything\./);
  assert.match(sent, /• Pings: a separate message about ONE item when it needs you now/);
  assert.match(sent, /notes#53 Acme deck review: due in 2 days \(Thu 26 Nov\) {2}\[👍 On it\] \[Move date\] \[✅ Done\]/);
  assert.match(sent, /Each ping has buttons\./);

  const buttons = blocks[2].text.text;
  assert.match(buttons, /^\*The buttons under a ping\*/);
  for (const label of ["👍 On it", "✅ Done", "Move date", "+7 days"]) {
    assert.equal(buttons.split("\n").filter((line) => line.includes(`*${label}`)).length, 1, `one line for ${label}`);
  }

  assert.equal(blocks.at(-1)?.text.text, "More: `help pings`, `help buttons`, `help note`, `help ask`, `help updates`, `help today`");
});

test("the manual never names `briefing`, and `help briefing` is the today page", () => {
  const text = overviewText(DEFAULTS, true);
  assert.doesNotMatch(text, /`briefing`/, "the old command name is never shown");
  assert.match(text, /More: .*`help today`$/);

  assert.equal(helpReply(DEFAULTS, true, "briefing").text, helpReply(DEFAULTS, true, "today").text);
  assert.match(helpReply(DEFAULTS, true, "  Briefing ").text, /^\*Today\*/, "matched however it is typed, and silently");
  assert.doesNotMatch(helpReply(DEFAULTS, true, "briefing").text, /No topic/);
});

test("every overview section and every page fits the Block Kit limits", () => {
  fits(overviewBlocks(DEFAULTS, true));
  fits(overviewBlocks(BARE, false));
  for (const topic of topics()) {
    const reply = helpReply(DEFAULTS, true, topic.topic);
    fits(reply.blocks);
    assert.ok(reply.blocks.length >= 2, `${topic.topic} is a page, not a header`);
  }
  for (const asked of ["horoscope", "TODAY "]) fits(helpReply(DEFAULTS, true, asked).blocks);
});

test("the note line and the note topic are only there when the scribe is on", () => {
  assert.deepEqual(topics().map((topic) => topic.topic), ["today", "pings", "buttons", "note", "ask", "updates"]);
  assert.deepEqual(manualTopics(DEFAULTS, false).map((topic) => topic.topic), ["today", "pings", "buttons", "ask", "updates"]);
  assert.deepEqual(manualTopics(BARE, false).map((topic) => topic.topic), ["today", "pings", "buttons", "updates"]);

  const bare = overviewText(BARE, false);
  assert.doesNotMatch(bare, /`note:|`help note`/, "the scribe is off: nothing of notes is promised");
  assert.match(bare, /More: `help pings`, `help buttons`, `help updates`, `help today`$/);
  assert.match(overviewText(DEFAULTS, true), /`note: <text>`/);
  assert.match(overviewText(DEFAULTS, true), /`help note`/);
});

test("the notes-commit ack is only mentioned when NOTES_REPO is set", () => {
  const withRepo = helpReply(DEFAULTS, true, "updates").text;
  const without = helpReply(BARE, true, "updates").text;

  assert.match(withRepo, /a commit to the notes repo under `Accounts\/<the item's Account>\/`/);
  assert.doesNotMatch(without, /notes repo/);
  assert.doesNotMatch(without, /Accounts\//);

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

  const overview = overviewText(settings, true);
  assert.match(overview, /at `08:15`/);
  assert.match(overview, /at `18:45`/);
  assert.match(overview, /a deadline close \(Target date due in 2 days or fewer\) or already passed/);
  assert.match(overview, /a Waiting item nobody moved for 11 days/);
  assert.doesNotMatch(overview, /Workshop|T-14/, "nothing of the default policy survives");

  const pings = helpReply(settings, true, "pings").text;
  assert.match(pings, /Target date T-2 to T-0/);
  assert.match(pings, /9 days/);
  assert.match(pings, /POC at T-10 and T-3/);
  assert.match(pings, /11 days/);
  assert.match(pings, /at `18:45`/);
  assert.doesNotMatch(pings, /T-14|T-7\b|Workshop/, "nothing of the default policy survives");

  const today = helpReply(settings, true, "today").text;
  assert.match(today, /\*Coming up\*: Target dates 5–6 days away, 10 days out for a POC/);
  assert.match(today, /limit of 7/);
  assert.match(today, /30 days/);
});

test("the today page is the briefing page: when it goes out, what it holds, and the command", () => {
  const page = helpReply(DEFAULTS, true, "today").text;

  assert.match(page, /^\*Today\*/);
  assert.match(page, /\*When\*: weekdays only, Asia\/Singapore/);
  assert.match(page, /The morning briefing goes out once at `09:00`, the wrap-up once at `17:30`/);
  assert.match(page, /What the morning briefing holds/);
  assert.match(page, /`today` in a DM sends the plan for today as it would go out right now/);
  assert.doesNotMatch(page, /`briefing`/);
});

test("the pings page opens by saying that pings are not typed", () => {
  const page = helpReply(DEFAULTS, true, "pings").text;

  assert.match(page, /^\*Pings\*\n\nPings are messages I send you; you don't type them\.\n\n\*When a direct ping goes out\*/);
});

test("an unknown topic is the overview with the miss on top", () => {
  const reply = helpReply(DEFAULTS, true, "horoscope");
  assert.equal(reply.blocks[0].text.text, "No topic `horoscope`. Here is the overview.");
  assert.deepEqual(reply.blocks.slice(1), overviewBlocks(DEFAULTS, true));

  const page = helpReply(DEFAULTS, true, "  Buttons ");
  assert.equal(page.blocks[0].text.text, "*Buttons*", "the topic is matched however it is typed");
  assert.match(page.text, /On it|Status/, "the page, not the overview");
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

test("the ask page says what it reads, that it is read-only, and that it says when it does not know", () => {
  const page = helpReply(DEFAULTS, true, "ask").text;

  assert.match(page, /^\*Questions\*/);
  assert.match(page, /Ask me a question in the DM and I answer it from the board and your notes/);
  assert.match(page, /every item that is not Done, plus the Done items touched in the last two weeks/);
  assert.match(page, /the README of up to three folders your question names,.*from `demo\/notes`/);
  assert.match(page, /I answer only from what I read/);
  assert.match(page, /the notes stop before the date you mean/);
  assert.match(page, /It is read-only\. Nothing is written to the board or to the notes/);
  assert.match(page, /A follow-up goes in the same thread/);
  assert.match(page, /the last few questions of that thread/);
  assert.match(page, /Without a model \(`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`\)/);
});

test("with no notes repo the ask page says the answer is the board alone", () => {
  const settings: ManualSettings = { ...DEFAULTS, notesRepo: null };
  const page = helpReply(settings, true, "ask").text;

  assert.match(page, /the notes: nothing, twice over/);
  assert.doesNotMatch(page, /demo\/notes/);
});

test("a reply under a ping is an ack; only a model turns the other replies into questions", () => {
  assert.match(overviewText(BARE, false), /• Reply under a ping: marks it seen\./);
  assert.doesNotMatch(overviewText(BARE, false), /read as a question/, "no model: an unknown DM is a hint, not a question");
  assert.match(overviewText(DEFAULTS, true), /• Anything else you write, in a new message or a thread, is read as a question\./);
});

test("the ask line and the ask page are only there when a model is set", () => {
  assert.match(overviewText(DEFAULTS, true), /• Ask me anything about your board or notes/);
  assert.doesNotMatch(overviewText(BARE, false), /Ask me anything/, "no model, no promise to answer questions");
  assert.match(helpReply(BARE, false, "ask").text, /^No topic `ask`\. Here is the overview\./);
  assert.equal(manualTopics(BARE, false).some((topic) => topic.topic === "ask"), false);
});

test("the README quotes the overview the bot sends", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("## Using the bot"), "the README has the section");
  assert.ok(readme.includes(overviewText(DEFAULTS, true)), "and its text is the manual's own text, not a copy that drifted");
});
