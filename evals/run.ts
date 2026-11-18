/**
 * Eval runner.
 *
 *   npx tsx evals/run.ts --suite gate          deterministic, no model, no API key
 *   npx tsx evals/run.ts --suite adversarial   deterministic, scripted (misbehaving) model
 *   npx tsx evals/run.ts --suite live          real model from .env
 *   npx tsx evals/run.ts --suite all
 *   npx tsx evals/run.ts --suite gate --only gate-window-day-31-denied
 *
 * Every run, passing or failing, is written to its own folder under eval_runs/ and is
 * never overwritten:
 *
 *   eval_runs/<UTC timestamp>__<suite>__<model>/
 *     summary.json   machine-readable totals and per-case results
 *     summary.md     table: case, what it guards against, PASS/FAIL, failed criteria
 *     cases/<id>.json  full evidence: inputs, what the model was shown, gate decisions,
 *                      ledger rows, and every criterion with expected vs actual
 *
 * One line per run is appended to eval_runs/INDEX.md. The process exits non-zero if
 * any case failed or errored, after the output has been written.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvalInfraError, type Criterion, type EvalCase, type Suite } from "./harness.ts";

interface CaseResult {
  id: string;
  guards: string;
  status: "PASS" | "FAIL" | "ERROR";
  failedCriteria: string[];
  error: string | null;
  durationMs: number;
  criteria: Criterion[];
  evidence: Record<string, unknown>;
}

const ROOT = "eval_runs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function loadSuite(name: string): Promise<Suite> {
  if (name === "gate") {
    const { gateCases } = await import("./suites/gate.ts");
    return { name, label: "no-model", cases: gateCases };
  }
  if (name === "adversarial") {
    const { adversarialCases } = await import("./suites/adversarial.ts");
    return { name, label: "scripted-model", cases: adversarialCases };
  }
  if (name === "live") {
    const { liveSuite } = await import("./suites/live.ts");
    return liveSuite();
  }
  throw new Error(`Unknown suite "${name}". Use gate, adversarial, live or all.`);
}

function withTimeout<T>(promise: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new EvalInfraError(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

async function runSuite(name: string, only: string | undefined): Promise<boolean> {
  const startedAt = new Date();
  let suite: Suite;
  let loadError: string | null = null;
  try {
    suite = await loadSuite(name);
  } catch (err) {
    // The suite itself would not load (for example a compile error). Record that as a run too.
    loadError = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    suite = { name, label: "did-not-load", cases: [] };
  }

  const label = suite.label.replace(/[^A-Za-z0-9._-]+/g, "-");
  const folder = join(ROOT, `${stamp(startedAt)}__${suite.name}__${label}`);
  mkdirSync(join(folder, "cases"), { recursive: true });

  // --only takes one case id or a comma-separated list.
  const wanted = only ? only.split(",").map((s) => s.trim()) : null;
  const cases = wanted ? suite.cases.filter((c) => wanted.includes(c.id)) : suite.cases;
  const results: CaseResult[] = [];
  const suiteStart = Date.now();

  for (const testCase of cases) {
    const caseStart = Date.now();
    const result: CaseResult = {
      id: testCase.id,
      guards: testCase.guards,
      status: "ERROR",
      failedCriteria: [],
      error: null,
      durationMs: 0,
      criteria: [],
      evidence: {},
    };
    try {
      if (suite.timeBudgetMs && Date.now() - suiteStart > suite.timeBudgetMs) {
        throw new EvalInfraError(
          `Not run: the suite's ${Math.round(suite.timeBudgetMs / 1000)}s time budget was used up by earlier cases (provider rate limits slow each model call).`,
        );
      }
      const outcome = await withTimeout(testCase.run(), suite.perCaseTimeoutMs, `Case ${testCase.id}`);
      result.criteria = outcome.criteria;
      result.evidence = outcome.evidence;
      result.failedCriteria = outcome.criteria.filter((c) => !c.pass).map((c) => c.name);
      result.status = result.failedCriteria.length === 0 && outcome.criteria.length > 0 ? "PASS" : "FAIL";
      if (outcome.criteria.length === 0) result.failedCriteria = ["case produced no criteria"];
    } catch (err) {
      result.status = "ERROR";
      result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (err instanceof EvalInfraError) result.evidence = err.evidence;
      else if (err instanceof Error) result.evidence = { stack: err.stack };
    }
    result.durationMs = Date.now() - caseStart;
    results.push(result);
    // Written as each case finishes, so a crash later in the suite loses nothing.
    writeFileSync(join(folder, "cases", `${testCase.id}.json`), JSON.stringify(result, null, 2));
    const mark = result.status === "PASS" ? "PASS " : result.status === "FAIL" ? "FAIL " : "ERROR";
    console.log(`${mark} ${testCase.id}${result.status === "PASS" ? "" : `  <- ${result.error ?? result.failedCriteria.join("; ")}`}`);
  }

  const totals = {
    cases: results.length,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    errored: results.filter((r) => r.status === "ERROR").length,
  };
  const ok = loadError === null && totals.cases > 0 && totals.failed === 0 && totals.errored === 0;
  const summary = {
    suite: suite.name,
    model: suite.label,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - suiteStart,
    fixedClock: "2026-11-18T04:00:00.000Z",
    node: process.version,
    result: ok ? "PASS" : "FAIL",
    totals,
    loadError,
    cases: results.map(({ id, guards, status, failedCriteria, error, durationMs }) => ({ id, guards, status, failedCriteria, error, durationMs })),
  };
  writeFileSync(join(folder, "summary.json"), JSON.stringify(summary, null, 2));

  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const md = [
    `# Eval run: ${suite.name} (${suite.label})`,
    "",
    `- Result: **${summary.result}**: ${totals.passed} passed, ${totals.failed} failed, ${totals.errored} errored, of ${totals.cases}`,
    `- Started: ${summary.startedAt} (wall clock). Agent clock fixed at ${summary.fixedClock}.`,
    `- A case passes only if every criterion passes. ERROR means the case could not be judged (reason given).`,
    ...(loadError ? ["", "## Suite did not load", "", "```", loadError, "```"] : []),
    "",
    "| Case | Guards against | Result | Failed criteria / error |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${cell(r.guards)} | ${r.status} | ${cell(r.error ?? r.failedCriteria.join("; "))} |`),
    "",
  ].join("\n");
  writeFileSync(join(folder, "summary.md"), md);

  const indexPath = join(ROOT, "INDEX.md");
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      "# Eval runs\n\nOne line per run, oldest first. Failing runs are kept.\n\n| Started (UTC) | Suite | Model | Result | Passed | Failed | Errored | Folder |\n|---|---|---|---|---|---|---|---|\n",
    );
  }
  appendFileSync(
    indexPath,
    `| ${summary.startedAt} | ${suite.name} | ${suite.label} | ${summary.result} | ${totals.passed} | ${totals.failed} | ${totals.errored} | ${folder.replace(/\\/g, "/")} |\n`,
  );

  console.log(`\n${suite.name}: ${summary.result}  ${totals.passed}/${totals.cases} passed, ${totals.failed} failed, ${totals.errored} errored`);
  console.log(`Output: ${folder}\n`);
  if (loadError) console.error(loadError);
  return ok;
}

const requested = arg("suite") ?? "all";
const names = requested === "all" ? ["gate", "adversarial", "live"] : [requested];
let allOk = true;
for (const name of names) {
  allOk = (await runSuite(name, arg("only"))) && allOk;
}
process.exit(allOk ? 0 : 1);
