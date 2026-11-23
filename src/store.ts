// State: one SQLite file. What was pinged (and whether it was acked), which
// briefings went out, which slots already ran, and how often a failing slot has
// been retried. `:memory:` is accepted so tests never touch the disk.

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

/** `${date}:${slot}:briefing`, the same shape as a ping key. */
export const briefingKey = (date: string, slot: Slot): string => pingKey(date, slot, "briefing");

export class SqliteStore implements PingStore {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(SCHEMA);
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

  close(): void {
    this.#db.close();
  }
}

export function openStore(dbPath: string): SqliteStore {
  return new SqliteStore(dbPath);
}
