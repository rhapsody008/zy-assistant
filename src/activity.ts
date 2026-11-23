// Notes-repo activity: a commit under Accounts/<Account> is a sign of life on
// every board item of that Account, so a ping can be acked by working on the
// notes instead of by pressing a button.
//
// Best effort, always: one REST call per Account that has a ping nobody acked,
// every error logged and swallowed. A slow or broken GitHub must never hold up
// a slot, so each call is bounded (10 s) and so is the whole lookup (30 s), and
// the caller gets a map and the plan goes out either way.

import { errMessage } from "./errors.ts";
import type { FetchLike } from "./github.ts";
import { isAcked, type Item, type SentPing } from "./rules.ts";

const API_URL = "https://api.github.com/repos";
const PER_PAGE = 20;

/** One REST call may not take longer than this. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The whole call gives up after this: a slot never waits for GitHub. */
const BUDGET_MS = 30_000;

export interface ActivityArgs {
  token: string;
  /** "owner/repo", e.g. "acme/notes". */
  repo: string;
  items: Item[];
  history: SentPing[];
  log: (line: string) => void;
  fetchFn?: FetchLike;
  /** Shorter timeouts for tests; the defaults are the production ones. */
  requestTimeoutMs?: number;
  budgetMs?: number;
}

interface RawCommit {
  commit?: {
    committer?: { date?: string | null } | null;
    author?: { date?: string | null } | null;
  } | null;
}

/**
 * The folder a person keeps an Account's notes in: the space stays a space,
 * encoded. "Acme Ltd" -> "Accounts/Acme%20Ltd"; the folder separator is literal.
 */
export const accountPath = (account: string): string => `Accounts/${encodeURIComponent(account)}`;

/** The commits URL of one Account since one instant. */
export function commitsUrl(repo: string, account: string, since: string): string {
  return `${API_URL}/${repo}/commits?path=${accountPath(account)}&since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
}

/**
 * itemId -> ISO of the newest commit under that item's Account, for the Accounts
 * that have at least one ping nobody acked yet. Everything else is absent.
 */
export async function fetchActivity(args: ActivityArgs): Promise<Map<string, string>> {
  const activity = new Map<string, string>();
  const fetchFn = args.fetchFn ?? fetch;
  const requestMs = args.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const budgetMs = args.budgetMs ?? BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  try {
    const accounts = [...accountsToCheck(args.items, args.history)];
    let checked = 0;
    for (const [account, since] of accounts) {
      // Once the budget is spent no further call is issued: the slot goes out
      // on what was read, and the rest is a line in the log.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        args.log(`notes activity: the ${budgetMs} ms budget is spent, ${accounts.length - checked} account(s) not checked`);
        break;
      }
      checked += 1;
      const newest = await newestCommit(args.token, args.repo, account, since, Math.min(requestMs, remaining), fetchFn, args.log);
      if (newest === null) continue;
      for (const item of args.items) if (item.account === account) activity.set(item.id, newest);
    }
  } catch (err) {
    // A map half filled is better than a slot that never runs.
    args.log(`notes activity failed: ${errMessage(err)}`);
  }
  return activity;
}

/** One entry per Account with an unacked ping, and how far back to look. */
function accountsToCheck(items: Item[], history: SentPing[]): Map<string, string> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const accounts = new Map<string, string>();
  for (const ping of history) {
    const item = byId.get(ping.itemId);
    if (!item?.account || isAcked(ping, item)) continue;
    const since = accounts.get(item.account);
    // The oldest unacked ping of the Account is what has to be looked past.
    if (since === undefined || Date.parse(ping.sentAt) < Date.parse(since)) accounts.set(item.account, ping.sentAt);
  }
  return accounts;
}

/** The newest commit date under an Account, or null when there is none to read. */
async function newestCommit(
  token: string,
  repo: string,
  account: string,
  since: string,
  timeoutMs: number,
  fetchFn: FetchLike,
  log: (line: string) => void,
): Promise<string | null> {
  const url = commitsUrl(repo, account, since);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(`notes activity for ${account}: GitHub API ${res.status}, ignored`);
      return null;
    }
    const commits = (await res.json()) as RawCommit[];
    if (!Array.isArray(commits)) {
      log(`notes activity for ${account}: unexpected response, ignored`);
      return null;
    }
    let newest: string | null = null;
    for (const commit of commits) {
      const date = commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
      if (date && (newest === null || Date.parse(date) > Date.parse(newest))) newest = date;
    }
    return newest;
  } catch (err) {
    log(`notes activity for ${account} failed, ignored: ${errMessage(err)}`);
    return null;
  }
}
