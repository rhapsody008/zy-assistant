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

/** a - b in whole days. */
export function dayDiff(a: string, b: string): number {
  return Math.round((ms(a) - ms(b)) / DAY);
}

export function addDays(date: string, n: number): string {
  return new Date(ms(date) + n * DAY).toISOString().slice(0, 10);
}

export function isWeekend(date: string): boolean {
  const wd = new Date(ms(date)).getUTCDay();
  return wd === 0 || wd === 6;
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
