// Entry point: `check`, `dry-run`, `run`, `scribe` and `ask`. Modes are described in
// README.md.

import { readFileSync } from "node:fs";
import { answerQuestion, sourcesLine, type AnswerDeps, type NotesSource } from "./ask.ts";
import { ADD_VARS, addMissing, LLM_VARS, loadConfig, noteItemsCheckLine, noteItemsRunLine, scribeMissing, type Config } from "./config.ts";
import { errMessage } from "./errors.ts";
import { createBoardClient, type BoardSource } from "./github.ts";
import { Health } from "./health.ts";
import { openaiCompatible } from "./llm.ts";
import type { ManualSettings } from "./manual.ts";
import { createNotesClient } from "./notes.ts";
import { DEFAULT_POLICY, plan, type Slot } from "./rules.ts";
import { requiredProblems, STATUS, validateSchema, type SchemaReport } from "./schema.ts";
import { startScheduler } from "./scheduler.ts";
import { extractNote, writeEntry } from "./scribe-handler.ts";
import { renderEntry } from "./scribe.ts";
import { SlackBot, briefingBlocks, type Block, type Sender } from "./slack.ts";
import { ASK_RETENTION_DAYS, askCutoff, openStore } from "./store.ts";
import { addDays, localNow, TZ } from "./time.ts";

const now = (): Date => new Date();

function log(line: string): void {
  console.log(`${now().toISOString()} ${line}`);
}

/** What "help" quotes: the two slot times, the two repos, the add and the ask, and the policy in force. */
function manualSettings(config: Config): ManualSettings {
  return {
    briefTime: config.briefTime,
    eodTime: config.eodTime,
    notesRepo: config.notesRepo,
    addRepo: config.add?.repo ?? null,
    noteItems: config.noteItems,
    ask: config.llm !== null,
    policy: { ...DEFAULT_POLICY, ...config.policy },
  };
}

const USAGE = `usage: node src/main.ts <mode>
  check                                  read the board, and DM a hello if Slack env is set
  dry-run --date YYYY-MM-DD [--slot M|E]  print what would be sent that day (default both slots)
  dry-run --week YYYY-MM-DD              print Mon-Fri, M and E (the date must be a Monday)
  scribe [--dry-run] < dictation.txt    turn a dictation into a note entry (stdin); --dry-run prints it
  ask "<question>"                       answer a question from the board and the notes
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

/** One line for the log: what the board has, or what it is missing. */
function schemaLine(report: SchemaReport): string {
  const parts: string[] = [];
  if (report.missingRequired.length > 0) parts.push(`missing required: ${report.missingRequired.join(", ")}`);
  if (report.missingOptions.length > 0) parts.push(`missing options: ${report.missingOptions.join(", ")}`);
  if (report.missingOptional.length > 0) parts.push(`missing optional: ${report.missingOptional.join(", ")}`);
  return parts.length === 0 ? "all fields and options present" : parts.join("; ");
}

/** The longest section of a set of blocks, in characters: what Slack's 3000 cap limits. */
function longestSection(blocks: Block[]): number {
  return blocks.reduce((longest, block) => (block.type === "section" ? Math.max(longest, block.text.text.length) : longest), 0);
}

/** `run` startup: a board the bot cannot read is one DM, not a crash. */
async function reportSchema(board: BoardSource, owner: string, number: number, sender: Sender): Promise<void> {
  try {
    const project = await board.fetchBoard(owner, number);
    const report = validateSchema(project);
    log(`board schema: ${schemaLine(report)}`);
    const problems = requiredProblems(report);
    if (problems.length > 0) await sender.sendDm(`zy-assistant: board schema problem: ${problems.join("; ")}`);
  } catch (err) {
    log(`board schema check failed: ${errMessage(err)}`);
  }
}

/**
 * The ask's pipeline, wired the way the deployment runs it: the model, the board,
 * and the notes repo only when NOTES_REPO is set. Both the DM and `ask` use it;
 * only the DM adds the store (`{ ...deps, asks }`), because only the DM has
 * threads to remember.
 */
function answerSettings(config: Config): AnswerDeps {
  const llm = config.llm;
  if (llm === null) throw new Error("ask: LLM_BASE_URL, LLM_API_KEY and LLM_MODEL have to be set");
  const notes: NotesSource | null =
    config.scribe === null
      ? null
      : { client: createNotesClient({ token: config.scribe.token, repo: config.scribe.repo }), repo: config.scribe.repo };
  return {
    llm: openaiCompatible({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model }),
    board: createBoardClient(config.githubToken),
    owner: config.projectOwner,
    number: config.projectNumber,
    notes,
    now,
    log,
    timeoutMs: llm.timeoutMs,
    maxTokens: llm.maxTokens,
  };
}

async function check(): Promise<void> {
  const config = loadConfig("check");
  const board = createBoardClient(config.githubToken);
  const project = await board.fetchBoard(config.projectOwner, config.projectNumber);
  log(`board "${project.title}" ${config.projectOwner}/${config.projectNumber}: ${project.items.length} items`);
  log(`board schema: ${schemaLine(validateSchema(project))}`);
  for (const item of project.items) {
    if (item.status === STATUS.done) continue;
    if (!item.target && !item.nextTouch) continue;
    log(`${item.ref} [${item.status ?? "no status"}] target=${item.target ?? "-"} next=${item.nextTouch ?? "-"} ${item.title}`);
  }

  if (!config.scribe) {
    // Nothing of the scribe's set at all: no line for it. Half of it set is worth
    // saying, and a typo fails in loadConfig. `check` is no longer 0.3.0's output
    // on its own: since 0.7.0 the add: block below prints its own line when only
    // part of ADD_* is set.
    const missing = scribeMissing();
    if (LLM_VARS.some((name) => (process.env[name] ?? "") !== "")) log(`scribe: off, missing ${missing.join(", ")}`);
  } else {
    const { llm, repo, token } = config.scribe;
    log(`scribe: ${llm.model} at ${llm.baseUrl}, notes repo ${repo}`);
    try {
      const folders = await createNotesClient({ token, repo }).listFolders();
      log(`scribe: ${folders.length} folders: ${folders.join(", ") || "(none)"}`);
    } catch (err) {
      log(`scribe: could not list the notes folders: ${errMessage(err)}`);
    }
  }

  if (config.llm !== null) {
    // The ask is on with the model alone; the notes it may read need NOTES_REPO.
    log(`ask: ${config.llm.model} at ${config.llm.baseUrl}, notes ${config.scribe === null ? "off (no NOTES_REPO)" : config.scribe.repo}`);
  }

  if (config.add !== null) {
    log(`add: ${config.add.llm.model} -> ${config.add.repo}`);
  } else {
    // The scribe's rule, said for add: nothing of its own set at all is no line, so
    // `check` reads as it did before 0.7.0; a repo without the model fails in loadConfig.
    const missing = addMissing();
    if (ADD_VARS.some((name) => (process.env[name] ?? "") !== "")) log(`add: off, missing ${missing.join(", ")}`);
  }

  // Nothing at all when note items are off: check reads as it did before 0.8.0.
  const noteItems = noteItemsCheckLine(config);
  if (noteItems !== null) log(noteItems);

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
    manual: manualSettings(config),
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

  const targets = new Map(project.items.map((item) => [item.id, item.target]));
  for (const run of runs) {
    const result = plan(project.items, run.date, run.slot, [], { policy: config.policy });
    console.log(`== ${run.date} ${run.slot}`);
    if (result.briefing) {
      // The text as it goes out, then what Slack would get: one block per row,
      // with its menu, inside the two limits that matter.
      console.log(`${result.briefing.text}\n`);
      for (const row of result.briefing.rows) console.log(`[row ${row.itemId}] menu: ${row.actions.join(", ")}`);
      const blocks = briefingBlocks(result.briefing, targets);
      console.log(`blocks: ${blocks.length}, longest section: ${longestSection(blocks)} characters, rows: ${result.briefing.rows.length}\n`);
    } else if (result.pings.length === 0) {
      console.log("(no pings)\n");
    }
    for (const ping of result.pings) {
      console.log(`[ping ${ping.kind}] ${ping.text}`);
      console.log(`  buttons: ${ping.actions.join(", ")}\n`);
    }
  }
}

/**
 * `scribe`: the same pipeline as a DM, one dictation at a time, so ZY can try a
 * note from the Mac. --dry-run prints the folder and the entry and writes nothing.
 */
async function scribeTask(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`scribe: unknown option ${unknown[0]}`);

  const config = loadConfig("scribe");
  const scribe = config.scribe;
  if (scribe === null) throw new Error("scribe: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL and NOTES_REPO have to be set");

  const text = readFileSync(0, "utf8").trim();
  if (text === "") throw new Error("scribe: no dictation on stdin");

  const deps = {
    llm: openaiCompatible({ baseUrl: scribe.llm.baseUrl, apiKey: scribe.llm.apiKey, model: scribe.llm.model }),
    notes: createNotesClient({ token: scribe.token, repo: scribe.repo }),
    log,
    timeoutMs: scribe.llm.timeoutMs,
    maxTokens: scribe.llm.maxTokens,
  };
  const today = localNow(now(), TZ).date;
  const folders = await deps.notes.listFolders();
  log(`notes repo ${scribe.repo}: ${folders.length} folders`);

  const note = await extractNote(deps, { text, hint: null, today, folders });
  const entry = renderEntry(note);
  console.log(entry);
  if (note.folder === null) {
    log(`folder: none of the ${folders.length} fit; the model suggests Accounts/${note.newFolderName}`);
    throw new Error("scribe: no existing folder, so nothing was written (create the folder, then run again)");
  }
  log(`folder: ${note.folder}`);
  if (dryRun) {
    log("dry run: nothing written");
    return;
  }
  log(`committed: ${await writeEntry(deps, { folder: note.folder, entry, date: note.date, topic: note.topic })}`);
}

/**
 * `ask`: the same pipeline a DM question runs, printed instead of posted: the
 * answer, then where it came from and how long it took. It writes nothing and
 * keeps no history.
 */
async function askTask(args: string[]): Promise<void> {
  const question = args.join(" ").trim();
  if (question === "") throw new Error('ask: no question, try ask "how is the Acme POC going?"');
  const config = loadConfig("ask");
  const answer = await answerQuestion(answerSettings(config), { question, previous: [] });
  console.log(answer.answer);
  console.log(sourcesLine(answer));
}

async function run(): Promise<void> {
  const config = loadConfig("run");
  const store = openStore(config.dbPath);
  // The answers are context for a follow-up in their thread, not a record: at
  // startup and once a day after, so a long-lived bot does not keep them forever.
  const prune = (): void => {
    const pruned = store.pruneAsks(askCutoff(now()));
    if (pruned > 0) log(`asks: pruned ${pruned} older than ${ASK_RETENTION_DAYS} days`);
  };
  prune();
  const pruneTimer = setInterval(prune, 86_400_000);
  const board = createBoardClient(config.githubToken);
  const bot = new SlackBot({
    ...config.slack,
    owner: config.projectOwner,
    number: config.projectNumber,
    store,
    board,
    now,
    log,
    manual: manualSettings(config),
    scribe:
      config.scribe === null
        ? null
        : {
            llm: openaiCompatible({
              baseUrl: config.scribe.llm.baseUrl,
              apiKey: config.scribe.llm.apiKey,
              model: config.scribe.llm.model,
            }),
            notes: createNotesClient({ token: config.scribe.token, repo: config.scribe.repo }),
            dictations: store,
            now,
            log,
            timeoutMs: config.scribe.llm.timeoutMs,
            maxTokens: config.scribe.llm.maxTokens,
            // The commit's reply then promises the card that follows it.
            noteItems: config.noteItems,
          },
    ask: config.llm === null ? null : { ...answerSettings(config), asks: store },
    add:
      config.add === null
        ? null
        : {
            llm: openaiCompatible({
              baseUrl: config.add.llm.baseUrl,
              apiKey: config.add.llm.apiKey,
              model: config.add.llm.model,
            }),
            board,
            proposals: store,
            repo: config.add.repo,
            owner: config.projectOwner,
            number: config.projectNumber,
            now,
            log,
            timeoutMs: config.add.llm.timeoutMs,
            maxTokens: config.add.llm.maxTokens,
          },
    // A note's items are add:'s second step: the same board, store and repo, so
    // an item from a note and one from a sentence are written by one code path.
    noteItems:
      config.noteItems && config.add !== null
        ? {
            board,
            proposals: store,
            repo: config.add.repo,
            owner: config.projectOwner,
            number: config.projectNumber,
            now,
            log,
          }
        : null,
  });

  await bot.start();
  log("slack connected");
  log(
    config.scribe === null
      ? "scribe: off, a note: DM is answered like any other"
      : `scribe: ${config.scribe.llm.model} at ${config.scribe.llm.baseUrl} -> ${config.scribe.repo}`,
  );
  log(
    config.llm === null
      ? "ask: off, a DM that is no command gets the hint"
      : `ask: ${config.llm.model}, notes ${config.scribe === null ? "off" : config.scribe.repo}`,
  );
  log(
    config.add === null
      ? "add: off, an add: DM is answered like any other"
      : `add: ${config.add.llm.model} -> ${config.add.repo}`,
  );
  // Unset note items print nothing: a deployment without them reads as it did before.
  const noteItemsLine = noteItemsRunLine(config);
  if (noteItemsLine !== null) log(noteItemsLine);

  let health: Health | null = null;
  if (config.httpPort !== null) {
    health = new Health(now);
    const port = await health.listen(config.httpPort);
    log(`health: GET /healthz on port ${port}`);
  }

  // Not awaited: the scheduler must start even if GitHub is slow to answer.
  void reportSchema(board, config.projectOwner, config.projectNumber, bot);

  // A restart that stopped a click or a draft left the cards on screen: each one is
  // drawn again, so its buttons come back (or, for a cancelled draft, so it says it
  // was interrupted). Not awaited, for the same reason as the schema report.
  for (const row of store.interrupted()) void bot.redrawCard(row.id);

  const stop = startScheduler({ config, board, store, sender: bot, now, log, onTick: (report) => health?.record(report) });
  log(`scheduler running: M at ${config.briefTime}, E at ${config.eodTime} (${TZ})`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    stop();
    clearInterval(pruneTimer);
    void (async () => {
      try {
        await health?.close();
      } catch (err) {
        log(`health stop failed: ${errMessage(err)}`);
      }
      try {
        await bot.stop();
      } catch (err) {
        log(`slack stop failed: ${errMessage(err)}`);
      }
      store.close();
      log("stopped");
      process.exit(0);
    })();
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
    case "scribe":
      await scribeTask(args);
      break;
    case "ask":
      await askTask(args);
      break;
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(`zy-assistant: ${errMessage(err)}`);
  process.exitCode = 1;
}
