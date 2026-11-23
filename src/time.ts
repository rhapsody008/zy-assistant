// Date helpers. All dates are local calendar dates "YYYY-MM-DD" in the assistant's time zone.

export const TZ = process.env.ASSISTANT_TZ ?? "Asia/Singapore";

export interface LocalNow {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
}

export function localNow(d: Date, tz: string = TZ): LocalNow {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const DAY = 86_400_000;
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** The later of two ISO timestamps, or null when neither is there. */
export function latestIso(a: string | undefined, b: string | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** a - b in whole days. */
export function dayDiff(a: string, b: string): number {
  return Math.round((ms(a) - ms(b)) / DAY);
}

export function addDays(date: string, n: number): string {
  return new Date(ms(date) + n * DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday. A date is a calendar date, so this is UTC. */
export function weekday(date: string): number {
  return new Date(ms(date)).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const wd = weekday(date);
  return wd === 0 || wd === 6;
}

export function isFriday(date: string): boolean {
  return weekday(date) === 5;
}

/** The Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const wd = weekday(date);
  return addDays(date, -(wd === 0 ? 6 : wd - 1));
}

export function prevWorkday(date: string): string {
  let d = addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** The next weekday on or after date: a Saturday or Sunday rolls to Monday. */
export function nextWorkday(date: string): string {
  let d = date;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

/** "Wed 25 Nov" */
export function fmtDate(date: string): string {
  return new Date(ms(date)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).replace(",", "");
}

/** "HH:MM" -> minutes */
export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time ${s}, want HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}
