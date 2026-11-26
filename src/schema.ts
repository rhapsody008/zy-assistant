// The board's field NAMES, in one place. github.ts maps by name, never by id:
// ids differ per board and per replica, a name is what a person sees and keeps.
// A board layout change is a change here and nowhere else.

import type { Item } from "./rules.ts";

/** How the field's value arrives in the GraphQL response. */
export type FieldKind = "singleSelect" | "date" | "text" | "any";

/** The Item properties a board field can fill. */
export type ItemField =
  | "status"
  | "target"
  | "nextTouch"
  | "nextAction"
  | "waitingOn"
  | "type"
  | "stage"
  | "track"
  | "account"
  | "cadence";

export interface FieldSpec {
  name: string; // the board field name, exactly as a person typed it
  item: ItemField; // where its value lands
  kind: FieldKind; // how to read the value; "any" takes a name or a text
  /** Single select: the option names the code reads or writes. */
  options?: readonly string[];
}

/** The Status option names the brief reads and `zya update` writes. One source of truth. */
export const STATUS = { next: "Next", inProgress: "In progress", waiting: "Waiting", done: "Done" } as const;

/** The Stage options that make an item part of the open pipeline (rules 3 and 5). */
export const PIPELINE_STAGES = ["Discovery", "Workshop/Demo", "POC", "Proposal"] as const;

/** The Track option whose cadence is reported every Friday. */
export const TRACK = { learn: "Learn" } as const;

/** The board's field names, by what the brief and `zya update` call them: the one place they are written. */
export const FIELD = {
  status: "Status",
  target: "Target date",
  nextTouch: "Next touch",
  nextAction: "Next action",
  waitingOn: "Waiting on",
  type: "Work type",
  stage: "Stage",
  track: "Track",
  account: "Account",
  cadence: "Cadence",
} as const;

/** Without these the brief cannot plan and `zya update` cannot write back. */
export const REQUIRED_FIELDS: readonly FieldSpec[] = [
  { name: FIELD.status, item: "status", kind: "singleSelect", options: [STATUS.inProgress, STATUS.done] },
  { name: FIELD.target, item: "target", kind: "date" },
  { name: FIELD.nextTouch, item: "nextTouch", kind: "date" },
  { name: FIELD.nextAction, item: "nextAction", kind: "text" },
  { name: FIELD.waitingOn, item: "waitingOn", kind: "text" },
];

/** Carried on the Item, not read by the rules yet: a board without them is fine. */
export const OPTIONAL_FIELDS: readonly FieldSpec[] = [
  { name: FIELD.type, item: "type", kind: "any" },
  { name: FIELD.stage, item: "stage", kind: "any" },
  { name: FIELD.track, item: "track", kind: "any" },
  { name: FIELD.account, item: "account", kind: "any" },
  { name: FIELD.cadence, item: "cadence", kind: "any" },
];

export const ALL_FIELDS: readonly FieldSpec[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
