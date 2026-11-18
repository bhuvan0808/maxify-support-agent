/**
 * Builds the submission ZIP from the committed tree and refuses to if a secret is in it.
 *
 *   npm run package
 *
 * The ZIP is `git archive` of HEAD, so it contains exactly the tracked files:
 * no node_modules, no .env, no local database, no Wrangler state.
 *
 * Before archiving, every tracked file is scanned for
 *   - the literal value of any secret-looking variable in the local .env, and
 *   - well-known token shapes (Groq, GitHub, Cloudflare, Vercel, OpenAI, Anthropic).
 * Only file names are printed, never the matched text.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const OUT = "maxify-support-agent-submission.zip";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const dirty = git("status", "--porcelain");
if (dirty) {
  console.error("Uncommitted changes exist. Commit first so the ZIP matches the repository:\n" + dirty);
  process.exit(1);
}

// Secret values from the local .env (names that look like credentials, values long enough to be real).
const secretValues = [];
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, raw] = match;
    const value = raw.replace(/^["']|["']$/g, "");
    if (value.length >= 12 && /(KEY|TOKEN|SECRET|PASSWORD|ACCOUNT_ID)/.test(name)) secretValues.push(value);
  }
}

const TOKEN_SHAPES = [
  /gsk_[A-Za-z0-9]{20,}/, // Groq
  /gh[pousr]_[A-Za-z0-9]{30,}/, // GitHub
  /github_pat_[A-Za-z0-9_]{30,}/,
  /sk-ant-[A-Za-z0-9-]{20,}/, // Anthropic
  /sk-(proj-)?[A-Za-z0-9]{32,}/, // OpenAI
  /vercel_[A-Za-z0-9]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const tracked = git("ls-files").split("\n").filter(Boolean);
const offenders = [];
for (const file of tracked) {
  if (file === ".env" || file.startsWith("node_modules/")) {
    offenders.push(`${file} (must not be tracked)`);
    continue;
  }
  if (!existsSync(file) || statSync(file).size > 5_000_000) continue;
  const text = readFileSync(file, "utf8");
  if (secretValues.some((v) => text.includes(v))) offenders.push(`${file} (contains a value from .env)`);
  else if (TOKEN_SHAPES.some((p) => p.test(text))) offenders.push(`${file} (contains something shaped like an API token)`);
}

if (offenders.length > 0) {
  console.error("Refusing to package. Possible secrets in:\n  " + offenders.join("\n  "));
  process.exit(1);
}

execFileSync("git", ["archive", "--format=zip", "--prefix=maxify-support-agent/", "-o", OUT, "HEAD"], { stdio: "inherit" });
console.log(`${OUT} written: ${tracked.length} files, ${(statSync(OUT).size / 1024).toFixed(0)} KB, commit ${git("rev-parse", "--short", "HEAD")}. No secrets found.`);
