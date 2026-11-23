// GraphQL mapping: field names, refs, the closed -> Done rule, the draft item,
// the optional fields, the parent issue and the max updatedAt. One fake page, no
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
      { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Feature", field: { name: "Type" } },
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
            { __typename: "ProjectV2SingleSelectField", id: "F_TYPE", name: "Type", options: [{ id: "O_FEATURE", name: "Feature" }] },
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
    updatedAt: "2026-11-21T10:00:00Z", // the content is newer than the item
  });

  assert.equal(merged.ref, "notes#7");
  assert.equal(merged.status, "Done", "a merged pull request counts as Done");
  assert.equal(merged.updatedAt, "2026-11-19T00:00:00Z"); // the item is newer than the content

  assert.equal(draft.ref, "draft");
  assert.equal(draft.url, "https://github.com/users/rhapsody008/projects/1");
  assert.equal(draft.status, null);
  assert.equal(draft.target, null);
  assert.equal(draft.updatedAt, "2026-11-17T00:00:00Z");

  assert.equal(draft.parentUrl, null, "a draft has no parent issue");
  assert.equal(draft.type, null);
  assert.equal(merged.parentUrl, null, "a pull request has no parent issue");
});

test("the board query asks for 50 field values, the parent issue and names inside the union", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await createBoardClient("test-token", fakeFetch(calls)).fetchBoard("rhapsody008", 1);
  const body = JSON.parse(String(calls[0].init.body)) as { query: string };

  // 20 was not enough in production: an item carries about 20 values and the
  // extra ones are dropped silently.
  assert.ok(body.query.includes("fieldValues(first: 50)"), "50 field values");
  assert.ok(body.query.includes("parent { url }"), "the parent issue of an Issue");
  // A field selection on a union must sit inside an inline fragment on the
  // shared type, or the whole query fails.
  assert.ok(body.query.includes("... on ProjectV2FieldCommon { name }"), "field name inside the fragment");
});
