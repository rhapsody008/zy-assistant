// The notes repo over the GitHub Contents API: the folders to choose from, a
// folder's README.md, and the commit that writes it back. Every call is bounded
// (15 s) and every write lists the sha it read, so a second writer is detected
// instead of overwritten: a mismatch is a ShaConflict the caller retries.

import type { FetchLike } from "./github.ts";

const API_URL = "https://api.github.com/repos";

/** One Contents call may not take longer than this. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The three folders a note can go into: the roots of ZY's notes repo. */
export const NOTE_ROOTS = ["Accounts", "Partners", "Events"] as const;

export interface NotesFile {
  text: string;
  sha: string;
}

export interface NotesClient {
  /** "Accounts/Acme", "Partners/Globex", ...: the directories, roots first. */
  listFolders(): Promise<string[]>;
  /** A file's text and the sha a write has to carry; null when there is no such file. */
  readFile(path: string): Promise<NotesFile | null>;
  /** Writes the file and returns the commit's html_url. */
  writeFile(path: string, text: string, sha: string | null, message: string): Promise<string>;
}

/** The file changed between the read and the write: read it again and retry. */
export class ShaConflict extends Error {}

export interface NotesOptions {
  /** owner/repo. */
  repo: string;
  token: string;
  fetchFn?: FetchLike;
  /** Shorter for tests; 15 s is the production value. */
  timeoutMs?: number;
}

interface ContentsEntry {
  name?: string;
  type?: string;
}

interface ContentsFile {
  content?: string;
  encoding?: string;
  sha?: string;
  size?: number;
}

interface PutResponse {
  commit?: { html_url?: string } | null;
}

/** One path segment at a time: "Accounts/Acme Ltd" keeps the space encoded. */
function contentsUrl(repo: string, path: string): string {
  return `${API_URL}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Every path this client touches: a README under one of the three roots, whose
 * folder name is the one pattern a folder name may have. Checked before a
 * request, however the path was built, so no caller can escape the notes repo.
 */
const NOTE_PATH_RE = /^(Accounts|Partners|Events)\/[A-Za-z0-9][A-Za-z0-9 _-]{0,63}\/README\.md$/;

function checkPath(path: string): void {
  if (!NOTE_PATH_RE.test(path)) throw new Error(`notes: refusing the path ${JSON.stringify(path)}`);
}

export function createNotesClient(options: NotesOptions): NotesClient {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = (path: string): string => contentsUrl(options.repo, path);

  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    return fetchFn(url(path), {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** The body, or a throw that names the status: a caller never retries blindly. */
  async function json<T>(res: Response, what: string): Promise<T> {
    const body = await res.text();
    if (!res.ok) throw new Error(`${what}: GitHub API ${res.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body) as T;
  }

  async function listFolders(): Promise<string[]> {
    const folders: string[] = [];
    for (const root of NOTE_ROOTS) {
      const res = await request("GET", root);
      // A root the repo does not have yet is no folders, not an error.
      if (res.status === 404) continue;
      const entries = await json<unknown>(res, `list ${root}`);
      if (!Array.isArray(entries)) throw new Error(`list ${root}: unexpected response`);
      for (const entry of entries as ContentsEntry[]) {
        if (entry?.type !== "dir" || typeof entry.name !== "string") continue;
        // A name no write may use (a dot, a long name, ...) is never offered.
        if (!NOTE_PATH_RE.test(`${root}/${entry.name}/README.md`)) continue;
        folders.push(`${root}/${entry.name}`);
      }
    }
    return folders;
  }

  async function readFile(path: string): Promise<NotesFile | null> {
    checkPath(path);
    const res = await request("GET", path);
    if (res.status === 404) return null;
    const file = await json<ContentsFile>(res, `read ${path}`);
    if (typeof file.content !== "string" || typeof file.sha !== "string") {
      throw new Error(`read ${path}: the response holds no content`);
    }
    // Over the Contents API's limit the body comes back without the content; a
    // file that is not base64 text is not a README either. Writing blind would
    // destroy it, so this is a failure the caller can retry, never an overwrite.
    const size = typeof file.size === "number" ? file.size : 0;
    if (file.encoding !== "base64" || (size > 0 && file.content === "")) {
      throw new Error(`read ${path}: file too large for the Contents API`);
    }
    return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
  }

  async function writeFile(path: string, text: string, sha: string | null, message: string): Promise<string> {
    checkPath(path);
    const res = await request("PUT", path, {
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      ...(sha === null ? {} : { sha }),
    });
    if (res.status === 409 || res.status === 422) {
      const body = await res.text();
      throw new ShaConflict(`write ${path}: GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }
    const written = await json<PutResponse>(res, `write ${path}`);
    const commit = written.commit?.html_url;
    if (typeof commit !== "string") throw new Error(`write ${path}: the response holds no commit url`);
    return commit;
  }

  return { listFolders, readFile, writeFile };
}
