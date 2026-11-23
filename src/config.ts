// Environment. Every process env variable is read here, so a missing one fails
// loudly at startup and names itself. No tokens are ever logged.

import { parseHHMM } from "./time.ts";

export type Mode = "check" | "dry-run" | "run";

export interface SlackConfig {
  botToken: string;
  appToken: string;
  userId: string; // the only person the bot DMs and obeys
}

export interface Config {
  githubToken: string;
  projectOwner: string;
  projectNumber: number;
  briefTime: string; // HH:MM, ASSISTANT_TZ
  eodTime: string; // HH:MM, ASSISTANT_TZ
  dbPath: string;
  slack: SlackConfig | null;
}

const SLACK_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_ID"];

function fail(mode: Mode, names: string[], hint = ""): never {
  throw new Error(`${mode}: missing env ${names.join(", ")}${hint}`);
}

/** run needs Slack, check uses it when set, dry-run never does. */
export function loadConfig(mode: "run", env?: NodeJS.ProcessEnv): Config & { slack: SlackConfig };
export function loadConfig(mode: "check" | "dry-run", env?: NodeJS.ProcessEnv): Config;
export function loadConfig(mode: Mode, env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string): string => env[name] ?? "";

  const required = mode === "run" ? ["GITHUB_TOKEN", ...SLACK_VARS] : ["GITHUB_TOKEN"];
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

  return {
    githubToken: get("GITHUB_TOKEN"),
    projectOwner: get("PROJECT_OWNER") || "rhapsody008",
    projectNumber: number,
    briefTime,
    eodTime,
    dbPath: get("DB_PATH") || "./data/state.db",
    slack,
  };
}
