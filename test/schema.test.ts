// The board's field names are checked against src/schema.ts, so a renamed field
// fails here instead of leaving the brief reading an empty column.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_FIELDS, FIELD } from "../src/schema.ts";

test("every field's name is one FIELD holds, so a rename in one place fails here", () => {
  const names: string[] = Object.values(FIELD);
  for (const spec of ALL_FIELDS) assert.ok(names.includes(spec.name), `${spec.item} is named ${spec.name}, which FIELD does not hold`);
});
