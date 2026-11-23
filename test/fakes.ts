// Shared test doubles. No network, no disk, no real timers.

import type { Ping, SentPing, Slot } from "../src/rules.ts";
import type { Sent, Sender } from "../src/slack.ts";
import type { NewPing, PingRecord, PingStore } from "../src/store.ts";

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
