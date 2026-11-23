// GitHub Project v2 over GraphQL. Fields are mapped by NAME ("Status",
// "Target date", "Next touch", "Next action", "Waiting on"), never by id, so a
// board view can be rebuilt without touching the code.

import type { Item } from "./rules.ts";

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
}

const API_URL = "https://api.github.com/graphql";

/** Injectable so tests never touch the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const BOARD_QUERY = `
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
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content {
            __typename
            ... on Issue { number title url state updatedAt repository { name } }
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
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  repository?: { name?: string } | null;
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

const projectUrl = (owner: string, number: number): string => `https://github.com/users/${owner}/projects/${number}`;

function latest(a: string | undefined, b: string | undefined): string {
  if (!a) return b ?? "";
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function mapItem(raw: RawItem, fallbackUrl: string): Item | null {
  const content = raw.content;
  if (!content) return null;

  let status: string | null = null;
  let target: string | null = null;
  let nextTouch: string | null = null;
  let nextAction: string | null = null;
  let waitingOn: string | null = null;
  for (const value of raw.fieldValues?.nodes ?? []) {
    const name = value.field?.name;
    if (name === "Status" && value.__typename === "ProjectV2ItemFieldSingleSelectValue") status = value.name ?? null;
    else if (name === "Target date") target = value.date ?? null;
    else if (name === "Next touch") nextTouch = value.date ?? null;
    else if (name === "Next action") nextAction = value.text ?? null;
    else if (name === "Waiting on") waitingOn = value.text ?? null;
  }

  const closed = content.state === "CLOSED" || content.state === "MERGED";
  const draft = content.__typename === "DraftIssue";
  return {
    id: raw.id ?? "",
    ref: draft ? "draft" : `${content.repository?.name ?? "?"}#${content.number ?? "?"}`,
    title: content.title ?? "",
    url: draft ? fallbackUrl : content.url ?? fallbackUrl,
    status: closed ? "Done" : status,
    target,
    nextTouch,
    nextAction,
    waitingOn,
    updatedAt: latest(raw.updatedAt, content.updatedAt),
  };
}

export function createBoardClient(token: string, fetchFn: FetchLike = fetch): BoardSource {
  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchFn(API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
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

  return { fetchBoard, setDate, setSingleSelect };
}
