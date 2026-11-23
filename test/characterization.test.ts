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
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { plan, type Item, type SentPing, type Slot } from "../src/rules.ts";
import { addDays, isWeekend } from "../src/time.ts";

interface FixtureItem {
  id: string;
  ref: string;
  title: string;
  url: string;
  status: string | null;
  target: string | null;
  nextTouch: string | null;
  nextAction: string | null;
  waitingOn: string | null;
  type?: string | null;
  stage?: string | null;
  track?: string | null;
  account?: string | null;
  cadence?: string | null;
  parentUrl?: string | null;
  contentId?: string | null;
  updatedAt: string;
}

interface Week {
  items: FixtureItem[];
  history: SentPing[];
}

const URL_FIXTURES = new URL("./fixtures/", import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, URL_FIXTURES), "utf8")) as T;
}

const WEEK = readJson<Week>("week.json");

/** Item is built field by field, so a new required field is a compile error here. */
const toItem = (f: FixtureItem): Item => ({
  id: f.id,
  ref: f.ref,
  title: f.title,
  url: f.url,
  status: f.status,
  target: f.target,
  nextTouch: f.nextTouch,
  nextAction: f.nextAction,
  waitingOn: f.waitingOn,
  type: f.type ?? null,
  stage: f.stage ?? null,
  track: f.track ?? null,
  account: f.account ?? null,
  cadence: f.cadence ?? null,
  parentUrl: f.parentUrl ?? null,
  contentId: f.contentId ?? null,
  updatedAt: f.updatedAt,
});

/** The weekdays of Mon 2026-11-23 .. Mon 2026-11-30, the Monday after the week. */
function weekdays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) days.push(d);
  return days;
}

const SLOTS: Slot[] = ["M", "E"];

function week(): Array<{ date: string; slot: Slot; plan: ReturnType<typeof plan> }> {
  const items = WEEK.items.map(toItem);
  return weekdays("2026-11-23", "2026-11-30").flatMap((date) =>
    SLOTS.map((slot) => ({ date, slot, plan: plan(items, date, slot, WEEK.history) })),
  );
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
    plan(quiet, "2026-11-23", "M", []).briefing,
    "*Morning briefing, Mon 23 Nov*\n\n*Today*\nNothing due. 🎉\n\nIn progress: 1",
  );
});

test("every morning and evening plan of the week is unchanged", () => {
  const actual = week();
  if (process.env.UPDATE === "1") {
    writeFileSync(new URL("week.expected.json", URL_FIXTURES), `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, readJson("week.expected.json"));
});
