// The env: what a missing or malformed variable does, and the defaults the two
// new rule knobs fall back to. No process env, no files: loadConfig takes its env.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addMissing, ADD_VARS, loadConfig, noteItemsCheckLine, noteItemsRunLine, SCRIBE_VARS, scribeMissing } from "../src/config.ts";

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
    /missing env LLM_API_KEY, LLM_MODEL \(the scribe and the ask need all of LLM_BASE_URL, LLM_API_KEY, LLM_MODEL\)/,
  );
});

test("`scribe` mode needs the model, the notes repo and a GitHub token", () => {
  assert.throws(
    () => loadConfig("scribe", { ...BASE }),
    /scribe: missing env NOTES_REPO, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL/,
  );
  assert.equal(loadConfig("scribe", { ...BASE, ...LLM, NOTES_REPO: "demo/notes" }).scribe?.repo, "demo/notes");
});

test("the model is on with the three LLM variables alone, and the ask mode needs nothing else", () => {
  assert.equal(loadConfig("dry-run", { ...BASE }).llm, null, "nothing set: no model, no ask");
  const config = loadConfig("dry-run", { ...BASE, ...LLM });
  assert.equal(config.llm?.model, "zy-pi-uep", "the ask reads the board with no notes repo at all");
  assert.equal(config.scribe, null, "and the scribe still needs NOTES_REPO");

  assert.throws(() => loadConfig("ask", { ...BASE }), /ask: missing env LLM_BASE_URL, LLM_API_KEY, LLM_MODEL/);
  assert.equal(loadConfig("ask", { ...BASE, ...LLM }).llm?.model, "zy-pi-uep", "NOTES_REPO is optional for ask");
  assert.equal(loadConfig("ask", { ...BASE, ...LLM, NOTES_REPO: "demo/notes" }).scribe?.repo, "demo/notes");
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

const ADD = { ADD_REPO: "demo/notes" };

test("ADD_REPO without the model is an error that names the LLM variables", () => {
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...ADD }),
    /missing env LLM_BASE_URL, LLM_API_KEY, LLM_MODEL \(add: needs all of LLM_BASE_URL, LLM_API_KEY, LLM_MODEL\)/,
  );
});

test("add: is on with ADD_REPO and the model, and reads the config's own model", () => {
  const config = loadConfig("dry-run", { ...BASE, ...LLM, ...ADD });

  assert.deepEqual(config.add, { llm: config.llm, repo: "demo/notes" });
  assert.equal(config.add?.llm, config.llm, "the model is not built twice");
  assert.equal(config.add?.llm.model, "zy-pi-uep");
  assert.equal(config.scribe, null, "add: needs no notes repo");
});

test("add: is off when ADD_REPO is unset, even with the model", () => {
  assert.equal(loadConfig("dry-run", { ...BASE }).add, null, "nothing set");
  assert.equal(loadConfig("dry-run", { ...BASE, ...LLM }).add, null, "the model alone is the ask, not add:");
});

test("ADD_REPO has to be owner/repo", () => {
  for (const value of ["demo", "a/b/c", "https://github.com/demo/notes", "a/"]) {
    assert.throws(() => loadConfig("dry-run", { ...BASE, ...LLM, ADD_REPO: value }), /ADD_REPO must be owner\/repo/);
  }
});

test("addMissing names what add: lacks, and nothing once it is all set", () => {
  assert.deepEqual(ADD_VARS, ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "ADD_REPO"]);
  assert.deepEqual(addMissing({}), [...ADD_VARS]);
  assert.deepEqual(addMissing({ ...ADD }), ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]);
  assert.deepEqual(addMissing({ ...LLM, ...ADD }), []);
});

/** Everything note items need at once: the scribe's own, and the repo their issues go to. */
const LIVE = { ...LLM, NOTES_REPO: "demo/notes", ADD_REPO: "demo/board" };

test("NOTE_ITEMS is off unless it is exactly on", () => {
  assert.equal(loadConfig("dry-run", { ...BASE }).noteItems, false, "unset");
  assert.equal(loadConfig("dry-run", { ...BASE, ...LIVE, NOTE_ITEMS: "on" }).noteItems, true);
  for (const value of ["ON", "on ", " On", "true", "1", "off"]) {
    assert.equal(loadConfig("dry-run", { ...BASE, ...LIVE, NOTE_ITEMS: value }).noteItems, false, JSON.stringify(value));
  }
});

test("NOTE_ITEMS=on without the scribe is an error that names what the scribe lacks", () => {
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, NOTE_ITEMS: "on" }),
    /missing env LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, NOTES_REPO \(note items need the scribe: all of LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, NOTES_REPO\)/,
  );
  // Half a scribe names the half that is missing, and no more.
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...LLM, ADD_REPO: "demo/board", NOTE_ITEMS: "on" }),
    /missing env NOTES_REPO \(note items need the scribe/,
  );
});

test("NOTE_ITEMS=on without ADD_REPO is an error that names ADD_REPO", () => {
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...LLM, NOTES_REPO: "demo/notes", NOTE_ITEMS: "on" }),
    /missing env ADD_REPO \(note items need ADD_REPO, where their issues are created\)/,
  );
});

test("check and run say nothing about note items when they are off, and one line when they are on", () => {
  const off = loadConfig("dry-run", { ...BASE });
  const on = loadConfig("dry-run", { ...BASE, ...LIVE, NOTE_ITEMS: "on" });

  assert.equal(noteItemsCheckLine(off), null, "off: check reads exactly as it did before 0.8.0");
  assert.equal(noteItemsCheckLine(on), "note items: on -> demo/board");
  assert.equal(noteItemsRunLine(off), null, "off: run logs no line at all, as it did before 0.8.0");
  assert.equal(noteItemsRunLine(on), "note items: on -> demo/board");
});
