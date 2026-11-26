// The morning briefing, as the CLI reads it: the rules' morning slot, and only
// that. No history and no notes-repo activity, because the CLI has no store: a
// day's briefing is a function of the board, and the same board says the same
// thing tomorrow as it did today.

import { plan, type Item } from "./rules.ts";

/** One row of the briefing: the item it is about, and the line it says. */
export interface BriefRow {
  itemId: string;
  text: string;
}

/**
 * A morning briefing, flat: `head` above `rows` above `tail`, and `text` the same
 * thing as one string. The Slack-only parts of a ping (its key, its kind, its
 * menu) are dropped: nothing outside Slack can press a button.
 */
export interface Brief {
  date: string; // YYYY-MM-DD
  text: string;
  head: string[];
  rows: BriefRow[];
  tail: string[];
}

/** The morning briefing of `today`, from the board alone. */
export function brief(items: Item[], today: string): Brief {
  const { briefing } = plan(items, today, "M", []);
  // The morning slot always renders one: its rows may be empty, the briefing not.
  if (briefing === null) throw new Error("brief: the morning plan has no briefing");
  return {
    date: today,
    text: briefing.text,
    head: briefing.head,
    rows: briefing.rows.map((row) => ({ itemId: row.itemId, text: row.text })),
    tail: briefing.tail,
  };
}
