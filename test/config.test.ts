// The env: what a missing or malformed variable does, and the defaults the two
// new rule knobs fall back to. No process env, no files: loadConfig takes its env.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot, type CalendarState } from "../src/calendar.ts";
import {
  addMissing,
  ADD_VARS,
  calendarCheckLine,
  calendarPingsCheckLine,
  calendarPingsRunLine,
  calendarRunLine,
  loadConfig,
  noteItemsCheckLine,
  noteItemsRunLine,
  SCRIBE_VARS,
  scribeMissing,
} from "../src/config.ts";

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

const CALENDAR = { CALENDAR_FILE: "/var/lib/zy/calendar.json" };

test("CALENDAR_FILE is off when unset, and adding it changes no other setting", () => {
  const off = loadConfig("dry-run", { ...BASE });
  assert.equal(off.calendarFile, null);
  assert.equal(calendarCheckLine(off), null, "unset: check reads exactly as it did before");
  assert.equal(calendarRunLine(off, null), null, "and run logs no line at all");

  const on = loadConfig("dry-run", { ...BASE, ...CALENDAR });
  assert.deepEqual({ ...on, calendarFile: null }, off, "the calendar adds a path and nothing else");
});

test("an absolute CALENDAR_FILE is read, and check names it", () => {
  const config = loadConfig("dry-run", { ...BASE, ...CALENDAR });
  assert.equal(config.calendarFile, "/var/lib/zy/calendar.json");
  assert.equal(calendarCheckLine(config), "calendar: on -> /var/lib/zy/calendar.json");
});

test("a relative CALENDAR_FILE is a startup error", () => {
  for (const value of ["calendar.json", "./calendar.json", "../calendar.json", "var/lib/zy/calendar.json"]) {
    assert.throws(
      () => loadConfig("dry-run", { ...BASE, CALENDAR_FILE: value }),
      /CALENDAR_FILE must be an absolute path, got/,
      value,
    );
  }
});

test("the calendar mode needs no GITHUB_TOKEN, no Slack, no model, and reads the project's own", () => {
  const bare = loadConfig("calendar", { ...CALENDAR });
  assert.equal(bare.githubToken, "", "the one mode that works with no token at all");
  assert.equal(bare.slack, null);
  assert.equal(bare.llm, null);
  assert.equal(bare.projectOwner, "rhapsody008", "the project's defaults, like check's");
  assert.equal(bare.projectNumber, 1);

  const configured = loadConfig("calendar", { ...CALENDAR, PROJECT_OWNER: "demo", PROJECT_NUMBER: "7" });
  assert.equal(configured.projectOwner, "demo");
  assert.equal(configured.projectNumber, 7);
});

test("every other mode still demands GITHUB_TOKEN, as it did before", () => {
  for (const mode of ["check", "dry-run", "scribe", "ask"] as const) {
    assert.throws(() => loadConfig(mode, {}), /missing env GITHUB_TOKEN/, mode);
  }
  assert.throws(() => loadConfig("run", {}), /^Error: run: missing env GITHUB_TOKEN, SLACK_BOT_TOKEN/, "run");
  // `calendar` reads the project's variables like `check`, but not the token, and
  // a Slack env it does not use cannot make it fail either.
  const slack = { SLACK_BOT_TOKEN: "bot", SLACK_APP_TOKEN: "app", SLACK_USER_ID: "user" };
  const config = loadConfig("calendar", { ...slack, ...CALENDAR });
  assert.equal(config.slack, null, "no Slack client is built for a mode that sends nothing");
  assert.throws(() => loadConfig("check", {}), /missing env GITHUB_TOKEN/);
});

/** A one-event snapshot for the run line: the parser is the only way a state exists. */
function heldState(events: number, tz?: string): CalendarState {
  const one = {
    id: "9f2c41d07ab3e6c1",
    start: "2026-12-01T03:00:00Z",
    end: "2026-12-01T04:00:00Z",
    allDay: false,
    title: "Kickoff with demo",
    domains: ["demo.example"],
    attendees: 6,
    status: "accepted",
  };
  const text = JSON.stringify({
    v: tz === undefined ? 1 : 2,
    ...(tz === undefined ? {} : { tz }),
    generatedAt: "2026-12-01T02:15:03Z",
    window: { start: "2026-11-30T16:00:00Z", end: "2026-12-02T16:00:00Z" },
    events: Array.from({ length: events }, (_, i) => ({ ...one, id: i.toString(16).padStart(16, "0") })),
  });
  const now = new Date("2026-12-01T02:25:03Z");
  return { snapshot: parseSnapshot(text, now), readAt: now, freshness: "fresh" };
}

test("the run line names the file and the snapshot the first read found, or says there is none", () => {
  const config = loadConfig("dry-run", { ...BASE, ...CALENDAR });
  assert.equal(
    calendarRunLine(config, heldState(1)),
    "calendar: on, /var/lib/zy/calendar.json: snapshot 2026-12-01T02:15:03Z, 1 event",
  );
  assert.equal(
    calendarRunLine(config, heldState(4)),
    "calendar: on, /var/lib/zy/calendar.json: snapshot 2026-12-01T02:15:03Z, 4 events",
  );
  assert.equal(calendarRunLine(config, null), "calendar: on, /var/lib/zy/calendar.json: no snapshot yet");
});

test("the run line states the zone the snapshot declared, and a disagreement, the way the refresh line does", () => {
  // The first line read after a deploy is this one, so a foreign snapshot has to be
  // named here and not only on the push that brought it.
  const config = loadConfig("dry-run", { ...BASE, ...CALENDAR });
  assert.equal(
    calendarRunLine(config, heldState(7, "Asia/Singapore")),
    "calendar: on, /var/lib/zy/calendar.json: snapshot 2026-12-01T02:15:03Z, 7 events, tz Asia/Singapore",
  );
  assert.equal(
    calendarRunLine(config, heldState(7, "Europe/London")),
    "calendar: on, /var/lib/zy/calendar.json: snapshot 2026-12-01T02:15:03Z, 7 events, tz Europe/London, " +
      "not Asia/Singapore: its meetings and asks are off",
  );
  assert.equal(
    calendarRunLine(config, heldState(7)),
    "calendar: on, /var/lib/zy/calendar.json: snapshot 2026-12-01T02:15:03Z, 7 events",
    "a version 1 snapshot keeps the line 0.12.0 printed",
  );
});

/** Everything the meeting pings need at once: the snapshot and the scribe that files the reply. */
const PINGS = { ...CALENDAR, ...LLM, NOTES_REPO: "demo/notes" };

test("CALENDAR_PINGS is off unless it is exactly on, and adding it changes no other setting", () => {
  const off = loadConfig("dry-run", { ...BASE, ...PINGS });
  assert.equal(off.calendarPings, false, "unset");
  for (const value of ["ON", "on ", " On", "true", "1", "off"]) {
    assert.equal(loadConfig("dry-run", { ...BASE, ...PINGS, CALENDAR_PINGS: value }).calendarPings, false, JSON.stringify(value));
  }

  const on = loadConfig("dry-run", { ...BASE, ...PINGS, CALENDAR_PINGS: "on" });
  assert.equal(on.calendarPings, true);
  assert.deepEqual({ ...on, calendarPings: false }, off, "the pings add a flag and nothing else");
});

test("CALENDAR_PINGS=on without CALENDAR_FILE is an error that names CALENDAR_FILE", () => {
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...LLM, NOTES_REPO: "demo/notes", CALENDAR_PINGS: "on" }),
    /missing env CALENDAR_FILE \(calendar pings need CALENDAR_FILE, the snapshot their meetings come from\)/,
  );
});

test("CALENDAR_PINGS=on without the scribe is an error that names what the scribe lacks", () => {
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...CALENDAR, CALENDAR_PINGS: "on" }),
    /missing env LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, NOTES_REPO \(calendar pings need the scribe, whose note answers them: all of LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, NOTES_REPO\)/,
  );
  // Half a scribe names the half that is missing, and no more.
  assert.throws(
    () => loadConfig("dry-run", { ...BASE, ...CALENDAR, ...LLM, CALENDAR_PINGS: "on" }),
    /missing env NOTES_REPO \(calendar pings need the scribe/,
  );
});

test("check and run say nothing about the meeting pings when they are off, and one line when they are on", () => {
  const off = loadConfig("dry-run", { ...BASE, ...PINGS });
  const on = loadConfig("dry-run", { ...BASE, ...PINGS, CALENDAR_PINGS: "on" });

  assert.equal(calendarPingsCheckLine(off), null, "off: check reads exactly as it did before");
  assert.equal(calendarPingsRunLine(off), null, "off: run logs no line at all");
  assert.equal(calendarPingsCheckLine(on), "calendar pings: on -> /var/lib/zy/calendar.json");
  assert.equal(calendarPingsRunLine(on), "calendar pings: on");
});
