// Characterization: what plan() says about the synthetic board in
// fixtures/week.json, for every weekday slot from Mon 2026-11-23 up to and
// including Mon 2026-11-30, frozen in fixtures/week.expected.json.
//
// The expected file was generated from the rules as they were in 0.1.0, BEFORE
// src/rules.ts was split into rules + merge + render, and it has not been
// regenerated since. A diff here is a change in what the bot says: either the
// change is intended (then say so and regenerate) or it is a bug.
//
// Regenerate on purpose, never to make a red test green:
//   UPDATE=1 node --test test/characterization.test.ts
//
// The fixture is synthetic: "Acme", "Globex" and the repo "demo". No real
// board, issue or customer ever goes in here.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { plan, type Slot } from "../src/rules.ts";
import { FIXTURES, WEEK, WEEK_DATES, WEEK_ITEMS, readJson, toItem } from "./board.ts";

const SLOTS: Slot[] = ["M", "E"];

function week(): Array<{ date: string; slot: Slot; plan: ReturnType<typeof plan> }> {
  return WEEK_DATES.flatMap((date) => SLOTS.map((slot) => ({ date, slot, plan: plan(WEEK_ITEMS, date, slot, WEEK.history) })));
}

test("a board with nothing due still renders the empty Today line", () => {
  // The week board always has something to say, so this one line is pinned by
  // hand, from the 0.1.0 render step.
  const quiet = [
    toItem({
      id: "ITEM_QUIET",
      ref: "demo#20",
      title: "Quiet",
      url: "https://github.com/acme/demo/issues/20",
      status: "In progress",
      target: null,
      nextTouch: null,
      nextAction: null,
      waitingOn: null,
      updatedAt: "2026-11-20T00:00:00.000Z",
    }),
  ];
  assert.equal(
    plan(quiet, "2026-11-23", "M", []).briefing?.text,
    "*Morning briefing, Mon 23 Nov*\n\n*Today*\nNothing due. 🎉\n\n*In progress:* 1",
  );
});

test("every morning and evening plan of the week is unchanged", () => {
  const actual = week();
  if (process.env.UPDATE === "1") {
    writeFileSync(new URL("week.expected.json", FIXTURES), `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, readJson("week.expected.json"));
});
