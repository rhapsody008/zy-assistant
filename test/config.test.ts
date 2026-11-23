// The env: what a missing or malformed variable does, and the defaults the two
// new rule knobs fall back to. No process env, no files: loadConfig takes its env.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, SCRIBE_VARS, scribeMissing } from "../src/config.ts";

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

const LLM = {
  LLM_BASE_URL: "https://nai.example.com/enterpriseai/gateway/v1",
  LLM_API_KEY: "llm-key",
  LLM_MODEL: "zy-pi-uep",
};

test("the scribe is off unless all three LLM variables and NOTES_REPO are set", () => {
  assert.equal(loadConfig("dry-run", { ...BASE }).scribe, null, "nothing set: exactly 0.3.0");
  assert.equal(loadConfig("dry-run", { ...BASE, NOTES_REPO: "demo/notes" }).scribe, null, "no model, no scribe");
  assert.equal(loadConfig("dry-run", { ...BASE, ...LLM }).scribe, null, "no notes repo, no scribe");
});

test("a fully set scribe is read, with its defaults", () => {
  const config = loadConfig("dry-run", { ...BASE, ...LLM, NOTES_REPO: "demo/notes" });
  assert.deepEqual(config.scribe, {
    llm: {
      baseUrl: "https://nai.example.com/enterpriseai/gateway/v1",
      apiKey: "llm-key",
      model: "zy-pi-uep",
      timeoutMs: 90000,
      maxTokens: 8192,
    },
    repo: "demo/notes",
    token: "test-token",
  });
});

test("the notes token is its own when it is set, and LLM_TIMEOUT_MS and the url are read", () => {
  const config = loadConfig("dry-run", {
    ...BASE,
    ...LLM,
    NOTES_REPO: "demo/notes",
    NOTES_GITHUB_TOKEN: "notes-token",
    LLM_TIMEOUT_MS: "20000",
    LLM_MAX_TOKENS: "4096",
    LLM_BASE_URL: "https://nai.example.com/enterpriseai/gateway/v1/",
  });
  assert.equal(config.scribe?.token, "notes-token");
  assert.equal(config.scribe?.llm.timeoutMs, 20000);
  assert.equal(config.scribe?.llm.maxTokens, 4096);
  assert.equal(config.scribe?.llm.baseUrl, "https://nai.example.com/enterpriseai/gateway/v1", "a trailing slash is dropped");
});

test("half of the LLM variables is an error that names the missing ones", () => {
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, NOTES_REPO: "demo/notes", LLM_BASE_URL: "https://nai.example.com/v1" }),
    /missing env LLM_API_KEY, LLM_MODEL \(the scribe needs all of LLM_BASE_URL, LLM_API_KEY, LLM_MODEL\)/,
  );
});

test("`scribe` mode needs the model, the notes repo and a GitHub token", () => {
  assert.throws(
    () => loadConfig("scribe", { ...BASE }),
    /scribe: missing env NOTES_REPO, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL/,
  );
  assert.equal(loadConfig("scribe", { ...BASE, ...LLM, NOTES_REPO: "demo/notes" }).scribe?.repo, "demo/notes");
});

test("a bad LLM_TIMEOUT_MS, LLM_MAX_TOKENS or LLM_BASE_URL fails loudly", () => {
  for (const value of ["0", "-5", "2.5", "soon"]) {
    assert.throws(
      () => loadConfig("dry-run", { ...BASE, ...LLM, NOTES_REPO: "demo/notes", LLM_TIMEOUT_MS: value }),
      /LLM_TIMEOUT_MS must be a positive whole number, got/,
    );
    assert.throws(
      () => loadConfig("dry-run", { ...BASE, ...LLM, NOTES_REPO: "demo/notes", LLM_MAX_TOKENS: value }),
      /LLM_MAX_TOKENS must be a positive whole number, got/,
    );
  }
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...LLM, NOTES_REPO: "demo/notes", LLM_BASE_URL: "nai.example.com/v1" }),
    /LLM_BASE_URL must be an http\(s\) url/,
  );
});

test("with no scribe variable set, check has nothing to say about the scribe", () => {
  assert.deepEqual(scribeMissing({}), [...SCRIBE_VARS]);
  assert.deepEqual(SCRIBE_VARS, ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "NOTES_REPO"]);
  // Half-configured is not silence: check names what is missing.
  assert.deepEqual(scribeMissing({ NOTES_REPO: "demo/notes" }), ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]);
  assert.deepEqual(scribeMissing({ ...LLM, NOTES_REPO: "demo/notes" }), []);
});
