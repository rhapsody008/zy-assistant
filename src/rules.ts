// Deterministic reminder rules (zy-ops#7, MVP subset). Pure: no I/O, no clock.
//
// Slots: M = morning briefing, E = end-of-day sweep (weekdays only; the scheduler decides).
// M: one briefing message, plus a direct ping for every In-progress item that needs action:
//    - Target date today, or 1..3 days away (deadline ladder; always fires in T-3..T-1)
//    - Target date passed by 1..STALE_DAYS days (overdue, daily)
//    - Next touch today or passed (daily until the date moves or the item is Done)
//    Items that are not In progress and match go into the briefing's "Today" list instead.
//    Target 4..7 days away -> "Coming up" briefing line. Overdue > STALE_DAYS -> one "Stale dates" line.
//    An E re-ping from the previous workday that is still unacked -> ⚠ line at the top.
// E: a ping for each open item whose Target date is today ("close it or move the date"),
//    and one re-ping for each M ping from today that has no ack.
// Ack = a button press, a thread reply, or the item updated (board or issue) after the ping.
// One message per item per slot; reasons are merged.

import { dayDiff, fmtDate, prevWorkday } from "./time.ts";

export type Slot = "M" | "E";

export interface Item {
  id: string; // project item node id
  ref: string; // "notes#52"
  title: string;
  url: string;
  status: string | null;
  target: string | null; // Target date
  nextTouch: string | null;
  nextAction: string | null;
  waitingOn: string | null;
  updatedAt: string; // ISO, max of item and issue updatedAt
}

export interface SentPing {
  key: string;
  itemId: string;
  date: string;
  slot: Slot;
  kind: "ping" | "reping";
  sentAt: string; // ISO
  ackedAt: string | null;
}

export type ActionId = "ack" | "done" | "touch1" | "touch7";

export interface Ping {
  key: string;
  itemId: string;
  kind: "ping" | "reping";
  text: string;
  actions: ActionId[];
}

export interface Plan {
  briefing: string | null;
  pings: Ping[];
}

export const STALE_DAYS = 14;
export const WIP_LIMIT = 3;
const IN_PROGRESS = "In progress";

export function pingKey(date: string, slot: Slot, itemId: string): string {
  return `${date}:${slot}:${itemId}`;
}

export function isAcked(p: SentPing, item: Item | undefined): boolean {
  if (p.ackedAt) return true;
  return item !== undefined && Date.parse(item.updatedAt) > Date.parse(p.sentAt);
}

const isOpen = (i: Item) => i.status !== "Done";
const link = (i: Item) => `<${i.url}|${i.ref}> ${i.title}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function contextLines(i: Item): string[] {
  const out: string[] = [];
  if (i.nextAction) out.push(`Next: ${i.nextAction}`);
  if (i.waitingOn) out.push(`Waiting on: ${i.waitingOn}`);
  return out;
}

function morningReasons(i: Item, today: string): { reasons: string[]; touch: boolean } {
  const reasons: string[] = [];
  let touch = false;
  if (i.target) {
    const d = dayDiff(i.target, today);
    if (d === 0) reasons.push("*due today*");
    else if (d >= 1 && d <= 3) reasons.push(`due in ${plural(d, "day")} (${fmtDate(i.target)})`);
    else if (d < 0 && d >= -STALE_DAYS) reasons.push(`*overdue* by ${plural(-d, "day")} (target ${fmtDate(i.target)})`);
  }
  if (i.nextTouch && dayDiff(i.nextTouch, today) <= 0) {
    touch = true;
    reasons.push(i.nextTouch === today ? "touch today" : `touch was ${fmtDate(i.nextTouch)}`);
  }
  return { reasons, touch };
}

export function plan(items: Item[], today: string, slot: Slot, history: SentPing[]): Plan {
  const open = items.filter(isOpen);
  const byId = new Map(items.map((i) => [i.id, i]));
  return slot === "M" ? planMorning(open, today, history, byId) : planEvening(open, today, history, byId);
}

function planMorning(open: Item[], today: string, history: SentPing[], byId: Map<string, Item>): Plan {
  const pings: Ping[] = [];
  const todayLines: string[] = [];
  const soon: string[] = [];
  const stale: string[] = [];

  for (const i of open) {
    const { reasons, touch } = morningReasons(i, today);
    if (reasons.length > 0) {
      if (i.status === IN_PROGRESS) {
        pings.push({
          key: pingKey(today, "M", i.id),
          itemId: i.id,
          kind: "ping",
          text: [`${link(i)}: ${reasons.join(", ")}`, ...contextLines(i)].join("\n"),
          actions: touch ? ["ack", "touch1", "touch7", "done"] : ["ack", "done"],
        });
      }
      todayLines.push(`• ${link(i)}: ${reasons.join(", ")}`);
    }
    if (i.target) {
      const d = dayDiff(i.target, today);
      if (d >= 4 && d <= 7) soon.push(`• ${link(i)}: due ${fmtDate(i.target)}`);
      if (d < -STALE_DAYS) stale.push(`${i.ref} (${i.target})`);
    }
    // This item's own line only: a ref is not unique (drafts all say "draft",
    // and notes#5 is a substring of notes#52).
    if (i.nextTouch && dayDiff(i.nextTouch, today) === 1 && reasons.length === 0) {
      soon.push(`• ${link(i)}: touch tomorrow${i.waitingOn ? ` (waiting on ${i.waitingOn})` : ""}`);
    }
  }

  const yesterday = prevWorkday(today);
  const warn = history
    .filter((h) => h.kind === "reping" && h.date === yesterday && !isAcked(h, byId.get(h.itemId)))
    .map((h) => byId.get(h.itemId))
    .filter((i): i is Item => i !== undefined && isOpen(i))
    .map((i) => `⚠ *No update* on ${link(i)} since yesterday's pings`);

  const wip = open.filter((i) => i.status === IN_PROGRESS).length;
  const parts: string[] = [`*Morning briefing, ${fmtDate(today)}*`];
  if (warn.length) parts.push(warn.join("\n"));
  parts.push(todayLines.length ? `*Today*\n${todayLines.join("\n")}` : "*Today*\nNothing due. 🎉");
  if (soon.length) parts.push(`*Coming up*\n${soon.join("\n")}`);
  if (stale.length) parts.push(`*Stale dates* (more than ${STALE_DAYS} days overdue, fix or close): ${stale.join(", ")}`);
  parts.push(`In progress: ${wip}${wip > WIP_LIMIT ? ` (over the limit of ${WIP_LIMIT}: what are you dropping?)` : ""}`);

  return { briefing: parts.join("\n\n"), pings };
}

function planEvening(open: Item[], today: string, history: SentPing[], byId: Map<string, Item>): Plan {
  const pings: Ping[] = [];
  for (const i of open) {
    const reasons: string[] = [];
    let kind: Ping["kind"] = "ping";
    if (i.target === today) reasons.push("*due today*: close it, or move the date with a reason");
    const morning = history.find((h) => h.itemId === i.id && h.date === today && h.slot === "M");
    if (morning && !isAcked(morning, byId.get(i.id))) {
      kind = "reping";
      reasons.push("no update since this morning's ping");
    }
    if (reasons.length === 0) continue;
    const touch = i.nextTouch !== null && dayDiff(i.nextTouch, today) <= 0;
    pings.push({
      key: pingKey(today, "E", i.id),
      itemId: i.id,
      kind,
      text: [`${link(i)}: ${reasons.join("; ")}`, ...contextLines(i)].join("\n"),
      actions: touch ? ["ack", "touch1", "touch7", "done"] : ["ack", "done"],
    });
  }
  return { briefing: null, pings };
}
