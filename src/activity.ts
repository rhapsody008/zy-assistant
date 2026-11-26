// The GitHub reads behind `zya yesterday`: the notes repo's commits over a
// window, and the comments on the issues of a board, over the same one.
//
// Two functions, each a list and nothing else: a caller that wanted a report
// builds it, and a call that fails throws, because a window half read is a
// report that lies. Every call is bounded (10 s) so a hung connection is a
// failure rather than a report that never prints.

import type { FetchLike } from "./github.ts";
import { NOTE_ROOTS } from "./notes.ts";

const API_URL = "https://api.github.com/repos";

/** One page, the most GitHub gives: a second page is never asked for. */
const PER_PAGE = 100;

/** How many commits are opened one by one for the folders their files are in. */
const DETAIL_MAX = 30;

/** A comment body is cut here: a report line is a line, not a pasted thread. */
const BODY_MAX = 500;

/** One REST call may not take longer than this. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The folder a person keeps an Account's notes in: the space stays a space,
 * encoded. "Acme Ltd" -> "Accounts/Acme%20Ltd"; the folder separator is literal.
 */
export const accountPath = (account: string): string => `Accounts/${encodeURIComponent(account)}`;

/** The commits URL of one Account since one instant. */
export function commitsUrl(repo: string, account: string, since: string): string {
  return `${API_URL}/${repo}/commits?path=${accountPath(account)}&since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
}

/** The commits URL of one repo over a window: since is inclusive, until exclusive. */
function windowUrl(repo: string, since: string, until: string): string {
  return `${API_URL}/${repo}/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=${PER_PAGE}`;
}

/** One commit of the notes repo, and the note folders it touched. */
export interface NotesCommit {
  sha: string;
  message: string; // the first line of the commit message, which is the whole of it
  date: string; // ISO-8601
  url: string; // the commit's page on GitHub
  folders: string[]; // distinct "Accounts/Acme", "Partners/Globex", ...: the notes it wrote
}

/** What one window of the notes repo holds, and whether it is all of it. */
export interface NotesCommits {
  commits: NotesCommit[];
  /** The window holds more than this read: a page that may have a next one, or commits past the first ones opened. */
  truncated: boolean;
}

export interface NotesCommitsArgs {
  token: string;
  /** "owner/repo", e.g. "acme/notes". */
  repo: string;
  since: string; // ISO-8601, the window's start
  until: string; // ISO-8601, the window's end
  fetchFn?: FetchLike;
}

interface RawCommit {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    committer?: { date?: string | null } | null;
    author?: { date?: string | null } | null;
  } | null;
}

interface RawFile {
  filename?: string;
}

interface RawCommitDetail {
  files?: RawFile[] | null;
}

/**
 * The notes repo's commits over a window: the list, then each commit read for
 * the files it changed, because only a file's path says which note it was.
 * A commit that touched no note folder (a README at a root, the repo's own
 * files) stays in the list with no folders: it happened, and it is not a note.
 */
export async function fetchNotesCommits(args: NotesCommitsArgs): Promise<NotesCommits> {
  const fetchFn = args.fetchFn ?? fetch;
  const what = `commits of ${args.repo}`;
  const listed = await getJson<unknown>(fetchFn, args.token, windowUrl(args.repo, args.since, args.until), what);
  if (!Array.isArray(listed)) throw new Error(`${what}: unexpected response`);
  const page = listed as RawCommit[];
  // One reason the report may not be the whole window: past the first commits
  // nothing is opened for its folders, and a commit with no folder is no note.
  const truncated = page.length > DETAIL_MAX;

  const commits: NotesCommit[] = [];
  for (const raw of page.slice(0, DETAIL_MAX)) {
    const commit = listedCommit(raw, args.repo);
    const detailUrl = `${API_URL}/${args.repo}/commits/${commit.sha}`;
    const detail = await getJson<unknown>(fetchFn, args.token, detailUrl, `commit ${commit.sha}`);
    commits.push({ ...commit, folders: foldered(detail) });
  }
  return { commits, truncated };
}

/** One commit off the list, or a throw: a commit with no sha cannot even be opened. */
function listedCommit(raw: RawCommit, repo: string): Omit<NotesCommit, "folders"> {
  const sha = raw.sha;
  const url = raw.html_url;
  const date = raw.commit?.committer?.date ?? raw.commit?.author?.date ?? null;
  if (typeof sha !== "string" || typeof url !== "string" || date === null) {
    throw new Error(`commits of ${repo}: a commit holds no sha, date or html_url`);
  }
  return { sha, message: firstLine(raw.commit?.message ?? ""), date, url };
}

/** The first line of a commit message: the subject, which is all a report line says. */
function firstLine(message: string): string {
  const [first] = message.split("\n");
  return first.trim();
}

/** The note folders one commit's files are in, distinct and in name order. */
function foldered(detail: unknown): string[] {
  const files = (detail as RawCommitDetail | null)?.files;
  if (!Array.isArray(files)) return [];
  const folders = new Set<string>();
  for (const file of files) {
    if (typeof file?.filename !== "string") continue;
    const folder = noteFolder(file.filename);
    if (folder !== null) folders.add(folder);
  }
  return [...folders].sort();
}

/**
 * "Accounts/Acme/README.md" -> "Accounts/Acme". A note is a file inside a
 * folder under one of the three roots; a README at a root's own level is the
 * repo's, not a note's, and has no folder.
 */
function noteFolder(path: string): string | null {
  const parts = path.split("/");
  if (parts.length < 3) return null;
  const [root, name] = parts;
  return (NOTE_ROOTS as readonly string[]).includes(root) ? `${root}/${name}` : null;
}

/** One comment on an issue of the board. */
export interface IssueComment {
  issueUrl: string; // the issue it is on, as the API names it
  author: string;
  createdAt: string; // ISO-8601
  body: string; // the first 500 characters
  url: string; // the comment's own page
}

export interface IssueCommentsArgs {
  token: string;
  /** The "owner/repo" of every issue the board knows: one call each. */
  repos: string[];
  since: string; // ISO-8601, the window's start
  until: string; // ISO-8601, the window's end
  fetchFn?: FetchLike;
}

/** The comments of one repo, last updated since one instant, as GitHub lists them. */
function commentsUrl(repo: string, since: string): string {
  return `${API_URL}/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
}

interface RawComment {
  html_url?: string;
  issue_url?: string;
  created_at?: string;
  body?: string | null;
  user?: { login?: string } | null;
}

/**
 * The comments of every repo a board's issues live in, created inside a window.
 * `since` is GitHub's own filter and it means "last updated since": a comment
 * written last week and edited on Saturday is in the list, so the creation date
 * is what is kept here, and the API's end of the window is dropped too, since it
 * has no opinion about that one: the window is [since, until).
 *
 * One page of 100 per repo is read and no more, and unlike the notes repo's
 * commits there is no `truncated` to say so: a repo that saw more than a hundred
 * comments inside the window loses the rest, and the caller cannot tell.
 */
export async function fetchIssueComments(args: IssueCommentsArgs): Promise<IssueComment[]> {
  const fetchFn = args.fetchFn ?? fetch;
  const sinceMs = Date.parse(args.since);
  const untilMs = Date.parse(args.until);
  const comments: IssueComment[] = [];
  for (const repo of args.repos) {
    const what = `comments of ${repo}`;
    const listed = await getJson<unknown>(fetchFn, args.token, commentsUrl(repo, args.since), what);
    if (!Array.isArray(listed)) throw new Error(`${what}: unexpected response`);
    for (const raw of listed as RawComment[]) {
      const comment = mapComment(raw, repo);
      const created = Date.parse(comment.createdAt);
      if (!(created >= sinceMs && created < untilMs)) continue;
      comments.push(comment);
    }
  }
  return comments;
}

/** One comment as the list carries it, or a throw: a comment with no issue belongs to nothing. */
function mapComment(raw: RawComment, repo: string): IssueComment {
  const { issue_url: issueUrl, html_url: url, created_at: createdAt, body, user } = raw;
  if (typeof issueUrl !== "string" || typeof url !== "string" || typeof createdAt !== "string") {
    throw new Error(`comments of ${repo}: a comment holds no issue_url, html_url or created_at`);
  }
  return {
    issueUrl,
    author: typeof user?.login === "string" ? user.login : "unknown",
    createdAt,
    body: (body ?? "").slice(0, BODY_MAX),
    url,
  };
}

/** The body of one GET, or a throw that names the status: a caller never reports half a call. */
async function getJson<T>(fetchFn: FetchLike, token: string, url: string, what: string): Promise<T> {
  const res = await fetchFn(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: GitHub API ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}
