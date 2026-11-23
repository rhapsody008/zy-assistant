// Shared test doubles. No network, no disk, no real timers.

import type { Llm, LlmRequest } from "../src/llm.ts";
import { ShaConflict, type NotesClient, type NotesFile } from "../src/notes.ts";
import type { Ping, SentPing, Slot } from "../src/rules.ts";
import type { Sent, Sender } from "../src/slack.ts";
import type { AskRecord, AskStore, Dictation, DictationPatch, DictationStatus, DictationStore, NewPing, PingRecord, PingStore } from "../src/store.ts";

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
  readonly sent: Ping[] = []; // pings that the Slack call accepted
  attempts = 0;
  failOnAttempt: number | null = null;
  alwaysFailPings = false;
  gate: Gate | null = null;

  async sendDm(text: string): Promise<Sent> {
    if (this.gate) await this.gate.wait();
    this.dms.push(text);
    return { channel: "DM", ts: `dm-${this.dms.length}` };
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
