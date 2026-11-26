// Shared test doubles. No network, no disk, no real timers.

import type { Board, BoardField, BoardSource, IssueWriter } from "../src/github.ts";
import { ShaConflict, type NotesClient, type NotesFile } from "../src/notes.ts";
import type { Item } from "../src/rules.ts";

/** Holds a fake's reply open until the test opens it: no timers involved. */
export class Gate {
  readonly opened: Promise<void>;
  readonly entered: Promise<void>;
  #open: () => void = () => {};
  #enter: () => void = () => {};

  constructor() {
    this.opened = new Promise((resolve) => {
      this.#open = resolve;
    });
    this.entered = new Promise((resolve) => {
      this.#enter = resolve;
    });
  }

  /** Called by the fake: announces it is waiting and blocks. */
  wait(): Promise<void> {
    this.#enter();
    return this.opened;
  }

  open(): void {
    this.#open();
  }
}

/** The step of the fake board a test makes the world refuse. */
export type BoardFailure =
  | "createIssue"
  | "findIssue"
  | "addToProject"
  | "setText"
  | "setDate"
  | "setSingleSelect"
  | "clearField"
  | "addSubIssue"
  | "fetchBoard";

/** The item a project's own workflow makes of a new issue: what the auto-add fallback has to find. */
function issueItem(issue: { id: string; number: number; url: string }, itemId: string, title: string): Item {
  return {
    id: itemId,
    ref: `notes#${issue.number}`,
    title,
    url: issue.url,
    status: null,
    target: null,
    nextTouch: null,
    nextAction: null,
    waitingOn: null,
    type: null,
    stage: null,
    track: null,
    account: null,
    cadence: null,
    parentUrl: null,
    contentId: issue.id,
    updatedAt: "",
  };
}

/**
 * The board, read and written: the one fake that covers BoardSource and
 * IssueWriter together, which is what a proposal's Apply needs. Every call is
 * recorded in `calls`, with the NAMES a person sees: an option's id is looked
 * back up, so a wrong id reads as itself in the assertion that fails.
 *
 * It says `implements BoardSource, IssueWriter` rather than `BoardSource &
 * IssueWriter`: the same thing for a class, written the way the parser here takes
 * it.
 */
export class FakeBoard implements BoardSource, IssueWriter {
  board: Board = { projectId: "PVT_1", title: "Board", fields: new Map(), items: [] };
  /** Every call in order, the board reads included: when Apply read the board is part of what it does. */
  readonly calls: string[] = [];
  /** The issues createIssue made, with their bodies: what findIssue looks a marker up in. */
  readonly created: Array<{ issue: { id: string; number: number; url: string }; body: string }> = [];
  /** The step whose next call throws: it wrote nothing, so it is not in `calls`. */
  failAt: BoardFailure | null = null;
  /** True: only the next call to the failing step throws. False: every one of them does. */
  failOnce = true;
  /**
   * Which call of the failing step is the one that throws, counted from 1: a batch
   * whose second item fails still writes its first, so the step is not its first call.
   */
  failAtCall = 1;
  /** What the failing step throws: a test that needs the words of a real refusal. */
  failWith: string | null = null;
  /** The project's own workflow added the new issue before addToProject ran. */
  autoAdd = false;
  /** createIssue also leaves the issue on the board, as that workflow would. */
  boardAfterCreate = false;
  /**
   * createIssue makes the issue and then throws, as a timeout after GitHub wrote it
   * would: the issue exists, and the answer that would have named it did not arrive.
   */
  createThenThrow = false;
  /** The same, for one issue of a batch: the nth createIssue loses its answer. */
  createThenThrowOn: number | null = null;
  /** What createIssue returns, and the item id addToProject returns. */
  nextIssue = { id: "I_900", number: 900, url: "https://github.com/demo/notes/issues/900" };
  createdItemId = "ITEM_900";
  /** Holds createIssue open, so a test can click twice while the first click is writing. */
  gate: Gate | null = null;
  /** How many times each step was called: what failAtCall counts. */
  readonly #calls = new Map<BoardFailure, number>();

  /** The bodies of the issues createIssue made: what the card's sentence ended up as. */
  get bodies(): string[] {
    return this.created.map((one) => one.body);
  }

  async fetchBoard(): Promise<Board> {
    this.#enter("fetchBoard");
    return this.board;
  }

  async createIssue(repo: string, title: string, body: string): Promise<{ id: string; number: number; url: string }> {
    this.#enter("createIssue", `${repo}|${title}`);
    if (this.gate !== null) await this.gate.wait();
    const issue = { ...this.nextIssue };
    // Recorded before anything can throw: the issue is on GitHub either way.
    this.created.push({ issue, body });
    if (this.boardAfterCreate) this.board.items.push(issueItem(issue, this.createdItemId, title));
    if (this.createThenThrow || this.created.length === this.createThenThrowOn) {
      throw new Error("createIssue: the request timed out");
    }
    return issue;
  }

  async findIssue(repo: string, marker: string): Promise<{ id: string; number: number; url: string } | null> {
    this.#enter("findIssue", `${repo}|${marker}`);
    // The newest match, the way the real lookup reads the list: one marker, one issue.
    for (const one of [...this.created].reverse()) if (one.body.includes(marker)) return { ...one.issue };
    return null;
  }

  async addToProject(projectId: string, contentId: string): Promise<string> {
    this.#enter("addToProject", `${projectId}|${contentId}`);
    // Recorded before this throw: the item may be on the board anyway, which is
    // the case the caller's fallback is for.
    if (this.autoAdd) throw new Error("addToProject: the project already has this issue");
    return this.createdItemId;
  }

  async setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    this.#enter("setSingleSelect", `${itemId}|${this.#fieldName(fieldId)}|${this.#optionName(fieldId, optionId)}`);
  }

  async setDate(projectId: string, itemId: string, fieldId: string, date: string): Promise<void> {
    this.#enter("setDate", `${itemId}|${this.#fieldName(fieldId)}|${date}`);
  }

  async setText(projectId: string, itemId: string, fieldId: string, text: string): Promise<void> {
    this.#enter("setText", `${itemId}|${this.#fieldName(fieldId)}|${text}`);
  }

  async clearField(projectId: string, itemId: string, fieldId: string): Promise<void> {
    this.#enter("clearField", `${itemId}|${this.#fieldName(fieldId)}`);
  }

  async addSubIssue(issueId: string, subIssueId: string): Promise<void> {
    this.#enter("addSubIssue", `${issueId}|${subIssueId}`);
  }

  /** Recorded with its body, but no failure point: nothing here retries a comment. */
  async addComment(subjectId: string, body: string): Promise<void> {
    this.calls.push(`addComment ${subjectId}|${body}`);
  }

  #enter(name: BoardFailure, what = ""): void {
    const call = (this.#calls.get(name) ?? 0) + 1;
    this.#calls.set(name, call);
    // failOnce is the one call named by failAtCall; otherwise every call from it on fails.
    if (this.failAt === name && (this.failOnce ? call === this.failAtCall : call >= this.failAtCall)) {
      if (this.failOnce) this.failAt = null;
      throw new Error(this.failWith ?? `${name} failed`);
    }
    this.calls.push(what === "" ? name : `${name} ${what}`);
  }

  /** A field's name and its board entry by its id: an id the board does not have falls through. */
  #field(fieldId: string): [string, BoardField] | null {
    for (const entry of this.board.fields) if (entry[1].id === fieldId) return entry;
    return null;
  }

  #fieldName(fieldId: string): string {
    return this.#field(fieldId)?.[0] ?? fieldId;
  }

  #optionName(fieldId: string, optionId: string): string {
    const options = this.#field(fieldId)?.[1].options;
    if (options !== undefined) for (const [name, id] of options) if (id === optionId) return name;
    return optionId;
  }
}

/** The notes repo: files in a map, and the shas a write has to carry. */
export class FakeNotes implements NotesClient {
  readonly files = new Map<string, NotesFile>();
  readonly folders: string[] = [];
  readonly writes: Array<{ path: string; text: string; sha: string | null; message: string }> = [];
  readonly reads: string[] = [];
  /** How many writes to refuse with a ShaConflict first: another writer got there. */
  conflicts = 0;
  /** When set, every read fails: the notes repo cannot be reached. */
  failReads: Error | null = null;
  commits = 0;

  async listFolders(): Promise<string[]> {
    return [...this.folders];
  }

  async readFile(path: string): Promise<NotesFile | null> {
    this.reads.push(path);
    if (this.failReads) throw this.failReads;
    const file = this.files.get(path);
    return file === undefined ? null : { ...file };
  }

  async writeFile(path: string, text: string, sha: string | null, message: string): Promise<string> {
    this.commits += 1;
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      // Someone else wrote first: the file on main has a new sha now.
      this.files.set(path, { text: this.files.get(path)?.text ?? "", sha: `sha-${this.commits}` });
      throw new ShaConflict(`write ${path}: GitHub API 409: sha does not match`);
    }
    this.writes.push({ path, text, sha, message });
    this.files.set(path, { text, sha: `sha-${this.commits}` });
    return `https://github.com/demo/notes/commit/${this.commits}`;
  }
}
