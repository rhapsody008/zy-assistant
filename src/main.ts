// Entry point: `check`, `dry-run` and `run`. Modes are described in README.md.

import { loadConfig } from "./config.ts";
import { createBoardClient } from "./github.ts";
import { plan, type Slot } from "./rules.ts";
import { startScheduler } from "./scheduler.ts";
import { SlackBot } from "./slack.ts";
import { openStore } from "./store.ts";
import { addDays, localNow, TZ } from "./time.ts";

const now = (): Date => new Date();

function log(line: string): void {
  console.log(`${now().toISOString()} ${line}`);
}

const USAGE = `usage: node src/main.ts <mode>
  check                                  read the board, and DM a hello if Slack env is set
  dry-run --date YYYY-MM-DD [--slot M|E]  print what would be sent that day (default both slots)
  dry-run --week YYYY-MM-DD              print Mon-Fri, M and E (the date must be a Monday)
  run                                    Slack bot plus the scheduler`;

interface DryRunArgs {
  date: string | null;
  week: string | null;
  slot: Slot | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDryRunArgs(args: string[]): DryRunArgs {
  const parsed: DryRunArgs = { date: null, week: null, slot: null };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--date" || flag === "--week" || flag === "--slot") {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
    }
    if (flag === "--date" || flag === "--week") {
      if (!DATE_RE.test(value)) throw new Error(`${flag} wants YYYY-MM-DD, got ${value}`);
      parsed[flag === "--date" ? "date" : "week"] = value;
    } else if (flag === "--slot") {
      if (value !== "M" && value !== "E") throw new Error(`--slot wants M or E, got ${value}`);
      parsed.slot = value;
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (parsed.date === null && parsed.week === null) throw new Error("dry-run needs --date or --week");
  if (parsed.date !== null && parsed.week !== null) throw new Error("dry-run takes --date or --week, not both");
  return parsed;
}

function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
}

async function check(): Promise<void> {
  const config = loadConfig("check");
  const board = createBoardClient(config.githubToken);
  const project = await board.fetchBoard(config.projectOwner, config.projectNumber);
  log(`board "${project.title}" ${config.projectOwner}/${config.projectNumber}: ${project.items.length} items`);
  for (const item of project.items) {
    if (item.status === "Done") continue;
    if (!item.target && !item.nextTouch) continue;
    log(`${item.ref} [${item.status ?? "no status"}] target=${item.target ?? "-"} next=${item.nextTouch ?? "-"} ${item.title}`);
  }

  if (!config.slack) {
    log("Slack env is not set, skipping auth.test and the DM");
    return;
  }
  const bot = new SlackBot({
    ...config.slack,
    owner: config.projectOwner,
    number: config.projectNumber,
    store: openStore(":memory:"),
    board,
    now,
    log,
  });
  const who = await bot.authTest();
  log(`slack ok: ${String(who.user)} in ${String(who.team)}`);
  const sent = await bot.sendDm("zy-assistant check: hello");
  log(`dm sent: channel ${sent.channel}, ts ${sent.ts}`);
}

async function dryRun(args: string[]): Promise<void> {
  const options = parseDryRunArgs(args);
  const config = loadConfig("dry-run");
  const board = createBoardClient(config.githubToken);
  const project = await board.fetchBoard(config.projectOwner, config.projectNumber);

  const runs: Array<{ date: string; slot: Slot }> = [];
  if (options.week !== null) {
    if (!isMonday(options.week)) throw new Error(`--week wants a Monday, ${options.week} is not one`);
    const slots: Slot[] = options.slot ? [options.slot] : ["M", "E"];
    for (let i = 0; i < 5; i += 1) {
      const date = addDays(options.week, i);
      for (const slot of slots) runs.push({ date, slot });
    }
  } else {
    const date = options.date ?? localNow(now(), TZ).date;
    for (const slot of options.slot ? [options.slot] : (["M", "E"] as Slot[])) runs.push({ date, slot });
  }

  for (const run of runs) {
    const result = plan(project.items, run.date, run.slot, []);
    console.log(`== ${run.date} ${run.slot}`);
    if (result.briefing) console.log(`${result.briefing}\n`);
    if (result.pings.length === 0) console.log("(no pings)\n");
    for (const ping of result.pings) {
      console.log(`[ping ${ping.kind}] ${ping.text}`);
      console.log(`  buttons: ${ping.actions.join(", ")}\n`);
    }
  }
}

async function run(): Promise<void> {
  const config = loadConfig("run");
  const store = openStore(config.dbPath);
  const board = createBoardClient(config.githubToken);
  const bot = new SlackBot({
    ...config.slack,
    owner: config.projectOwner,
    number: config.projectNumber,
    store,
    board,
    now,
    log,
  });

  await bot.start();
  log("slack connected");
  const stop = startScheduler({ config, board, store, sender: bot, now, log });
  log(`scheduler running: M at ${config.briefTime}, E at ${config.eodTime} (${TZ})`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    stop();
    void bot
      .stop()
      .catch((err: unknown) => log(`slack stop failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        store.close();
        log("stopped");
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const [, , mode, ...args] = process.argv;

try {
  switch (mode) {
    case "check":
      await check();
      break;
    case "dry-run":
      await dryRun(args);
      break;
    case "run":
      await run();
      break;
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(`zy-assistant: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
