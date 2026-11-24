// GraphQL mapping: field names, refs, the closed -> Done rule, the draft item,
// the optional fields, the parent issue and the max updatedAt; then the writes a
// proposal's Apply makes, the one REST create included. One fake page, no
// network. Synthetic board: "Acme" and the repo "demo".

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardClient, type FetchLike } from "../src/github.ts";

const ISSUE = {
  id: "ITEM_1",
  updatedAt: "2026-11-20T10:00:00Z",
  fieldValues: {
    nodes: [
      { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In progress", field: { name: "Status" } },
      { __typename: "ProjectV2ItemFieldDateValue", date: "2026-11-26", field: { name: "Target date" } },
      { __typename: "ProjectV2ItemFieldDateValue", date: "2026-11-25", field: { name: "Next touch" } },
      { __typename: "ProjectV2ItemFieldTextValue", text: "write the draft", field: { name: "Next action" } },
      { __typename: "ProjectV2ItemFieldTextValue", text: "answers from design", field: { name: "Waiting on" } },
      { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Feature", field: { name: "Work type" } },
      { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Build", field: { name: "Stage" } },
      { __typename: "ProjectV2ItemFieldTextValue", text: "demo", field: { name: "Track" } },
      { __typename: "ProjectV2ItemFieldTextValue", text: "Acme", field: { name: "Account" } },
      { __typename: "ProjectV2ItemFieldTextValue", text: "weekly", field: { name: "Cadence" } },
      // A field the bot does not map must be ignored, not break the item.
      { __typename: "ProjectV2ItemFieldTextValue", text: "ignore me", field: { name: "Notes" } },
    ],
  },
  content: {
    __typename: "Issue",
    id: "I_12",
    number: 12,
    title: "An issue",
    url: "https://github.com/rhapsody008/notes/issues/12",
    state: "OPEN",
    updatedAt: "2026-11-21T10:00:00Z",
    repository: { name: "notes" },
    parent: { url: "https://github.com/rhapsody008/notes/issues/9" },
  },
};

const CLOSED_PULL_REQUEST = {
  id: "ITEM_2",
  updatedAt: "2026-11-19T00:00:00Z",
  fieldValues: {
    nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In progress", field: { name: "Status" } }],
  },
  content: {
    __typename: "PullRequest",
    id: "I_7",
    number: 7,
    title: "A pull request",
    url: "https://github.com/rhapsody008/notes/pull/7",
    state: "MERGED",
    updatedAt: "2026-11-18T00:00:00Z",
    repository: { name: "notes" },
  },
};

const DRAFT = {
  id: "ITEM_3",
  updatedAt: "2026-11-17T00:00:00Z",
  fieldValues: { nodes: [] },
  content: { __typename: "DraftIssue", title: "A draft" },
};

const PAGE = {
  data: {
    user: {
      projectV2: {
        id: "PVT_1",
        title: "ZY board",
        fields: {
          nodes: [
            {
              __typename: "ProjectV2SingleSelectField",
              id: "F_STATUS",
              name: "Status",
              options: [
                { id: "O_TODO", name: "Todo" },
                { id: "O_PROGRESS", name: "In progress" },
                { id: "O_DONE", name: "Done" },
              ],
            },
            { __typename: "ProjectV2Field", id: "F_TARGET", name: "Target date" },
            { __typename: "ProjectV2Field", id: "F_TOUCH", name: "Next touch" },
            { __typename: "ProjectV2Field", id: "F_ACTION", name: "Next action" },
            { __typename: "ProjectV2Field", id: "F_WAITING", name: "Waiting on" },
            { __typename: "ProjectV2SingleSelectField", id: "F_TYPE", name: "Work type", options: [{ id: "O_FEATURE", name: "Feature" }] },
            { __typename: "ProjectV2SingleSelectField", id: "F_STAGE", name: "Stage", options: [{ id: "O_BUILD", name: "Build" }] },
            { __typename: "ProjectV2Field", id: "F_TRACK", name: "Track" },
            { __typename: "ProjectV2Field", id: "F_ACCOUNT", name: "Account" },
            { __typename: "ProjectV2Field", id: "F_CADENCE", name: "Cadence" },
          ],
        },
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [ISSUE, CLOSED_PULL_REQUEST, DRAFT],
        },
      },
    },
  },
};

function fakeFetch(calls: Array<{ url: string; init: RequestInit }>): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(PAGE), { status: 200 });
  };
}

test("maps field names, item content and the closed rule", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const board = createBoardClient("test-token", fakeFetch(calls));
  const result = await board.fetchBoard("rhapsody008", 1);

  assert.equal(calls.length, 1, "a single page means a single request");
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer test-token");

  assert.equal(result.projectId, "PVT_1");
  assert.equal(result.title, "ZY board");

  const status = result.fields.get("Status");
  assert.ok(status);
  assert.equal(status.id, "F_STATUS");
  assert.equal(status.options?.get("Done"), "O_DONE");
  assert.equal(status.options?.get("In progress"), "O_PROGRESS");
  assert.equal(result.fields.get("Target date")?.id, "F_TARGET");
  assert.equal(result.fields.get("Next touch")?.id, "F_TOUCH");
  assert.equal(result.fields.get("Next action")?.id, "F_ACTION");
  assert.equal(result.fields.get("Waiting on")?.id, "F_WAITING");
  assert.equal(result.fields.get("Target date")?.options, undefined);

  assert.equal(result.items.length, 3);
  const [issue, merged, draft] = result.items;

  assert.deepEqual(issue, {
    id: "ITEM_1",
    ref: "notes#12",
    title: "An issue",
    url: "https://github.com/rhapsody008/notes/issues/12",
    status: "In progress",
    target: "2026-11-26",
    nextTouch: "2026-11-25",
    nextAction: "write the draft",
    waitingOn: "answers from design",
    type: "Feature",
    stage: "Build",
    track: "demo",
    account: "Acme",
    cadence: "weekly",
    parentUrl: "https://github.com/rhapsody008/notes/issues/9",
    contentId: "I_12", // the Issue node id a comment can go to
    updatedAt: "2026-11-21T10:00:00Z", // the content is newer than the item
  });

  assert.equal(merged.ref, "notes#7");
  assert.equal(merged.status, "Done", "a merged pull request counts as Done");
  assert.equal(merged.updatedAt, "2026-11-19T00:00:00Z"); // the item is newer than the content
  assert.equal(merged.contentId, null, "only an Issue is a comment subject");

  assert.equal(draft.ref, "draft");
  assert.equal(draft.url, "https://github.com/users/rhapsody008/projects/1");
  assert.equal(draft.status, null);
  assert.equal(draft.target, null);
  assert.equal(draft.updatedAt, "2026-11-17T00:00:00Z");

  assert.equal(draft.parentUrl, null, "a draft has no parent issue");
  assert.equal(draft.contentId, null, "a draft has nothing to comment on");
  assert.equal(draft.type, null);
  assert.equal(merged.parentUrl, null, "a pull request has no parent issue");
});

test("the board query asks for 50 field values, the parent issue, the issue id and names inside the union", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await createBoardClient("test-token", fakeFetch(calls)).fetchBoard("rhapsody008", 1);
  const body = JSON.parse(String(calls[0].init.body)) as { query: string };

  // 20 was not enough in production: an item carries about 20 values and the
  // extra ones are dropped silently.
  assert.ok(body.query.includes("fieldValues(first: 50)"), "50 field values");
  assert.ok(body.query.includes("parent { url }"), "the parent issue of an Issue");
  // The Issue node id is what a comment is posted to.
  assert.ok(body.query.includes("... on Issue { id number title"), "the issue id, inside its fragment");
  // A field selection on a union must sit inside an inline fragment on the
  // shared type, or the whole query fails.
  assert.ok(body.query.includes("... on ProjectV2FieldCommon { name }"), "field name inside the fragment");
});

test("addComment posts the issue's node id and the body to the addComment mutation", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const board = createBoardClient("test-token", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { addComment: { commentEdge: { node: { id: "IC_1" } } } } }), { status: 200 });
  });

  await board.addComment("I_12", "Target date moved 2026-11-25 → 2026-12-02 by zy-assistant: the workshop moved");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer test-token");
  const body = JSON.parse(String(calls[0].init.body)) as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /mutation AddComment\(\$subject: ID!, \$body: String!\)/);
  assert.match(body.query, /addComment\(input: \{ subjectId: \$subject, body: \$body \}\)/);
  assert.deepEqual(body.variables, {
    subject: "I_12",
    body: "Target date moved 2026-11-25 → 2026-12-02 by zy-assistant: the workshop moved",
  });
});

test("a failed addComment is an error, not a silent drop", async () => {
  const board = createBoardClient("test-token", async () =>
    new Response(JSON.stringify({ errors: [{ message: "Could not resolve to a node" }] }), { status: 200 }),
  );
  await assert.rejects(() => board.addComment("I_12", "body"), /GitHub GraphQL: Could not resolve to a node/);
});

interface WriteCall {
  url: string;
  init: RequestInit;
}

/** A fake GitHub answering every call with one canned response. */
function fakeAnswer(status: number, body: unknown): { calls: WriteCall[]; fetchFn: FetchLike } {
  const calls: WriteCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

/** The query and variables of a write call, as the client sent them. */
function sentGraphQL(call: WriteCall): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(call.init.body)) as { query: string; variables: Record<string, unknown> };
}

test("createIssue posts the title and the body to the repo's issues and returns the node id, the number and the url", async () => {
  const { calls, fetchFn } = fakeAnswer(201, {
    node_id: "I_31",
    number: 31,
    html_url: "https://github.com/demo/notes/issues/31",
  });

  const created = await createBoardClient("test-token", fetchFn).createIssue(
    "demo/notes",
    "Chase Acme on the renewal",
    "Next action: chase Acme by 2026-12-02",
  );

  assert.deepEqual(created, { id: "I_31", number: 31, url: "https://github.com/demo/notes/issues/31" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/demo/notes/issues");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    authorization: "Bearer test-token",
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    title: "Chase Acme on the renewal",
    body: "Next action: chase Acme by 2026-12-02",
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every call carries a timeout");
});

test("a failed createIssue throws the status and 200 characters of the body, and never the token", async () => {
  const failure = JSON.stringify({ message: `Resource not accessible by integration ${"x".repeat(300)}` });
  const { fetchFn } = fakeAnswer(403, failure);

  const error = await createBoardClient("test-token", fetchFn).createIssue("demo/notes", "A title", "A body").then(
    () => assert.fail("a 403 is not a silent success"),
    (e: Error) => e,
  );
  assert.equal(error.message, `GitHub API 403: ${failure.slice(0, 200)}`, "the card gets the status and the body, cut short");
  assert.ok(!error.message.includes("test-token"), "the token is in a header only, never in what the card shows");
});

test("createIssue throws when the response holds no node id", async () => {
  const { fetchFn } = fakeAnswer(201, { number: 31, html_url: "https://github.com/demo/notes/issues/31" });

  await assert.rejects(
    () => createBoardClient("test-token", fetchFn).createIssue("demo/notes", "A title", "A body"),
    /createIssue: the response holds no node_id/,
  );
});

test("createIssue refuses a repo that is not owner/repo before any request", async () => {
  const { calls, fetchFn } = fakeAnswer(201, { node_id: "I_31", number: 31, html_url: "https://github.com/demo/notes/issues/31" });

  await assert.rejects(
    () => createBoardClient("test-token", fetchFn).createIssue("demo", "A title", "A body"),
    /createIssue: refusing the repo "demo"/,
  );
  assert.equal(calls.length, 0, "a mistyped repo never reaches GitHub");
});

test("findIssue reads the newest issues of the repo and returns the one whose body carries the marker", async () => {
  const listed = [
    { node_id: "I_40", number: 40, html_url: "https://github.com/demo/notes/issues/40", body: "no marker here" },
    // The issues endpoint lists pull requests too, and one of them is no issue to adopt.
    { node_id: "I_41", number: 41, html_url: "https://github.com/demo/notes/pull/41", body: "x", pull_request: { url: "u" } },
    {
      node_id: "I_42",
      number: 42,
      html_url: "https://github.com/demo/notes/issues/42",
      body: "```text\ncall Dana\n```\n\n_Added by zy-assistant from Slack on 2026-11-25._\n<!-- zy-assistant:add:1700.1 -->",
    },
  ];
  const { calls, fetchFn } = fakeAnswer(200, listed);

  const found = await createBoardClient("test-token", fetchFn).findIssue("demo/notes", "add:1700.1");

  assert.deepEqual(found, { id: "I_42", number: 42, url: "https://github.com/demo/notes/issues/42" });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/demo/notes/issues?state=all&sort=created&direction=desc&per_page=100",
    "the newest issues first, the ones already in the project included",
  );
  assert.equal(calls[0].init.method, undefined, "a read, not a write");
  assert.deepEqual(calls[0].init.headers, {
    authorization: "Bearer test-token",
    accept: "application/vnd.github+json",
  });
  assert.ok(calls[0].init.signal instanceof AbortSignal, "a lookup carries the same timeout");
});

test("findIssue is null when no issue carries the marker or the repo answers 404", async () => {
  const none = fakeAnswer(200, [
    { node_id: "I_40", number: 40, html_url: "u", body: "no marker here" },
    { node_id: "I_41", number: 41, html_url: "u", body: null },
  ]);
  assert.equal(await createBoardClient("test-token", none.fetchFn).findIssue("demo/notes", "add:1700.1"), null);

  const missing = fakeAnswer(404, { message: "Not Found" });
  assert.equal(
    await createBoardClient("test-token", missing.fetchFn).findIssue("demo/notes", "add:1700.1"),
    null,
    "a 404 is a repo with no such issue, not a failure",
  );
});

test("findIssue refuses a repo that is not owner/repo before any request", async () => {
  const { calls, fetchFn } = fakeAnswer(200, []);

  await assert.rejects(
    () => createBoardClient("test-token", fetchFn).findIssue("demo", "add:1700.1"),
    /findIssue: refusing the repo "demo"/,
  );
  assert.equal(calls.length, 0, "a mistyped repo never reaches GitHub");
});

test("addToProject sends the project and the content ids to addProjectV2ItemById and returns the item id", async () => {
  const { calls, fetchFn } = fakeAnswer(200, { data: { addProjectV2ItemById: { item: { id: "ITEM_31" } } } });

  const itemId = await createBoardClient("test-token", fetchFn).addToProject("PVT_1", "I_31");

  assert.equal(itemId, "ITEM_31");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer test-token");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "a mutation that hangs fails the click instead of freezing the card");
  const body = sentGraphQL(calls[0]);
  assert.match(body.query, /mutation AddToProject\(\$project: ID!, \$content: ID!\)/);
  assert.match(body.query, /addProjectV2ItemById\(input: \{ projectId: \$project, contentId: \$content \}\)/);
  assert.deepEqual(body.variables, { project: "PVT_1", content: "I_31" });
});

test("setText writes a text field with the SetText mutation", async () => {
  const { calls, fetchFn } = fakeAnswer(200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_31" } } } });

  await createBoardClient("test-token", fetchFn).setText("PVT_1", "ITEM_31", "F_ACTION", "chase Acme");

  assert.equal(calls.length, 1);
  const body = sentGraphQL(calls[0]);
  assert.match(body.query, /mutation SetText\(\$project: ID!, \$item: ID!, \$field: ID!, \$text: String!\)/);
  assert.match(
    body.query,
    /updateProjectV2ItemFieldValue\(input: \{ projectId: \$project, itemId: \$item, fieldId: \$field, value: \{ text: \$text \} \}\)/,
  );
  assert.deepEqual(body.variables, { project: "PVT_1", item: "ITEM_31", field: "F_ACTION", text: "chase Acme" });
});

test("addSubIssue links the new issue to its parent engagement issue", async () => {
  const { calls, fetchFn } = fakeAnswer(200, { data: { addSubIssue: { issue: { id: "I_9" }, subIssue: { id: "I_31" } } } });

  await createBoardClient("test-token", fetchFn).addSubIssue("I_9", "I_31");

  assert.equal(calls.length, 1);
  const body = sentGraphQL(calls[0]);
  assert.match(body.query, /mutation AddSubIssue\(\$issue: ID!, \$subIssue: ID!\)/);
  assert.match(body.query, /addSubIssue\(input: \{ issueId: \$issue, subIssueId: \$subIssue \}\)/);
  assert.deepEqual(body.variables, { issue: "I_9", subIssue: "I_31" });
});

test("a write whose response holds no value is an error, not a silent success", async () => {
  const boardOf = (payload: unknown) => createBoardClient("test-token", fakeAnswer(200, { data: payload }).fetchFn);

  await assert.rejects(
    () => boardOf({ addProjectV2ItemById: { item: null } }).addToProject("PVT_1", "I_31"),
    /addProjectV2ItemById: the response holds no item id/,
  );
  await assert.rejects(
    () => boardOf({ addSubIssue: { issue: { id: "I_9" }, subIssue: null } }).addSubIssue("I_9", "I_31"),
    /addSubIssue: the response holds no subIssue id/,
  );
});

test("a GraphQL errors array still throws through a write", async () => {
  const { fetchFn } = fakeAnswer(200, { errors: [{ message: "Could not resolve to a node with the global id of 'I_31'" }] });

  await assert.rejects(
    () => createBoardClient("test-token", fetchFn).addToProject("PVT_1", "I_31"),
    /GitHub GraphQL: Could not resolve to a node/,
  );
});
