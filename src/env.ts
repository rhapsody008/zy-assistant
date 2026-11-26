// What the CLI reads from the environment: the board to read and the notes repo
// to name, and the one secret. No token is ever printed, and no error message
// carries a value: they name the variable instead.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TZ } from "./time.ts";

/**
 * Where the token lives outside the shell, as a shell assignment. Only the
 * GITHUB_TOKEN line is read: the rest of the file is the shell's business.
 */
export const ENV_FILE = join(homedir(), ".config", "zy-assistant", "env");

/** Reads a file as text; injected so a test never needs the real one. */
export type ReadFile = (path: string) => string;

export interface Env {
  token: string;
  owner: string;
  number: number;
  notesRepo: string; // owner/repo
  tz: string;
}

const readFileSyncText: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * The GITHUB_TOKEN=`...` line of the env file, quotes stripped, or null when
 * there is no file or no such line. A file that cannot be read is no token, not
 * a failure: the token may well be in the shell.
 */
function fileToken(readFile: ReadFile, path: string): string | null {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = /^GITHUB_TOKEN=(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") return value;
  }
  return null;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env, readFile: ReadFile = readFileSyncText): Env {
  // Every variable is read the same way: unset and empty are the same thing, as
  // they were in the bot's config. A blank line in a shell file is not a value,
  // and "" reaches a query or a formatter as a worse answer than the default.
  const get = (name: string): string => env[name] ?? "";

  const token = get("GITHUB_TOKEN") || fileToken(readFile, ENV_FILE);
  // The message names the variable and nothing else: a token in an error ends up
  // in a terminal scrollback, a log line and a bug report.
  if (token === null || token === "") throw new Error("GITHUB_TOKEN not set");

  const rawNumber = get("PROJECT_NUMBER");
  const number = rawNumber === "" ? 1 : Number(rawNumber);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`PROJECT_NUMBER must be a positive whole number, got ${rawNumber}`);
  }

  return {
    token,
    owner: get("PROJECT_OWNER") || "rhapsody008",
    number,
    notesRepo: get("NOTES_REPO") || "rhapsody008/notes",
    tz: get("ASSISTANT_TZ") || DEFAULT_TZ,
  };
}
