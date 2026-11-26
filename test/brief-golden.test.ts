// The CLI's golden: what brief() says about the synthetic board in
// fixtures/week.json, for every weekday from Mon 2026-11-23 up to and including
// Mon 2026-11-30, frozen in fixtures/week.brief.expected.json.
//
// brief() reads the board and nothing else: no history, no notes-repo activity, no
// meetings.
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
