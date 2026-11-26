// The CLI's golden: what brief() says about the synthetic board in
// fixtures/week.json, for every weekday from Mon 2026-11-23 up to and including
// Mon 2026-11-30, frozen in fixtures/week.brief.expected.json.
//
// brief() reads the board and nothing else: no history, no notes-repo activity, no
// meetings. The old characterization fixture (week.expected.json) holds the Slack
// bot's plan for the same week WITH that week's history, so the cross-check below
// pins exactly where the two agree, and names the days they are allowed to differ
// on and why.
//
// Regenerate on purpose, never to make a red test green:
//   UPDATE=1 node --test test/brief-golden.test.ts
//
// The fixture is synthetic: "Acme", "Globex" and the repo "demo". No real board,
// issue or customer ever goes in here.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { brief, type Brief } from "../src/brief.ts";
import { FIXTURES, WEEK_DATES, WEEK_ITEMS, readJson } from "./board.ts";

/** What the old fixture holds: the bot's plan, one entry per day and slot. */
interface OldEntry {
  date: string;
  slot: string;
  plan: { briefing: { text: string } | null };
}

/**
 * What the bot's morning text says once the part the CLI cannot know is taken out:
 * an ⚠ line is yesterday's unacked re-ping, which needs the history the CLI has
 * none of. Removing a line leaves the blank run the section stood in, hence the
 * collapse.
 */
function withoutWarnings(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes("⚠"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Each morning's text of the bot's plan, by date. */
function oldMornings(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readJson<OldEntry[]>("week.expected.json")) {
    if (entry.slot !== "M" || entry.plan.briefing === null) continue;
    out.set(entry.date, entry.plan.briefing.text);
  }
  return out;
}

/**
 * The days the cross-check allows to differ, and why. Empty is the honest answer
 * for this fixture: it holds no Waiting item without a Next touch, so the chase
 * that a history would suppress fires on no day of the week. A new entry here has
 * to name the reason, and the test proves the day really differs.
 */
const EXPECTED_DIFF: Record<string, string> = {};

test("the briefing of every weekday is unchanged", () => {
  const actual = WEEK_DATES.map((date) => brief(WEEK_ITEMS, date));
  if (process.env.UPDATE === "1") {
    writeFileSync(new URL("week.brief.expected.json", FIXTURES), `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, readJson<Brief[]>("week.brief.expected.json"));
});

test("a briefing carries no part of a chat message: no key, no kind, no menu", () => {
  const [monday] = WEEK_DATES.map((date) => brief(WEEK_ITEMS, date));
  assert.deepEqual(Object.keys(monday), ["date", "text", "head", "rows", "tail"]);
  assert.equal(monday.date, "2026-11-23");
  assert.ok(monday.rows.length > 0, "the week's board always has something to say");
  for (const row of monday.rows) assert.deepEqual(Object.keys(row), ["itemId", "text"]);
});

test("the morning the bot sent and the morning the CLI prints differ only where the history does", () => {
  const olds = oldMornings();
  for (const { date, text } of WEEK_DATES.map((day) => brief(WEEK_ITEMS, day))) {
    const old = olds.get(date);
    assert.ok(old !== undefined, `the old fixture has no morning briefing for ${date}`);
    if (EXPECTED_DIFF[date] !== undefined) {
      // A listed day has to be a real difference: a stale entry would excuse a
      // change nobody made.
      assert.notEqual(text, withoutWarnings(old), `${date} is listed as different (${EXPECTED_DIFF[date]}), and is not`);
      continue;
    }
    assert.equal(text, withoutWarnings(old), `${date}: the CLI's briefing has drifted from the bot's`);
  }
});
