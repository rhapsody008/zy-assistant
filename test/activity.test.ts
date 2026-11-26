// The GitHub reads behind `zya yesterday`, without the network: the commits of a
// window and the note folders their files are in, and the comments of a window.
// Synthetic names only: "Acme", "Globex", "Offsite", "demo/notes".

import assert from "node:assert/strict";
import { test } from "node:test";
import { accountPath, commitsUrl, fetchIssueComments, fetchNotesCommits } from "../src/activity.ts";
import type { FetchLike } from "../src/github.ts";

/** Friday midnight to Monday midnight in Singapore: the window a Monday reports on. */
const SINCE = "2026-11-26T16:00:00.000Z";
const UNTIL = "2026-11-29T16:00:00.000Z";

const NOTES = "demo/notes";

const LIST_URL = `https://api.github.com/repos/${NOTES}/commits?since=${encodeURIComponent(SINCE)}&until=${encodeURIComponent(UNTIL)}&per_page=100`;

const commentsUrl = (repo: string, since = SINCE): string =>
  `https://api.github.com/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`;

/** One commit as the list carries it. */
function listed(sha: string, message = `Work ${sha}`, date = "2026-11-27T02:00:00.000Z"): Record<string, unknown> {
  return {
    sha,
    html_url: `https://github.com/${NOTES}/commit/${sha}`,
    commit: { message, committer: { date } },
  };
}

/** One commit as the detail call carries it: the files it changed. */
function detail(...files: string[]): Record<string, unknown> {
  return { files: files.map((filename) => ({ filename })) };
}

/** One comment as the comments list carries it. */
function comment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    html_url: "https://github.com/demo/notes/issues/70#issuecomment-1",
    issue_url: "https://api.github.com/repos/demo/notes/issues/70",
    created_at: "2026-11-27T03:00:00.000Z",
    body: "looks good",
    user: { login: "octocat" },
    ...over,
  };
}

/** A fetch that answers each url from a table, and records what was asked for. */
function fakeFetch(routes: Record<string, unknown>): { fetchFn: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    assert.ok(url in routes, `no fake answer for ${url}`);
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  };
  return { fetchFn, urls };
}

test("an Account with a space keeps the space, encoded, as one folder", () => {
  assert.equal(accountPath("Acme Ltd"), "Accounts/Acme%20Ltd");
  assert.equal(accountPath("Acme"), "Accounts/Acme");
});

test("the commits URL asks for one Account's folder since one instant", () => {
  const url = commitsUrl("demo/notes", "Acme Ltd", "2026-11-25T01:00:00.000Z");
  assert.equal(
    url,
    "https://api.github.com/repos/demo/notes/commits?path=Accounts/Acme%20Ltd&since=2026-11-25T01%3A00%3A00.000Z&per_page=100",
  );
});

test("a window's commits come back with the note folders their files are in", async () => {
  const { fetchFn, urls } = fakeFetch({
    [LIST_URL]: [listed("aaa1", `Acme: sizing sent` + "\n\nand the deck on Friday")],
    [`https://api.github.com/repos/${NOTES}/commits/aaa1`]: detail(
      "README.md", // the repo's own, no folder
      "Accounts/README.md", // a root's own file, not a note's
      "Accounts/Acme/2026-11-27.md",
      "Accounts/Acme/README.md",
      "Accounts/Acme/2026-11-27.md", // one folder, however many files
      "Partners/Globex/README.md",
      "Events/Offsite/agenda.md",
      "Elsewhere/Acme/README.md", // not one of the three roots
    ),
  });

  const commits = await fetchNotesCommits({ token: "test-token", repo: NOTES, since: SINCE, until: UNTIL, fetchFn });

  assert.deepEqual(urls, [LIST_URL, `https://api.github.com/repos/${NOTES}/commits/aaa1`], "the window is asked for by name");
  assert.deepEqual(commits, {
    commits: [
      {
        sha: "aaa1",
        // The subject, and only the subject: a report line is a line.
        message: "Acme: sizing sent",
        date: "2026-11-27T02:00:00.000Z",
        url: `https://github.com/${NOTES}/commit/aaa1`,
        folders: ["Accounts/Acme", "Events/Offsite", "Partners/Globex"],
      },
    ],
    truncated: false,
  });
});

test("a full page of commits is cut: the first 30 are opened, and the answer says so", async () => {
  const shas = Array.from({ length: 40 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const routes: Record<string, unknown> = { [LIST_URL]: shas.map((sha) => listed(sha)) };
  for (const sha of shas) routes[`https://api.github.com/repos/${NOTES}/commits/${sha}`] = detail("Accounts/Acme/README.md");

  const { fetchFn, urls } = fakeFetch(routes);
  const window = await fetchNotesCommits({ token: "t", repo: NOTES, since: SINCE, until: UNTIL, fetchFn });

  assert.equal(urls.length, 31, "one list call and thirty commits opened");
  assert.deepEqual(window.commits.map((commit) => commit.sha), shas.slice(0, 30));
  assert.equal(window.truncated, true, "40 commits in the window, 30 in the report");
});

test("a page of exactly one hundred commits is read as far as it is opened", async () => {
  const shas = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, "0")}`);
  const routes: Record<string, unknown> = { [LIST_URL]: shas.map((sha) => listed(sha)) };
  for (const sha of shas) routes[`https://api.github.com/repos/${NOTES}/commits/${sha}`] = detail("Partners/Globex/README.md");

  const { fetchFn, urls } = fakeFetch(routes);
  const window = await fetchNotesCommits({ token: "t", repo: NOTES, since: SINCE, until: UNTIL, fetchFn });

  assert.equal(urls.length, 31, "one list call and thirty commits opened, not a hundred");
  assert.equal(window.commits.length, 30);
  assert.equal(window.truncated, true);
});

test("a window with few commits is the whole window, and asks no second page", async () => {
  const { fetchFn, urls } = fakeFetch({
    [LIST_URL]: [listed("bbb2")],
    [`https://api.github.com/repos/${NOTES}/commits/bbb2`]: { files: [] },
  });
  const window = await fetchNotesCommits({ token: "t", repo: NOTES, since: SINCE, until: UNTIL, fetchFn });

  assert.deepEqual(urls, [LIST_URL, `https://api.github.com/repos/${NOTES}/commits/bbb2`]);
  assert.deepEqual(window, {
    commits: [{ sha: "bbb2", message: "Work bbb2", date: "2026-11-27T02:00:00.000Z", url: `https://github.com/${NOTES}/commit/bbb2`, folders: [] }],
    truncated: false,
  });
});

test("the comments are asked for once per repo, from the window's start", async () => {
  const { fetchFn, urls } = fakeFetch({
    [commentsUrl("demo/notes")]: [comment()],
    [commentsUrl("acme/demo")]: [comment({ issue_url: "https://api.github.com/repos/acme/demo/issues/3", html_url: "https://github.com/acme/demo/issues/3#issuecomment-9" })],
  });

  const comments = await fetchIssueComments({ token: "t", repos: ["demo/notes", "acme/demo"], since: SINCE, until: UNTIL, fetchFn });

  assert.deepEqual(urls, [commentsUrl("demo/notes"), commentsUrl("acme/demo")]);
  assert.deepEqual(comments, [
    {
      issueUrl: "https://api.github.com/repos/demo/notes/issues/70",
      author: "octocat",
      createdAt: "2026-11-27T03:00:00.000Z",
      body: "looks good",
      url: "https://github.com/demo/notes/issues/70#issuecomment-1",
    },
    {
      issueUrl: "https://api.github.com/repos/acme/demo/issues/3",
      author: "octocat",
      createdAt: "2026-11-27T03:00:00.000Z",
      body: "looks good",
      url: "https://github.com/acme/demo/issues/3#issuecomment-9",
    },
  ]);
});

test("a comment created before the window is left out, even when it was edited inside it", async () => {
  const long = "x".repeat(600);
  const { fetchFn } = fakeFetch({
    [commentsUrl("demo/notes")]: [
      comment({ body: long }),
      comment({ created_at: "2026-11-28T01:00:00.000Z", html_url: "u-in" }), // Sunday 09:00 in Singapore
      comment({ created_at: UNTIL, html_url: "u-edged" }), // exactly midnight Monday: the window's end
      comment({ created_at: "2026-11-29T20:00:00.000Z", html_url: "u-after" }),
      // Edited inside the window, written the week before: `since` lists it, and the
      // report is about what was written yesterday, not about what was touched.
      comment({ created_at: "2026-11-20T01:00:00.000Z", html_url: "u-edited" }),
      comment({ created_at: SINCE, html_url: "u-since" }), // the window's first moment
    ],
  });

  const comments = await fetchIssueComments({ token: "t", repos: ["demo/notes"], since: SINCE, until: UNTIL, fetchFn });

  assert.deepEqual(
    comments.map((c) => c.url),
    ["https://github.com/demo/notes/issues/70#issuecomment-1", "u-in", "u-since"],
  );
  assert.equal(comments[0].body.length, 500, "a pasted thread is a line, not a page");
});

test("a failed read throws with the status and what was being read, and never the token", async () => {
  const fetchFn: FetchLike = async () => new Response("boom", { status: 500 });

  await assert.rejects(
    fetchIssueComments({ token: "ghp_secret_value", repos: ["demo/notes"], since: SINCE, until: UNTIL, fetchFn }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message, "comments of demo/notes: GitHub API 500: boom");
      assert.ok(!message.includes("ghp_secret_value"));
      return true;
    },
  );
});
