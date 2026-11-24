// validateSchema: the board's field names are checked against src/schema.ts, so
// a renamed field is one DM at startup instead of a silent empty briefing.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, BoardField } from "../src/github.ts";
import { ALL_FIELDS, FIELD, requiredProblems, validateSchema } from "../src/schema.ts";

const field = (names: string[], options: string[] = []): Board["fields"] =>
  new Map(names.map((name, i) => [name, { id: `F_${i}`, options: options.length > 0 ? new Map(options.map((o) => [o, `O_${o}`])) : undefined }]));

const ALL_NAMES = ["Status", "Target date", "Next touch", "Next action", "Waiting on", "Work type", "Stage", "Track", "Account", "Cadence"];

test("every field's name is one FIELD holds, so a rename in one place fails here", () => {
  const names: string[] = Object.values(FIELD);
  for (const spec of ALL_FIELDS) assert.ok(names.includes(spec.name), `${spec.item} is named ${spec.name}, which FIELD does not hold`);
});

test("a board with every field and option reports nothing", () => {
  const report = validateSchema({ fields: field(ALL_NAMES, ["In progress", "Done"]) });
  assert.deepEqual(report, { missingRequired: [], missingOptional: [], missingOptions: [] });
  assert.deepEqual(requiredProblems(report), []);
});

test("a renamed required field is missing, and a missing optional one is only noted", () => {
  const report = validateSchema({ fields: field(["Status", "Due date", "Next touch", "Next action"], ["In progress", "Done"]) });
  assert.deepEqual(report.missingRequired, ["Target date", "Waiting on"]);
  assert.deepEqual(report.missingOptional, ALL_NAMES.slice(5));
  assert.deepEqual(requiredProblems(report), ['missing field "Target date"', 'missing field "Waiting on"']);
});

test("a Status field without the options the bot reads or writes is a missing option", () => {
  const report = validateSchema({ fields: field(["Target date", "Next touch", "Next action", "Waiting on", "Status"], ["Todo"]) });
  assert.deepEqual(report.missingOptions, ["Status: In progress", "Status: Done"]);
  assert.deepEqual(requiredProblems(report), ['missing option "Status: In progress"', 'missing option "Status: Done"']);
});

test("a field that exists without options is reported, not thrown", () => {
  const report = validateSchema({ fields: new Map<string, BoardField>([["Status", { id: "F_STATUS" }]]) });
  assert.deepEqual(report.missingOptions, ["Status: In progress", "Status: Done"]);
});
