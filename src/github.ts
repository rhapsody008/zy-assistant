// GitHub Project v2 over GraphQL. Fields are mapped by NAME (src/schema.ts is
// the one place those names live), never by id, so a board view can be rebuilt
// without touching the code.

import type { Item } from "./rules.ts";
import { ALL_FIELDS, STATUS, type FieldSpec, type ItemField } from "./schema.ts";
import { latestIso } from "./time.ts";

export interface BoardField {
  id: string;
  options?: Map<string, string>; // option name -> option id (single select fields)
}

export interface Board {
  projectId: string;
  title: string;
  fields: Map<string, BoardField>;
  items: Item[];
}

export interface BoardSource {
  fetchBoard(owner: string, number: number): Promise<Board>;
  setDate(projectId: string, itemId: string, fieldId: string, date: string): Promise<void>;
  setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void>;
  /** Comments on an issue: subjectId is the Issue node id (Item.contentId). */
  addComment(subjectId: string, body: string): Promise<void>;
}

/**
 * The writes a proposal's Apply needs, on top of the board read. Separate from
 * BoardSource because every existing fake implements that read, and only the
 * proposal machinery ever writes an issue.
 */
export interface IssueWriter {
  /** Creates an issue and returns the node id, the number and the url. */
  createIssue(repo: string, title: string, body: string): Promise<{ id: string; number: number; url: string }>;
  /**
   * The newest issue of the repo whose body carries the marker, or null: what a
   * create whose answer never arrived is found by, so a retry adopts it instead
   * of writing a second one.
   */
  findIssue(repo: string, marker: string): Promise<{ id: string; number: number; url: string } | null>;
  /** Adds the issue to the project and returns the project item's id. */
  addToProject(projectId: string, contentId: string): Promise<string>;
  /** Writes a text field (Next action, Waiting on, ...). */
  setText(projectId: string, itemId: string, fieldId: string, text: string): Promise<void>;
  /** Makes `subIssueId` a sub-issue of the parent issue `issueId`. */
  addSubIssue(issueId: string, subIssueId: string): Promise<void>;
}

/** How many issues one lookup reads: the newest page is where a fresh issue is. */
const LOOKUP_MAX = 100;

const API_URL = "https://api.github.com/graphql";
const ISSUES_URL = "https://api.github.com/repos";

/** One write may not take longer than this: the card waits for the answer. */
const REQUEST_TIMEOUT_MS = 15_000;

/** owner/repo, the shape the issues url is built from (config.ts's NOTES_REPO_RE). */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Injectable so tests never touch the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const BOARD_QUERY = `
query Board($owner: String!, $number: Int!, $cursor: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      title
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          updatedAt
          fieldValues(first: 50) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content {
            __typename
            ... on Issue { id number title url state updatedAt repository { name } parent { url } }
            ... on PullRequest { number title url state updatedAt repository { name } }
            ... on DraftIssue { title updatedAt }
          }
        }
      }
    }
  }
}`;

const SET_DATE = `
mutation SetDate($project: ID!, $item: ID!, $field: ID!, $date: Date!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { date: $date } }) {
    projectV2Item { id }
  }
}`;

const SET_SINGLE_SELECT = `
mutation SetSingleSelect($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
    projectV2Item { id }
  }
}`;

const ADD_COMMENT = `
mutation AddComment($subject: ID!, $body: String!) {
  addComment(input: { subjectId: $subject, body: $body }) {
    commentEdge { node { id } }
  }
}`;

// Called even though the issue may already be in the project: when the content
// is in it, this returns the existing item rather than failing, so a retry that
// lost the answer to this very call still learns the item's id. The caller's own
// fallback is for the other two cases: a response lost in flight, and a
// project's workflow that added the issue first and left this call refused.
const ADD_TO_PROJECT = `
mutation AddToProject($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;

const SET_TEXT = `
mutation SetText($project: ID!, $item: ID!, $field: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { text: $text } }) { projectV2Item { id } }
}`;

const ADD_SUB_ISSUE = `
mutation AddSubIssue($issue: ID!, $subIssue: ID!) {
  addSubIssue(input: { issueId: $issue, subIssueId: $subIssue }) { issue { id } subIssue { id } }
}`;

interface RawField {
  __typename?: string;
  id?: string;
  name?: string;
  options?: Array<{ id?: string; name?: string }> | null;
}

interface RawValue {
  __typename?: string;
  name?: string | null;
  date?: string | null;
  text?: string | null;
  field?: { name?: string } | null;
}

interface RawContent {
  __typename?: string;
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  repository?: { name?: string } | null;
  parent?: { url?: string } | null;
}

interface RawItem {
  id?: string;
  updatedAt?: string;
  fieldValues?: { nodes?: RawValue[] } | null;
  content?: RawContent | null;
}

interface RawProject {
  id?: string;
  title?: string;
  fields?: { nodes?: RawField[] } | null;
  items?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null; nodes?: RawItem[] } | null;
}

interface RawQuery {
  user?: { projectV2?: RawProject | null } | null;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

/** The REST issue the create call returns; only these three fields are read. */
interface RawCreatedIssue {
  node_id?: string;
  number?: number;
  html_url?: string;
}

/** One issue of the list a lookup reads: a pull request carries `pull_request`. */
interface RawListedIssue {
  node_id?: string;
  number?: number;
  html_url?: string;
  body?: string | null;
  pull_request?: unknown;
}

interface RawAddToProject {
  addProjectV2ItemById?: { item?: { id?: string } | null } | null;
}

interface RawAddSubIssue {
  addSubIssue?: { issue?: { id?: string } | null; subIssue?: { id?: string } | null } | null;
}

const projectUrl = (owner: string, number: number): string => `https://github.com/users/${owner}/projects/${number}`;

function mapItem(raw: RawItem, fallbackUrl: string): Item | null {
  const content = raw.content;
  if (!content) return null;

  const values: Partial<Record<ItemField, string | null>> = {};
  for (const value of raw.fieldValues?.nodes ?? []) {
    const name = value.field?.name;
    if (!name) continue;
    const spec = ALL_FIELDS.find((f) => f.name === name);
    if (spec) values[spec.item] = fieldValue(spec, value);
  }

  const closed = content.state === "CLOSED" || content.state === "MERGED";
  const draft = content.__typename === "DraftIssue";
  return {
    id: raw.id ?? "",
    ref: draft ? "draft" : `${content.repository?.name ?? "?"}#${content.number ?? "?"}`,
    title: content.title ?? "",
    url: draft ? fallbackUrl : content.url ?? fallbackUrl,
    status: closed ? STATUS.done : values.status ?? null,
    target: values.target ?? null,
    nextTouch: values.nextTouch ?? null,
    nextAction: values.nextAction ?? null,
    waitingOn: values.waitingOn ?? null,
    type: values.type ?? null,
    stage: values.stage ?? null,
    track: values.track ?? null,
    account: values.account ?? null,
    cadence: values.cadence ?? null,
    parentUrl: content.parent?.url ?? null,
    // Only an Issue is a comment subject: a pull request or a draft has none.
    contentId: content.__typename === "Issue" ? content.id ?? null : null,
    updatedAt: latestIso(raw.updatedAt, content.updatedAt) ?? "",
  };
}

/** One field value as the response carries it. */
function fieldValue(spec: FieldSpec, value: RawValue): string | null {
  switch (spec.kind) {
    case "singleSelect":
      return value.__typename === "ProjectV2ItemFieldSingleSelectValue" ? value.name ?? null : null;
    case "date":
      return value.date ?? null;
    case "text":
      return value.text ?? null;
    case "any":
      return value.name ?? value.text ?? null;
  }
}

export function createBoardClient(token: string, fetchFn: FetchLike = fetch): BoardSource & IssueWriter {
  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchFn(API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      // A hung write has to fail the click: without this the card stays in
      // `applying` until the process is restarted, and the row with it.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    const parsed = JSON.parse(body) as GraphQLResponse<T>;
    if (parsed.errors && parsed.errors.length > 0) {
      throw new Error(`GitHub GraphQL: ${parsed.errors.map((e) => e.message ?? "unknown error").join("; ")}`);
    }
    if (!parsed.data) throw new Error("GitHub GraphQL: empty response");
    return parsed.data;
  }

  async function fetchBoard(owner: string, number: number): Promise<Board> {
    const url = projectUrl(owner, number);
    const items: Item[] = [];
    const fields = new Map<string, BoardField>();
    let projectId = "";
    let title = "";
    let cursor: string | null = null;

    for (;;) {
      const data: RawQuery = await graphql<RawQuery>(BOARD_QUERY, { owner, number, cursor });
      const page: RawProject | null = data.user?.projectV2 ?? null;
      if (!page) throw new Error(`GitHub project not found: ${owner} project ${number}`);
      projectId = page.id ?? "";
      title = page.title ?? "";

      if (fields.size === 0) {
        for (const field of page.fields?.nodes ?? []) {
          if (!field.id || !field.name) continue;
          const options = field.options?.filter((o) => o.id && o.name).map((o) => [o.name ?? "", o.id ?? ""] as const);
          fields.set(field.name, options ? { id: field.id, options: new Map(options) } : { id: field.id });
        }
      }

      for (const raw of page.items?.nodes ?? []) {
        const item = mapItem(raw, url);
        if (item) items.push(item);
      }

      const info = page.items?.pageInfo;
      if (!info?.hasNextPage) break;
      cursor = info.endCursor ?? null;
      if (!cursor) break;
    }

    return { projectId, title, fields, items };
  }

  async function setDate(projectId: string, itemId: string, fieldId: string, date: string): Promise<void> {
    await graphql(SET_DATE, { project: projectId, item: itemId, field: fieldId, date });
  }

  async function setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await graphql(SET_SINGLE_SELECT, { project: projectId, item: itemId, field: fieldId, option: optionId });
  }

  async function addComment(subjectId: string, body: string): Promise<void> {
    await graphql(ADD_COMMENT, { subject: subjectId, body });
  }

  async function createIssue(repo: string, title: string, body: string): Promise<{ id: string; number: number; url: string }> {
    // Checked before the request, so a mistyped ADD_REPO names itself instead of
    // building a url nobody can read.
    if (!REPO_RE.test(repo)) throw new Error(`createIssue: refusing the repo ${JSON.stringify(repo)}`);
    const res = await fetchFn(`${ISSUES_URL}/${repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The body, or a throw that names the status: this is what the card shows, and
    // it never carries the token, which only ever sits in a header.
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
    const issue = JSON.parse(text) as RawCreatedIssue;
    if (typeof issue.node_id !== "string") throw new Error("createIssue: the response holds no node_id");
    if (typeof issue.number !== "number") throw new Error("createIssue: the response holds no number");
    if (typeof issue.html_url !== "string") throw new Error("createIssue: the response holds no html_url");
    return { id: issue.node_id, number: issue.number, url: issue.html_url };
  }

  async function findIssue(repo: string, marker: string): Promise<{ id: string; number: number; url: string } | null> {
    // The same guard as the create, for the same reason: a mistyped ADD_REPO
    // names itself instead of building a url nobody can read.
    if (!REPO_RE.test(repo)) throw new Error(`findIssue: refusing the repo ${JSON.stringify(repo)}`);
    const query = `state=all&sort=created&direction=desc&per_page=${LOOKUP_MAX}`;
    const res = await fetchFn(`${ISSUES_URL}/${repo}/issues?${query}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    // A repo with no Issues at all answers 404, which is "not found", not a failure.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
    const listed = JSON.parse(text) as RawListedIssue[];
    if (!Array.isArray(listed)) throw new Error("findIssue: the response holds no list of issues");
    for (const issue of listed) {
      // The issues endpoint lists pull requests too, and one of them is no issue to adopt.
      if (issue.pull_request !== undefined) continue;
      if (typeof issue.body !== "string" || !issue.body.includes(marker)) continue;
      if (typeof issue.node_id !== "string" || typeof issue.number !== "number" || typeof issue.html_url !== "string") {
        throw new Error("findIssue: the matched issue holds no node_id, number or html_url");
      }
      return { id: issue.node_id, number: issue.number, url: issue.html_url };
    }
    return null;
  }

  async function addToProject(projectId: string, contentId: string): Promise<string> {
    const data = await graphql<RawAddToProject>(ADD_TO_PROJECT, { project: projectId, content: contentId });
    const id = data.addProjectV2ItemById?.item?.id;
    if (typeof id !== "string") throw new Error("addProjectV2ItemById: the response holds no item id");
    return id;
  }

  async function setText(projectId: string, itemId: string, fieldId: string, text: string): Promise<void> {
    await graphql(SET_TEXT, { project: projectId, item: itemId, field: fieldId, text });
  }

  async function addSubIssue(issueId: string, subIssueId: string): Promise<void> {
    const data = await graphql<RawAddSubIssue>(ADD_SUB_ISSUE, { issue: issueId, subIssue: subIssueId });
    // The link is the sub-issue's id: a response without it did not make one.
    if (typeof data.addSubIssue?.subIssue?.id !== "string") {
      throw new Error("addSubIssue: the response holds no subIssue id");
    }
  }

  return { fetchBoard, setDate, setSingleSelect, addComment, createIssue, findIssue, addToProject, setText, addSubIssue };
}
