// Shared test doubles. No network, no disk, no real timers.

import type { Board, BoardField, BoardSource, IssueWriter } from "../src/github.ts";
import type { Llm, LlmRequest } from "../src/llm.ts";
import { ShaConflict, type NotesClient, type NotesFile } from "../src/notes.ts";
import type { Item, Ping, SentPing, Slot, Briefing } from "../src/rules.ts";
import type { Sent, Sender, BriefingSent } from "../src/slack.ts";
import type { AskRecord, AskStore, Dictation, DictationPatch, DictationStatus, DictationStore, NewPing, PingRecord, PingStore, Proposal, ProposalPatch, ProposalStatus, ProposalStore } from "../src/store.ts";

export class FakeStore implements PingStore {
  readonly pings = new Map<string, PingRecord>();
  readonly runs = new Set<string>();
  readonly briefings = new Map<string, string>();
  readonly failures = new Map<string, number>();

  recordPing(ping: NewPing): void {
    this.pings.set(ping.key, { ...ping, ackedAt: null });
  }

  historySince(date: string): SentPing[] {
    return [...this.pings.values()].filter((p) => p.date >= date);
  }

  markAcked(key: string, at: string): void {
    const ping = this.pings.get(key);
    if (ping) ping.ackedAt = at;
  }

  findByKey(key: string): PingRecord | null {
    return this.pings.get(key) ?? null;
  }

  findByMessage(channel: string, ts: string): PingRecord | null {
    for (const ping of this.pings.values()) if (ping.channel === channel && ping.ts === ts) return ping;
    return null;
  }

  slotRan(date: string, slot: Slot): boolean {
    return this.runs.has(`${date}:${slot}`);
  }

  markSlotRan(date: string, slot: Slot): void {
    this.runs.add(`${date}:${slot}`);
  }

  briefingSent(date: string, slot: Slot): boolean {
    return this.briefings.has(`${date}:${slot}`);
  }

  recordBriefing(date: string, slot: Slot, at: string): void {
    this.briefings.set(`${date}:${slot}`, at);
  }

  recordSlotFailure(date: string, slot: Slot, _error: string): number {
    const key = `${date}:${slot}`;
    const attempts = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, attempts);
    return attempts;
  }
}

/** Holds a fake's reply open until the test opens it: no timers involved. */export class Gate {
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

export class FakeSender implements Sender {
  readonly dms: string[] = [];
  readonly briefings: Briefing[] = [];
  readonly sent: Ping[] = []; // pings that the Slack call accepted
  attempts = 0; // the pings
  briefingAttempts = 0;
  failOnAttempt: number | null = null;
  /** The nth briefing send fails: null for never. */
  failBriefingOn: number | null = null;
  alwaysFailBriefing = false;
  /** When set, the briefing's blocks are refused and only its text goes out. */
  invalidBlocks = false;
  /** When set, rows beyond this many get no menu: what the 50-block limit does. */
  menuLimit: number | null = null;
  alwaysFailPings = false;
  gate: Gate | null = null;

  async sendDm(text: string): Promise<Sent> {
    if (this.gate) await this.gate.wait();
    this.dms.push(text);
    return { channel: "DM", ts: `dm-${this.dms.length}` };
  }

  async sendBriefing(briefing: Briefing): Promise<BriefingSent> {
    if (this.gate) await this.gate.wait();
    this.briefingAttempts += 1;
    if (this.alwaysFailBriefing) throw new Error("slack is down");
    if (this.failBriefingOn !== null && this.briefingAttempts === this.failBriefingOn) {
      this.failBriefingOn = null; // only the one call fails; the retry succeeds
      throw new Error("slack is down");
    }
    this.briefings.push(briefing);
    // The keys of the rows whose row carries a ⋯ menu: the rows that can be
    // clicked, and the only ones the scheduler records. A refused message has
    // no menu at all, and every row is still keyed so it is not lost.
    const keys = briefing.rows.map((row) => row.key);
    const menuKeys = this.invalidBlocks ? keys : keys.slice(0, this.menuLimit ?? keys.length);
    return { channel: "DM", ts: `brief-${this.briefings.length}`, menuKeys };
  }

  async sendPing(ping: Ping): Promise<Sent> {
    this.attempts += 1;
    if (this.alwaysFailPings) throw new Error("slack is down");
    if (this.failOnAttempt !== null && this.attempts === this.failOnAttempt) {
      this.failOnAttempt = null; // only the one call fails; the retry succeeds
      throw new Error("slack is down");
    }
    this.sent.push(ping);
    return { channel: "DM", ts: `ts-${this.sent.length}` };
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
  /** The project's own workflow added the new issue before addToProject ran. */
  autoAdd = false;
  /** createIssue also leaves the issue on the board, as that workflow would. */
  boardAfterCreate = false;
  /**
   * createIssue makes the issue and then throws, as a timeout after GitHub wrote it
   * would: the issue exists, and the answer that would have named it did not arrive.
   */
  createThenThrow = false;
  /** What createIssue returns, and the item id addToProject returns. */
  nextIssue = { id: "I_900", number: 900, url: "https://github.com/demo/notes/issues/900" };
  createdItemId = "ITEM_900";
  /** Holds createIssue open, so a test can click twice while the first click is writing. */
  gate: Gate | null = null;

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
    if (this.createThenThrow) throw new Error("createIssue: the request timed out");
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

  async addSubIssue(issueId: string, subIssueId: string): Promise<void> {
    this.#enter("addSubIssue", `${issueId}|${subIssueId}`);
  }

  /** Recorded, but no failure point: nothing in `add:` comments, so no retry continues from one. */
  async addComment(subjectId: string, _body: string): Promise<void> {
    this.calls.push(`addComment ${subjectId}`);
  }

  #enter(name: BoardFailure, what = ""): void {
    if (this.failAt === name) {
      if (this.failOnce) this.failAt = null;
      throw new Error(`${name} failed`);
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

/** The note model: scripted replies, one per call, and no network. */
export class FakeLlm implements Llm {
  readonly requests: LlmRequest[] = [];
  readonly replies: string[] = [];
  /** When set, every call throws this: the gateway is down. */
  down: Error | null = null;

  async complete(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    if (this.down) throw this.down;
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("FakeLlm: no reply left");
    return reply;
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

/** The asks and asks_seen tables: the same shapes, in maps. */
export class FakeAskStore implements AskStore {
  readonly rows = new Map<string, AskRecord>();
  readonly seen = new Map<string, string>();

  claimAsk(ts: string, at: string): boolean {
    if (this.seen.has(ts)) return false;
    this.seen.set(ts, at);
    return true;
  }

  recordAsk(ask: AskRecord): void {
    this.rows.set(ask.ts, ask);
  }

  asksInThread(threadTs: string, limit: number): AskRecord[] {
    const rows = [...this.rows.values()]
      .filter((row) => row.threadTs === threadTs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return rows.slice(Math.max(0, rows.length - limit));
  }

  pruneAsks(before: string): number {
    let pruned = 0;
    for (const [ts, row] of this.rows) {
      if (row.createdAt >= before) continue;
      this.rows.delete(ts);
      pruned += 1;
    }
    for (const [ts, at] of this.seen) if (at < before) this.seen.delete(ts);
    return pruned;
  }
}

/** The dictations table: the same shape, in a map. */
export class FakeDictations implements DictationStore {
  readonly rows = new Map<string, Dictation>();

  recordDictation(dictation: { ts: string; text: string; createdAt: string }): boolean {
    if (this.rows.has(dictation.ts)) return false;
    this.rows.set(dictation.ts, {
      ts: dictation.ts,
      text: dictation.text,
      status: "stored",
      folder: null,
      noteJson: null,
      commitUrl: null,
      createdAt: dictation.createdAt,
      error: null,
    });
    return true;
  }

  findDictation(ts: string): Dictation | null {
    return this.rows.get(ts) ?? null;
  }

  claimDictation(ts: string, from: DictationStatus[]): boolean {
    const row = this.rows.get(ts);
    if (row === undefined || !from.includes(row.status)) return false;
    row.status = "writing";
    return true;
  }

  updateDictation(ts: string, patch: DictationPatch): void {
    const row = this.rows.get(ts);
    if (row === undefined) return;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.folder !== undefined) row.folder = patch.folder;
    if (patch.noteJson !== undefined) row.noteJson = patch.noteJson;
    if (patch.commitUrl !== undefined) row.commitUrl = patch.commitUrl;
    if (patch.error !== undefined) row.error = patch.error;
  }
}

/** The proposals table: the same shape, in a map. */
export class FakeProposals implements ProposalStore {
  readonly rows = new Map<string, Proposal>();
  /** The rows a restart would have reset: what interrupted() hands back, once. */
  readonly interruptedRows: Proposal[] = [];

  recordProposal(proposal: { id: string; kind: string; source: string; createdAt: string }): boolean {
    if (this.rows.has(proposal.id)) return false;
    this.rows.set(proposal.id, {
      id: proposal.id,
      kind: proposal.kind,
      status: "drafting",
      source: proposal.source,
      payload: null,
      context: null,
      progress: null,
      rev: 0,
      channel: null,
      messageTs: null,
      createdAt: proposal.createdAt,
      error: null,
    });
    return true;
  }

  findProposal(id: string): Proposal | null {
    return this.rows.get(id) ?? null;
  }

  claimProposal(id: string, from: ProposalStatus[], to: ProposalStatus): boolean {
    const row = this.rows.get(id);
    if (row === undefined || !from.includes(row.status)) return false;
    row.status = to;
    return true;
  }

  updateProposal(id: string, patch: ProposalPatch): void {
    const row = this.rows.get(id);
    if (row === undefined) return;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.payload !== undefined) row.payload = patch.payload;
    if (patch.context !== undefined) row.context = patch.context;
    if (patch.progress !== undefined) row.progress = patch.progress;
    if (patch.channel !== undefined) row.channel = patch.channel;
    if (patch.messageTs !== undefined) row.messageTs = patch.messageTs;
    if (patch.error !== undefined) row.error = patch.error;
  }

  editProposal(id: string, rev: number, payload: string): boolean {
    const row = this.rows.get(id);
    if (row === undefined || row.status !== "open" || row.rev !== rev || row.progress !== null) return false;
    row.payload = payload;
    row.rev += 1;
    return true;
  }

  interrupted(): Proposal[] {
    const rows = [...this.interruptedRows];
    this.interruptedRows.length = 0;
    return rows;
  }
}
