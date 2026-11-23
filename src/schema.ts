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

/** The Status option names the bot reads and writes. One source of truth. */
export const STATUS = { inProgress: "In progress", waiting: "Waiting", done: "Done" } as const;

/** The Stage options that make an item part of the open pipeline (rules 3 and 5). */
export const PIPELINE_STAGES = ["Discovery", "Workshop/Demo", "POC", "Proposal"] as const;

/** The Track option whose cadence is reported every Friday. */
export const TRACK = { learn: "Learn" } as const;

/** Without these the bot cannot plan or write back. */
export const REQUIRED_FIELDS: readonly FieldSpec[] = [
  { name: "Status", item: "status", kind: "singleSelect", options: [STATUS.inProgress, STATUS.done] },
  { name: "Target date", item: "target", kind: "date" },
  { name: "Next touch", item: "nextTouch", kind: "date" },
  { name: "Next action", item: "nextAction", kind: "text" },
  { name: "Waiting on", item: "waitingOn", kind: "text" },
];

/** Carried on the Item, not read by the rules yet: a board without them is fine. */
export const OPTIONAL_FIELDS: readonly FieldSpec[] = [
  { name: "Work type", item: "type", kind: "any" },
  { name: "Stage", item: "stage", kind: "any" },
  { name: "Track", item: "track", kind: "any" },
  { name: "Account", item: "account", kind: "any" },
  { name: "Cadence", item: "cadence", kind: "any" },
];

export const ALL_FIELDS: readonly FieldSpec[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

export interface SchemaReport {
  missingRequired: string[]; // field names the board does not have
  missingOptional: string[]; // field names the board does not have, and does not need
  missingOptions: string[]; // 'Status: In progress'
}

/** The part of a Board that validateSchema reads. */
export interface SchemaFields {
  fields: Map<string, { options?: Map<string, string> }>;
}

/** The Status options the rules read and the buttons write must both be there. */
export function validateSchema(board: SchemaFields): SchemaReport {
  const report: SchemaReport = { missingRequired: [], missingOptional: [], missingOptions: [] };
  for (const spec of REQUIRED_FIELDS) if (!board.fields.has(spec.name)) report.missingRequired.push(spec.name);
  for (const spec of OPTIONAL_FIELDS) if (!board.fields.has(spec.name)) report.missingOptional.push(spec.name);
  for (const spec of ALL_FIELDS) {
    const field = board.fields.get(spec.name);
    if (!field || !spec.options) continue;
    for (const option of spec.options) if (!field.options?.has(option)) report.missingOptions.push(`${spec.name}: ${option}`);
  }
  return report;
}

/** What the bot cannot work around: `run` DMs this once at startup. */
export function requiredProblems(report: SchemaReport): string[] {
  return [
    ...report.missingRequired.map((name) => `missing field "${name}"`),
    ...report.missingOptions.map((option) => `missing option "${option}"`),
  ];
}
