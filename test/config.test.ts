// The env: what a missing or malformed variable does, and the defaults the two
// new rule knobs fall back to. No process env, no files: loadConfig takes its env.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const BASE = { GITHUB_TOKEN: "test-token" };

test("the notes repo and the two day knobs default to off and to the policy", () => {
  const config = loadConfig("dry-run", { ...BASE });
  assert.equal(config.notesRepo, null, "unset: no notes activity");
  assert.deepEqual(config.policy, { waitingChaseDays: 5, stageStaleDays: 21 });
});

test("set values are read", () => {
  const config = loadConfig("dry-run", {
    ...BASE,
    NOTES_REPO: "rhapsody008/notes",
    WAITING_CHASE_DAYS: "3",
    STAGE_STALE_DAYS: "10",
  });
  assert.equal(config.notesRepo, "rhapsody008/notes");
  assert.deepEqual(config.policy, { waitingChaseDays: 3, stageStaleDays: 10 });
});

test("NOTES_REPO has to be owner/repo", () => {
  for (const value of ["notes", "a/b/c", "https://github.com/a/b", "a/"]) {
    assert.throws(() => loadConfig("dry-run", { ...BASE, NOTES_REPO: value }), /NOTES_REPO must be owner\/repo/);
  }
});

test("the day knobs have to be positive whole numbers", () => {
  for (const value of ["0", "-1", "2.5", "soon", " "]) {
    assert.throws(() => loadConfig("dry-run", { ...BASE, WAITING_CHASE_DAYS: value }), /WAITING_CHASE_DAYS must be a positive whole number/);
    assert.throws(() => loadConfig("dry-run", { ...BASE, STAGE_STALE_DAYS: value }), /STAGE_STALE_DAYS must be a positive whole number/);
  }
});
