// The test boards, in one place: how a test builds an Item, and the week fixture
// the characterization test and the CLI's golden both read. One Item field is one
// edit, and the two tests cannot disagree about what the fixture says.

import { readFileSync } from "node:fs";
import type { Item, SentPing } from "../src/rules.ts";
import { addDays, isWeekend } from "../src/time.ts";

const UPDATED = "2026-11-20T00:00:00.000Z";

/** An item for a board a test makes up: everything it does not care about is null. */
export function item(fields: Partial<Item> & Pick<Item, "id">): Item {
  return {
    ref: `notes#${fields.id}`,
    title: `Work ${fields.id}`,
    url: `https://github.com/rhapsody008/notes/issues/${fields.id}`,
    status: "In progress",
    target: null,
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
    type: null,
    stage: null,
    track: null,
    account: null,
    cadence: null,
    parentUrl: null,
    contentId: null,
    updatedAt: UPDATED,
    ...fields,
  };
}

/** A fixture item: an Item's fields, the optional ones left out when it has none. */
export interface FixtureItem {
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

export interface Week {
  items: FixtureItem[];
  history: SentPing[];
}

export const FIXTURES = new URL("./fixtures/", import.meta.url);

export function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

/** Item is built field by field, so a new required field is a compile error here. */
export const toItem = (f: FixtureItem): Item => ({
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

/** The weekdays of from .. to, both ends included when they are weekdays. */
export function weekdays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) days.push(d);
  return days;
}

/** The synthetic week: Mon 2026-11-23 .. Mon 2026-11-30, and the week's history. */
export const WEEK = readJson<Week>("week.json");
export const WEEK_ITEMS = WEEK.items.map(toItem);
export const WEEK_DATES = weekdays("2026-11-23", "2026-11-30");
