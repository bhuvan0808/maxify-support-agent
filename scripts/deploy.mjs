/**
 * One-command deploy to Cloudflare Workers + D1:  npm run deploy
 *
 *   1. Loads .env (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, model key).
 *   2. Finds or creates the D1 database and writes its ID into wrangler.jsonc.
 *   3. Deploys the Worker and static assets.
 *   4. Uploads secrets (LLM_API_KEY, ADMIN_API_KEY, optional CHANNEL_API_KEY and
 *      NOTIFY_WEBHOOK_URL) through stdin, so they never appear on a command line,
 *      in this script's output, or in the repository.
 *   5. Calls /v1/health once, which creates the schema and seeds the demo data.
 *
 * Plain Node, no dependencies beyond the wrangler already in devDependencies.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const configFile = join(root, "wrangler.jsonc");
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const DATABASE_NAME = "maxify-support-agent";

if (existsSync(envFile)) process.loadEnvFile(envFile);

function fail(message) {
  console.error(`\nDeploy stopped: ${message}`);
  process.exit(1);
}

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!process.env[name]?.trim()) fail(`${name} is missing from .env`);
}
if (!existsSync(wranglerJs)) fail("wrangler is not installed. Run `npm install` first.");

/** Runs wrangler without a shell, so nothing is interpolated into a command line. */
function wrangler(args, options = {}) {
  const result = spawnSync(process.execPath, [wranglerJs, ...args], {
    cwd: root,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !options.allowFailure) {
    console.error(output.trim());
    fail(`wrangler ${args.slice(0, 2).join(" ")} exited with code ${result.status}`);
  }
  return { ok: result.status === 0, stdout: result.stdout ?? "", output };
}

// --- 1. D1 database ------------------------------------------------------------------
function findDatabaseId() {
  const { stdout } = wrangler(["d1", "list", "--json"]);
  const start = stdout.indexOf("[");
  const list = start >= 0 ? JSON.parse(stdout.slice(start)) : [];
  return list.find((db) => db.name === DATABASE_NAME)?.uuid ?? null;
}

console.log("1/4 Looking for the D1 database...");
let databaseId = findDatabaseId();
if (!databaseId) {
  console.log(`    Creating D1 database "${DATABASE_NAME}"...`);
  wrangler(["d1", "create", DATABASE_NAME]);
  databaseId = findDatabaseId();
}
if (!databaseId) fail("could not find or create the D1 database");
console.log(`    Database ready (${databaseId}).`);

const config = readFileSync(configFile, "utf8");
const patched = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${databaseId}$2`);
if (patched !== config) writeFileSync(configFile, patched);

// --- 2. Deploy -----------------------------------------------------------------------
console.log("2/4 Deploying the Worker and static assets...");
const deployed = wrangler(["deploy"]);
const url = deployed.output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
if (!url) console.log(deployed.output.trim());

// --- 3. Secrets ----------------------------------------------------------------------
console.log("3/4 Uploading secrets...");
let adminKey = process.env.ADMIN_API_KEY?.trim();
if (!adminKey) {
  // Generate one and keep it in .env (git-ignored) so the operator can use the console.
  adminKey = randomBytes(24).toString("base64url");
  const current = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const next = /^ADMIN_API_KEY=.*$/m.test(current)
    ? current.replace(/^ADMIN_API_KEY=.*$/m, `ADMIN_API_KEY=${adminKey}`)
    : `${current.replace(/\s*$/, "")}\nADMIN_API_KEY=${adminKey}\n`;
  writeFileSync(envFile, next);
  console.log("    Generated ADMIN_API_KEY and saved it to .env.");
}
const modelKey =
  process.env.LLM_API_KEY?.trim() ||
  process.env.GROQ_API_KEY?.trim() ||
  process.env.OPENAI_API_KEY?.trim() ||
  process.env.ANTHROPIC_API_KEY?.trim();
const secrets = { ADMIN_API_KEY: adminKey };
if (modelKey) secrets.LLM_API_KEY = modelKey;
else console.log("    WARNING: no model API key found in .env; the agent will hand every chat to a human.");
if (process.env.CHANNEL_API_KEY?.trim()) secrets.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY.trim();
if (process.env.NOTIFY_WEBHOOK_URL?.trim()) secrets.NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL.trim();

// Secret values travel on stdin only. The output is not echoed, only the names set.
const bulk = wrangler(["secret", "bulk"], { input: JSON.stringify(secrets), allowFailure: true });
if (!bulk.ok) {
  for (const [name, value] of Object.entries(secrets)) {
    const put = wrangler(["secret", "put", name], { input: value, allowFailure: true });
    if (!put.ok) fail(`could not set the secret ${name}`);
  }
}
console.log(`    Set: ${Object.keys(secrets).join(", ")}.`);

// --- 4. Smoke check ------------------------------------------------------------------
console.log("4/4 Checking the deployment...");
if (!url) fail("deployed, but the workers.dev URL was not found in wrangler's output (see above)");
let healthy = false;
for (let attempt = 1; attempt <= 6 && !healthy; attempt++) {
  try {
    const response = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    healthy = response.ok;
    console.log(`    GET /v1/health -> ${response.status} ${body.slice(0, 200)}`);
  } catch (err) {
    console.log(`    GET /v1/health failed (attempt ${attempt}): ${err instanceof Error ? err.message : err}`);
  }
  if (!healthy) await new Promise((resolve) => setTimeout(resolve, 5000));
}

console.log(`\nChat:        ${url}/`);
console.log(`Ops console: ${url}/console  (admin key: ADMIN_API_KEY in .env)`);
if (!healthy) fail("the health check did not pass; see the output above");
