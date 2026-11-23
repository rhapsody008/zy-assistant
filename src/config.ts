// Environment. Every process env variable is read here, so a missing one fails
// loudly at startup and names itself. No tokens are ever logged.

import { DEFAULT_POLICY, type Policy } from "./rules.ts";
import { parseHHMM } from "./time.ts";

export type Mode = "check" | "dry-run" | "run" | "scribe";

export interface SlackConfig {
  botToken: string;
  appToken: string;
  userId: string; // the only person the bot DMs and obeys
}

/** The note model: an OpenAI-compatible gateway (Nutanix Enterprise AI). */
export interface LlmSettings {
  baseUrl: string; // …/enterpriseai/gateway/v1
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number; // the reply's budget: a reasoning reply is long
}

/** The scribe, set iff the three LLM variables and NOTES_REPO are. */
export interface ScribeConfig {
  llm: LlmSettings;
  repo: string; // owner/repo of the notes
  token: string; // NOTES_GITHUB_TOKEN when set, else GITHUB_TOKEN
}

export interface Config {
  githubToken: string;
  projectOwner: string;
  projectNumber: number;
  briefTime: string; // HH:MM, ASSISTANT_TZ
  eodTime: string; // HH:MM, ASSISTANT_TZ
  /** owner/repo whose Accounts/<Account> commits count as activity, or null. */
  notesRepo: string | null;
  /** The rule knobs the env can override; the rest is DEFAULT_POLICY. */
  policy: Pick<Policy, "waitingChaseDays" | "stageStaleDays">;
  dbPath: string;
  httpPort: number | null; // null: no health endpoint
  slack: SlackConfig | null;
  /** null: no "note: ..." in the DM, and no `scribe` mode. */
  scribe: ScribeConfig | null;
}

const SLACK_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_ID"];

export const LLM_VARS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"];

/** Every variable the scribe needs: the model's three, and the notes repo. */
export const SCRIBE_VARS = [...LLM_VARS, "NOTES_REPO"] as const;

/** Which of the scribe's variables the env does not set: all of them means off. */
export function scribeMissing(env: NodeJS.ProcessEnv = process.env): string[] {
  return SCRIBE_VARS.filter((name) => (env[name] ?? "") === "");
}

/** The model's budget when LLM_TIMEOUT_MS is unset: reasoning models are slow. */
const LLM_TIMEOUT_MS = 90_000;

/** The reply's budget when LLM_MAX_TOKENS is unset: reasoning plus a note is long. */
const LLM_MAX_TOKENS = 8192;

/** "owner/repo", the shape the notes-repo REST calls are built from. */
const NOTES_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function fail(mode: Mode, names: string[], hint = ""): never {
  throw new Error(`${mode}: missing env ${names.join(", ")}${hint}`);
}

/** run needs Slack, check uses it when set, dry-run never does. */
export function loadConfig(mode: "run", env?: NodeJS.ProcessEnv): Config & { slack: SlackConfig };
export function loadConfig(mode: "check" | "dry-run" | "scribe", env?: NodeJS.ProcessEnv): Config;
export function loadConfig(mode: Mode, env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string): string => env[name] ?? "";

  const required =
    mode === "run"
      ? ["GITHUB_TOKEN", ...SLACK_VARS]
      : mode === "scribe"
        ? ["GITHUB_TOKEN", "NOTES_REPO", ...LLM_VARS]
        : ["GITHUB_TOKEN"];
  const missing = required.filter((name) => get(name) === "");
  if (missing.length > 0) fail(mode, missing);

  const slackSet = SLACK_VARS.filter((name) => get(name) !== "");
  let slack: SlackConfig | null = null;
  if (mode === "run" || (mode === "check" && slackSet.length > 0)) {
    const missingSlack = SLACK_VARS.filter((name) => get(name) === "");
    if (missingSlack.length > 0) fail(mode, missingSlack, ` (set all of ${SLACK_VARS.join(", ")} or none)`);
    slack = { botToken: get("SLACK_BOT_TOKEN"), appToken: get("SLACK_APP_TOKEN"), userId: get("SLACK_USER_ID") };
  }

  const briefTime = get("BRIEF_TIME") || "09:00";
  const eodTime = get("EOD_TIME") || "17:30";
  parseHHMM(briefTime);
  parseHHMM(eodTime);

  const number = Number(get("PROJECT_NUMBER") || "1");
  if (!Number.isInteger(number) || number < 1) throw new Error(`${mode}: PROJECT_NUMBER must be a positive integer`);

  const httpPort = get("HTTP_PORT");
  if (httpPort !== "" && !(/^\d{1,5}$/.test(httpPort) && Number(httpPort) >= 1 && Number(httpPort) <= 65535)) {
    throw new Error(`${mode}: HTTP_PORT must be a port number, got ${httpPort}`);
  }

  /** A positive whole number, or the default when unset. */
  const whole = (name: string, fallback: number, unit = ""): number => {
    const raw = get(name);
    if (raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`${mode}: ${name} must be a positive whole number${unit}, got ${raw}`);
    }
    return n;
  };

  /** A positive whole number of days, or the default when unset. */
  const days = (name: string, fallback: number): number => whole(name, fallback, " of days");

  const notesRepo = get("NOTES_REPO");
  if (notesRepo !== "" && !NOTES_REPO_RE.test(notesRepo)) {
    throw new Error(`${mode}: NOTES_REPO must be owner/repo, got ${notesRepo}`);
  }

  // The scribe is on iff all three LLM variables and NOTES_REPO are set; half of
  // them is a typo, not a decision, so it fails here rather than going quiet.
  const llmSet = LLM_VARS.filter((name) => get(name) !== "");
  if (llmSet.length > 0 && llmSet.length < LLM_VARS.length) {
    fail(mode, LLM_VARS.filter((name) => get(name) === ""), ` (the scribe needs all of ${LLM_VARS.join(", ")})`);
  }
  const baseUrl = get("LLM_BASE_URL");
  if (baseUrl !== "" && !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`${mode}: LLM_BASE_URL must be an http(s) url, got ${baseUrl}`);
  }
  const scribe: ScribeConfig | null =
    llmSet.length === LLM_VARS.length && notesRepo !== ""
      ? {
          llm: {
            baseUrl: baseUrl.replace(/\/+$/, ""),
            apiKey: get("LLM_API_KEY"),
            model: get("LLM_MODEL"),
            timeoutMs: whole("LLM_TIMEOUT_MS", LLM_TIMEOUT_MS),
            maxTokens: whole("LLM_MAX_TOKENS", LLM_MAX_TOKENS),
          },
          repo: notesRepo,
          token: get("NOTES_GITHUB_TOKEN") || get("GITHUB_TOKEN"),
        }
      : null;

  return {
    githubToken: get("GITHUB_TOKEN"),
    projectOwner: get("PROJECT_OWNER") || "rhapsody008",
    projectNumber: number,
    briefTime,
    eodTime,
    notesRepo: notesRepo === "" ? null : notesRepo,
    policy: {
      waitingChaseDays: days("WAITING_CHASE_DAYS", DEFAULT_POLICY.waitingChaseDays),
      stageStaleDays: days("STAGE_STALE_DAYS", DEFAULT_POLICY.stageStaleDays),
    },
    dbPath: get("DB_PATH") || "./data/state.db",
    httpPort: httpPort === "" ? null : Number(httpPort),
    slack,
    scribe,
  };
}
