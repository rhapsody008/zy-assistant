// State: one SQLite file. What was pinged (and whether it was acked), which
// briefings went out, which slots already ran, how often a failing slot has been
// retried, every dictation the scribe has not finished with yet, and the
// questions the DM has taken and answered (the claims that dedupe a redelivery,
// and the answers a follow-up in their thread quotes). `:memory:` is accepted so
// tests never touch the disk.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pingKey, type SentPing, type Slot } from "./rules.ts";

export interface NewPing {
  key: string;
  itemId: string;
  date: string;
  slot: Slot;
  kind: "ping" | "reping";
  sentAt: string; // ISO
  channel: string;
  ts: string; // Slack message ts, the thread parent a reply can point at
}

export interface PingRecord extends SentPing {
  channel: string;
  ts: string;
}

export type DictationStatus = "stored" | "asked" | "writing" | "done" | "failed" | "cancelled";

/** One `note: ...` DM: the raw text first, then whatever the model made of it. */
export interface Dictation {
  ts: string; // the Slack message ts: the dedupe key
  text: string; // the dictation, verbatim
  status: DictationStatus;
  folder: string | null; // where the note went, or will go
  noteJson: string | null; // the extracted note, so a folder choice never calls the model again
  commitUrl: string | null;
  createdAt: string; // ISO
  error: string | null;
}

/** Only the fields being changed: a status stays until something sets it. */
export interface DictationPatch {
  status?: DictationStatus;
  folder?: string | null;
  noteJson?: string | null;
  commitUrl?: string | null;
  error?: string | null;
}

export interface DictationStore {
  /** Stores the raw text before anything else; false when that ts was stored already. */
  recordDictation(dictation: { ts: string; text: string; createdAt: string }): boolean;
  /**
   * Takes the dictation for writing: true only for the call that moved it out of
   * one of `from`. A second click, or a second delivery, gets false.
   */
  claimDictation(ts: string, from: DictationStatus[]): boolean;
  findDictation(ts: string): Dictation | null;
  updateDictation(ts: string, patch: DictationPatch): void;
}

/** One answered question: the answer message, and the thread it belongs to. */
export interface AskRecord {
  ts: string; // the answer message's ts, the key: what a follow-up in the thread looks up
  threadTs: string; // the thread the question was asked in and answered in
  question: string;
  answer: string;
  createdAt: string; // ISO
}

export interface AskStore {
  /**
   * Takes the question's own message ts: true for the first delivery and false
   * for any after it, so a redelivered Slack event is answered once. The claim is
   * kept whether the answer succeeds or not.
   */
  claimAsk(ts: string, at: string): boolean;
  recordAsk(ask: AskRecord): void;
  /** The last `limit` answers in one thread, oldest first: the talk before a follow-up. */
  asksInThread(threadTs: string, limit: number): AskRecord[];
  /** Drops what is older than `before` (ISO): the answers, and the claims with them. */
  pruneAsks(before: string): number;
}

/** How long an answered question stays, for the follow-up in its thread. */
export const ASK_RETENTION_DAYS = 30;

/** The instant before which answers and claims are pruned, `at` minus the retention. */
export function askCutoff(at: Date): string {
  return new Date(at.getTime() - ASK_RETENTION_DAYS * 86_400_000).toISOString();
}

export interface PingStore {
  recordPing(ping: NewPing): void;
  historySince(date: string): SentPing[];
  markAcked(key: string, at: string): void;
  findByKey(key: string): PingRecord | null;
  findByMessage(channel: string, ts: string): PingRecord | null;
  slotRan(date: string, slot: Slot): boolean;
  markSlotRan(date: string, slot: Slot, at: string): void;
  /** The briefing of a slot is sent once, however many retries the slot needs. */
  briefingSent(date: string, slot: Slot): boolean;
  recordBriefing(date: string, slot: Slot, at: string): void;
  /** Counts one failed attempt at a slot and returns the total. */
  recordSlotFailure(date: string, slot: Slot, error: string): number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pings (
  key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  acked_at TEXT,
  channel TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pings_message ON pings (channel, ts);
CREATE TABLE IF NOT EXISTS slot_runs (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
-- Separate from pings: a briefing is not a ping and must never reach plan().
CREATE TABLE IF NOT EXISTS briefings (
  key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slot_failures (
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  PRIMARY KEY (date, slot)
);
-- Every dictation, from the moment it is stored: the model can be down, GitHub
-- can be down, and the words are not to be lost either way.
CREATE TABLE IF NOT EXISTS dictations (
  ts TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  folder TEXT,
  note_json TEXT,
  commit_url TEXT,
  created_at TEXT NOT NULL,
  error TEXT
);
-- Every question answered in the DM, so a reply in that thread can carry the
-- conversation it belongs to. Pruned after a month: it is context, not a record.
CREATE TABLE IF NOT EXISTS asks (
  ts TEXT PRIMARY KEY,
  thread_ts TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_thread ON asks (thread_ts, created_at);
-- Every question message taken, written before the model is called: Slack
-- delivers the same event twice sometimes, and one question has one answer.
CREATE TABLE IF NOT EXISTS asks_seen (
  ts TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : String(v));

function toSentPing(row: Row): SentPing {
  return {
    key: text(row.key),
    itemId: text(row.item_id),
    date: text(row.date),
    slot: row.slot === "E" ? "E" : "M",
    kind: row.kind === "reping" ? "reping" : "ping",
    sentAt: text(row.sent_at),
    ackedAt: row.acked_at === null || row.acked_at === undefined ? null : text(row.acked_at),
  };
}

function toPingRecord(row: Row): PingRecord {
  return { ...toSentPing(row), channel: text(row.channel), ts: text(row.ts) };
}

const nullableText = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));

function toDictation(row: Row): Dictation {
  return {
    ts: text(row.ts),
    text: text(row.text),
    status: text(row.status) as DictationStatus,
    folder: nullableText(row.folder),
    noteJson: nullableText(row.note_json),
    commitUrl: nullableText(row.commit_url),
    createdAt: text(row.created_at),
    error: nullableText(row.error),
  };
}

/** `${date}:${slot}:briefing`, the same shape as a ping key. */
export const briefingKey = (date: string, slot: Slot): string => pingKey(date, slot, "briefing");

function toAsk(row: Row): AskRecord {
  return {
    ts: text(row.ts),
    threadTs: text(row.thread_ts),
    question: text(row.question),
    answer: text(row.answer),
    createdAt: text(row.created_at),
  };
}

export class SqliteStore implements PingStore, DictationStore, AskStore {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(SCHEMA);
    // A write the last process never finished: hand it back to the retry button.
    this.#db.exec("UPDATE dictations SET status = 'failed', error = 'interrupted by a restart' WHERE status = 'writing'");
  }

  recordPing(p: NewPing): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO pings (key, item_id, date, slot, kind, sent_at, acked_at, channel, ts) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
      .run(p.key, p.itemId, p.date, p.slot, p.kind, p.sentAt, p.channel, p.ts);
  }

  historySince(date: string): SentPing[] {
    const rows = this.#db.prepare("SELECT * FROM pings WHERE date >= ? ORDER BY date, slot, sent_at").all(date);
    return rows.map(toSentPing);
  }

  markAcked(key: string, at: string): void {
    this.#db.prepare("UPDATE pings SET acked_at = ? WHERE key = ?").run(at, key);
  }

  findByKey(key: string): PingRecord | null {
    const row = this.#db.prepare("SELECT * FROM pings WHERE key = ?").get(key);
    return row ? toPingRecord(row) : null;
  }

  findByMessage(channel: string, ts: string): PingRecord | null {
    const row = this.#db.prepare("SELECT * FROM pings WHERE channel = ? AND ts = ?").get(channel, ts);
    return row ? toPingRecord(row) : null;
  }

  slotRan(date: string, slot: Slot): boolean {
    return this.#db.prepare("SELECT 1 FROM slot_runs WHERE date = ? AND slot = ?").get(date, slot) !== undefined;
  }

  markSlotRan(date: string, slot: Slot, at: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO slot_runs (date, slot, ran_at) VALUES (?, ?, ?)").run(date, slot, at);
  }

  briefingSent(date: string, slot: Slot): boolean {
    return this.#db.prepare("SELECT 1 FROM briefings WHERE key = ?").get(briefingKey(date, slot)) !== undefined;
  }

  recordBriefing(date: string, slot: Slot, at: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO briefings (key, date, slot, sent_at) VALUES (?, ?, ?, ?)")
      .run(briefingKey(date, slot), date, slot, at);
  }

  recordSlotFailure(date: string, slot: Slot, error: string): number {
    this.#db
      .prepare(
        `INSERT INTO slot_failures (date, slot, attempts, last_error) VALUES (?, ?, 1, ?)
         ON CONFLICT(date, slot) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error`,
      )
      .run(date, slot, error);
    const row = this.#db.prepare("SELECT attempts FROM slot_failures WHERE date = ? AND slot = ?").get(date, slot);
    return row ? Number(row.attempts) : 1;
  }

  recordDictation(dictation: { ts: string; text: string; createdAt: string }): boolean {
    const result = this.#db
      .prepare("INSERT INTO dictations (ts, text, status, created_at) VALUES (?, ?, 'stored', ?) ON CONFLICT(ts) DO NOTHING")
      .run(dictation.ts, dictation.text, dictation.createdAt);
    return Number(result.changes) > 0;
  }

  findDictation(ts: string): Dictation | null {
    const row = this.#db.prepare("SELECT * FROM dictations WHERE ts = ?").get(ts);
    return row ? toDictation(row) : null;
  }

  claimDictation(ts: string, from: DictationStatus[]): boolean {
    if (from.length === 0) return false;
    // One statement, so two clicks cannot both win: the second sees 'writing'.
    const marks = from.map(() => "?").join(", ");
    const result = this.#db
      .prepare(`UPDATE dictations SET status = 'writing' WHERE ts = ? AND status IN (${marks})`)
      .run(ts, ...from);
    return Number(result.changes) === 1;
  }

  updateDictation(ts: string, patch: DictationPatch): void {
    const columns: string[] = [];
    const values: Array<string | null> = [];
    const set = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      columns.push(`${column} = ?`);
      values.push(value);
    };
    set("status", patch.status);
    set("folder", patch.folder);
    set("note_json", patch.noteJson);
    set("commit_url", patch.commitUrl);
    set("error", patch.error);
    if (columns.length === 0) return;
    this.#db.prepare(`UPDATE dictations SET ${columns.join(", ")} WHERE ts = ?`).run(...values, ts);
  }

  claimAsk(ts: string, at: string): boolean {
    const result = this.#db.prepare("INSERT OR IGNORE INTO asks_seen (ts, seen_at) VALUES (?, ?)").run(ts, at);
    return Number(result.changes) > 0;
  }

  recordAsk(ask: AskRecord): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO asks (ts, thread_ts, question, answer, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(ask.ts, ask.threadTs, ask.question, ask.answer, ask.createdAt);
  }

  asksInThread(threadTs: string, limit: number): AskRecord[] {
    if (limit < 1) return [];
    // Newest first, then read back to front: the caller wants the talk in order.
    const rows = this.#db
      .prepare("SELECT * FROM asks WHERE thread_ts = ? ORDER BY created_at DESC, ts DESC LIMIT ?")
      .all(threadTs, limit);
    return rows.map(toAsk).reverse();
  }

  pruneAsks(before: string): number {
    const answers = this.#db.prepare("DELETE FROM asks WHERE created_at < ?").run(before);
    // A claim a redelivery could still come for is months old by any measure.
    this.#db.prepare("DELETE FROM asks_seen WHERE seen_at < ?").run(before);
    return Number(answers.changes);
  }

  close(): void {
    this.#db.close();
  }
}

export function openStore(dbPath: string): SqliteStore {
  return new SqliteStore(dbPath);
}
