// The user manual, pinned: the overview separates what ZY types from what the bot
// sends, every page says what the bot does, the text quotes the live policy rather
// than a copy of it, and it fits in the Block Kit limits Slack enforces. Synthetic
// names only: "Acme", "Globex".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { helpReply, manualTopics, overviewBlocks, overviewText, type ManualSettings } from "../src/manual.ts";
import { MEETING_POLICY } from "../src/meeting-pings.ts";
import { DEFAULT_POLICY, type Policy } from "../src/rules.ts";

/** What the bot runs with when nothing overrides it. */
const DEFAULTS: ManualSettings = {
  briefTime: "09:00",
  eodTime: "17:30",
  notesRepo: "demo/notes",
  addRepo: null,
  noteItems: false,
  ask: true,
  calendar: false,
  calendarPings: false,
  meetings: MEETING_POLICY,
  policy: DEFAULT_POLICY,
};

/** The same, with a board repo to create an `add:` item in: the largest deployment. */
const ADDING: ManualSettings = { ...DEFAULTS, addRepo: "demo/board" };

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
  assert.match(typed, /• `today`: the plan for today, the same text as the morning briefing\./);
  assert.match(typed, /• Ask me anything about your board or notes, e\.g\. `how's the Acme POC going\?` or `what's waiting on others\?` I answer from the board and your notes, and I never change anything\./);
  assert.match(typed, /• `note: <text>`: `note: Acme call, they want a POC in January\. I send the sizing by Friday\.`/);
  assert.match(typed, /• `help`, or `help <topic>`/);
  assert.match(typed, /• Reply under an evening ping: marks it seen\./);
  assert.match(typed, /• Anything else you write, in a new message or a thread, is read as a question\./);
  assert.doesNotMatch(typed, /one of my messages/, "no reply anywhere is an ack but a ping's");

  const sent = blocks[1].text.text;
  assert.match(sent, /^\*What I send you\* \(automatic; you never type these\)\n• /);
  assert.match(sent, /• The briefing at `09:00` on weekdays: ONE message, with a row per item that needs you and a `⋯` menu on each row\./);
  assert.match(
    sent,
    /• At `17:30`, only if something needs you: a ping for each item due today, and a re-ping of an unanswered row that is still late or still due\. A quiet evening sends nothing\./,
  );
  assert.match(sent, /• The pings of the evening are a separate message about ONE item/);
  assert.match(
    sent,
    /notes#53 Acme deck review: due in 2 days \(Thu 26 Nov\)` with `⋯` on its right: \*Got it\*, \*Done\*, \*\+1 day\*, \*\+7 days\*, \*Move date…\*/,
  );
  assert.match(sent, /Each ping has buttons\./);

  const buttons = blocks[2].text.text;
  assert.match(buttons, /^\*The buttons under a ping, and the `⋯` on a row\*/);
  assert.match(buttons, /• \*Tomorrow\* and \*\+7 days\*: move Next touch/);
  assert.match(buttons, /• A row's `⋯` menu has the same actions, one entry each: \*Got it\*, \*Done\*, \*\+1 day\*, \*\+7 days\*, \*Move date…\*/);
  for (const label of ["👍 On it", "✅ Done"]) {
    assert.equal(buttons.split("\n").filter((line) => line.includes(`*${label}`)).length, 1, `one line for ${label}`);
  }
  assert.match(buttons, /\*Move date\*: asks for the new date and a reason/);

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
  assert.match(overview, /The briefing at `08:15` on weekdays/);
  assert.match(overview, /At `18:45`, only if something needs you: a ping for each item due today/);
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
  assert.match(page, /The morning briefing goes out once at `09:00` and is ONE message/);
  assert.match(page, /The evening sweep at `17:30` sends only pings, so a quiet evening sends nothing\./);
  assert.match(page, /one row per item whose Target date is today[^\n]*whatever its status/);
  assert.match(page, /The rows are ordered: what is late, then what is due today, then what is due soon, then a chase, then a milestone heads-up\./);
  assert.match(page, /Parents \(items with sub-issues\) don't count; their tasks do\./);
  assert.match(page, /What the morning briefing holds/);
  assert.match(page, /`today` in a DM sends the plan for today as it would go out right now: the briefing's text alone, without its menus/);
  assert.doesNotMatch(page, /`briefing`/);
});

test("the pings page opens by saying that pings are not typed, and only the evening has them", () => {
  const page = helpReply(DEFAULTS, true, "pings").text;

  assert.match(page, /^\*Pings\*\n\nPings are messages I send you; you don't type them\./);
  assert.match(page, /The morning has none of its own: everything is in the briefing, one row per item with its `⋯` menu\./);
  assert.match(page, /\*When a row of the briefing needs you\*: on any of these, whatever the item's status/);
  assert.match(page, /a re-ping for a morning row that still has no answer and still has something to say/);
  assert.match(page, /A row that is only due in a few days, a milestone heads-up and a chase do not re-ping\./);
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
  assert.match(page, /A plain reply in an evening ping's thread acks it, and answers "Noted\."/);
  assert.match(page, /A reply under the briefing is a question, not an ack: a row is acked by its menu\./);
  assert.match(page, /A briefing row has a `⋯` menu on its right instead of buttons/);
  assert.match(page, /A pick writes the board at once, with no second question/);
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

test("the note page offers the board items only when NOTE_ITEMS is on", () => {
  const off = helpReply(DEFAULTS, true, "note").text;
  const on = helpReply({ ...DEFAULTS, noteItems: true }, true, "note").text;

  assert.match(off, /nothing goes to the board\. Board proposals come in step 2\./, "off: the page it has always been");
  assert.doesNotMatch(off, /board items/, "nothing of the feature is promised without it");
  assert.match(
    on,
    /The note's actions are offered as board items on a card in the reply's thread, up to six of them, and nothing is written until you click \*Create\*\./,
  );
  assert.doesNotMatch(on, /step 2/, "what it describes is what happens now");
  assert.doesNotMatch(on, /nothing goes to the board/);
  fits(helpReply({ ...DEFAULTS, noteItems: true }, true, "note").blocks);
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

test("the calendar is in the ask line and its page only when CALENDAR_FILE is set", () => {
  // Off, both read as they did before the ask could see a calendar: byte for byte.
  assert.match(overviewText(DEFAULTS, true), /• Ask me anything about your board or notes, e\.g\./);
  assert.match(overviewText(DEFAULTS, true), /I answer from the board and your notes, and I never change anything\./);
  assert.doesNotMatch(overviewText(DEFAULTS, true), /calendar/);
  assert.match(helpReply(DEFAULTS, true, "ask").text, /I answer it from the board and your notes: `how's the Acme POC going\?`/);

  const settings: ManualSettings = { ...DEFAULTS, calendar: true };
  assert.match(overviewText(settings, true), /• Ask me anything about your board, calendar or notes, e\.g\./);
  assert.match(overviewText(settings, true), /I answer from the board, your calendar and your notes, and I never change anything\./);
  assert.match(
    helpReply(settings, true, "ask").text,
    /Ask me a question in the DM and I answer it from the board, your calendar and your notes: `how's the Acme POC going\?`/,
  );
  fits(helpReply(settings, true, "ask").blocks);
});

test("the ask page's What I read list names the calendar only when CALENDAR_FILE is set", () => {
  const off = helpReply(DEFAULTS, true, "ask").text;
  assert.match(off, /\*What I read\*, every time:\n• the board: [^\n]+\n• the notes: /, "off: board then notes, as before");
  assert.doesNotMatch(off, /calendar/);
  assert.match(off, /When the board has no item for what you asked, or the notes stop before the date you mean/);

  const settings: ManualSettings = { ...DEFAULTS, calendar: true };
  const on = helpReply(settings, true, "ask").text;
  assert.match(
    on,
    /\*What I read\*, every time:\n• the board: [^\n]+\n• the calendar: today's and tomorrow's meetings, with their times and titles but no links;\n• the notes: /,
  );
  assert.match(on, /or the calendar does not reach the day you mean, or the notes stop before the date you mean/);
  fits(helpReply(settings, true, "ask").blocks);
});

test("a reply under an evening ping is an ack; only a model turns the other replies into questions", () => {
  assert.match(overviewText(BARE, false), /• Reply under an evening ping: marks it seen\./);
  assert.doesNotMatch(overviewText(BARE, false), /read as a question/, "no model: an unknown DM is a hint, not a question");
  assert.match(overviewText(DEFAULTS, true), /• Anything else you write, in a new message or a thread, is read as a question\./);
});

test("the ask line and the ask page are only there when a model is set", () => {
  assert.match(overviewText(DEFAULTS, true), /• Ask me anything about your board or notes/);
  assert.doesNotMatch(overviewText(BARE, false), /Ask me anything/, "no model, no promise to answer questions");
  assert.match(helpReply(BARE, false, "ask").text, /^No topic `ask`\. Here is the overview\./);
  assert.equal(manualTopics(BARE, false).some((topic) => topic.topic === "ask"), false);
});

test("the add line and the add page are only there when ADD_REPO is set", () => {
  assert.match(
    overviewText(ADDING, true),
    /• `add: <text>`: `add: call Dana about the renewal on 8 Dec` and I draft a board item for you to approve, with its account, dates and parent engagement\./,
  );
  assert.doesNotMatch(overviewText(DEFAULTS, true), /`add:/, "no repo, no promise to draft an item");

  assert.deepEqual(topics(ADDING).map((topic) => topic.topic), ["today", "pings", "buttons", "note", "add", "ask", "updates"]);
  assert.equal(topics(DEFAULTS).some((topic) => topic.topic === "add"), false);
  assert.match(helpReply(ADDING, true, "add").text, /^\*Adding items\*/);
  assert.match(helpReply(ADDING, true, "  Add ").text, /^\*Adding items\*/, "matched however it is typed");

  fits(overviewBlocks(ADDING, true));
  fits(helpReply(ADDING, true, "add").blocks);
});

test("with no ADD_REPO, `help add` is the miss on top of the overview", () => {
  assert.match(helpReply(DEFAULTS, true, "add").text, /^No topic `add`\. Here is the overview\./);
  assert.match(helpReply(BARE, false, "add").text, /^No topic `add`\. Here is the overview\./);
});

test("the add page names the repo it creates in, and says that nothing is written until Create", () => {
  const page = helpReply(ADDING, true, "add").text;

  assert.match(page, /`✍️ drafting…`, and that same message is edited into a card/);
  assert.match(page, /Top to bottom, twelve things/);
  assert.match(page, /the buttons: \*Create\*, \*Edit\*, \*Cancel\*/);
  assert.match(page, /nothing is written until \*Create\*, and your click on it is the approval/);
  assert.match(page, /\*Edit\* opens a form over the card with all nine fields/);
  assert.match(page, /Saving it redraws the card with what you changed/);

  assert.match(page, /an issue in `demo\/board` whose body is your sentence quoted/);
  assert.doesNotMatch(page, /demo\/notes/, "the notes repo is not where an item goes");
  assert.match(page, /that issue onto the board, the item's fields \(Account, Track, Work type, Status, Target date, Next touch, Next action\), and the new issue as a sub-issue of its engagement/);
  assert.match(page, /offers \*Retry\* instead of a second \*Create\*: the retry carries on from the step that failed, and no second issue is ever made/);

  assert.match(page, /the Next touch is a follow-up you name for yourself/);
  assert.match(page, /"this Friday" is the coming Friday, and "next Friday" is the Friday of the following week/);
  assert.match(page, /`⚠ No engagement matched`/);
  assert.match(page, /`⚠ No parent, no account`/);
  assert.match(page, /the title is your sentence exactly as typed/);
  assert.match(page, /a task starts with a verb and names the result/);
  assert.match(page, /an engagement is `<Name> · <what it's about>`/);

  assert.match(page, /read wherever the DM holds it, in a new message or in a thread/);
  assert.match(page, /under an evening ping the ping's item goes to the model as a hint, and the `add:` does not mark the ping seen/);
});

test("the pages line lists add only when the topic is there", () => {
  assert.match(helpReply(ADDING, true, null).text, /More: `help pings`, `help buttons`, `help note`, `help add`, `help ask`, `help updates`, `help today`$/);
  assert.match(helpReply(DEFAULTS, true, null).text, /More: `help pings`, `help buttons`, `help note`, `help ask`, `help updates`, `help today`$/);
  assert.doesNotMatch(overviewText(DEFAULTS, true), /`help add`/);
});

test("the meeting ask and the briefing's meetings are only there when CALENDAR_PINGS is on", () => {
  // Off is what the manual said before the flag existed: byte for byte.
  const off = overviewText(DEFAULTS, true);
  assert.doesNotMatch(off, /meeting/i, "off: nothing of a meeting is promised");
  assert.doesNotMatch(helpReply(DEFAULTS, true, "today").text, /meeting/i);

  const settings: ManualSettings = { ...DEFAULTS, calendarPings: true };
  const on = overviewText(settings, true);
  assert.match(on, /• It also lists today's meetings under the rows, one line each: `• 09:00 Acme weekly sync`, an all-day one as `• all day Offsite`\./);
  const ask =
    "• When a meeting the calendar exported has ended, I ask about some of them: only a meeting of 20 minutes or more that ended on a weekday between `08:00` and `19:00`, and the day has a cap of 4 to 6 asks, spent on the longest meetings first, so a full day gets fewer asks than meetings. The DM looks like this: `「Acme weekly sync」 ended at 09:30 (09:00–09:30, 6 attendees). How did it go?` Your reply in that thread is filed as a note about that meeting, and the note's actions are offered as board items.";
  assert.ok(on.split("\n").includes(ask), "the ask line, whole and on a line of its own");

  const today = helpReply(settings, true, "today").text;
  assert.match(today, /• \*Today's meetings\*, from the calendar snapshot: one line per meeting today/);
  assert.match(today, /`• and N more meetings`/);
  assert.match(today, /A day with no meetings has no block at all\./);

  // The flag adds its lines and moves nothing else: strip them from the on text and
  // the off text is what is left, character for character.
  const flagLine = (line: string): boolean => /meeting/i.test(line);
  assert.ok(on.split("\n").some(flagLine), "the flag's lines are in the on text");
  assert.equal(off, on.split("\n").filter((line) => !flagLine(line)).join("\n"));

  fits(overviewBlocks(settings, true));
  fits(helpReply(settings, true, "today").blocks);
});

test("the ask line quotes the meeting limits it is built with, never a copy of the defaults", () => {
  const settings: ManualSettings = {
    ...DEFAULTS,
    calendarPings: true,
    meetings: { ...MEETING_POLICY, minMinutes: 30, perDayFloor: 2, perDay: 4 },
  };
  const line =
    overviewText(settings, true)
      .split("\n")
      .find((text) => text.startsWith("• When a meeting the calendar exported has ended")) ?? "";

  assert.match(line, /only a meeting of 30 minutes or more/);
  assert.match(line, /a cap of 2 to 4 asks/);
  assert.doesNotMatch(line, /20 minutes|4 to 6/, "nothing of the defaults survives, and the line is still one line");
  fits(overviewBlocks(settings, true));
});

test("the README quotes the overview the bot sends", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("## Using the bot"), "the README has the section");
  assert.ok(readme.includes(overviewText(DEFAULTS, true)), "and its text is the manual's own text, not a copy that drifted");
});
