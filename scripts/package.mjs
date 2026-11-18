/**
 * Builds the submission ZIP from the last commit and refuses to if a secret is in it.
 *
 *   npm run package
 *
 * The ZIP is `git archive` of HEAD, so it contains exactly the committed files:
 * no node_modules, no .env, no local database, no Wrangler state. Uncommitted changes
 * are not included (a warning lists them).
 *
 * Before archiving, the committed tree is scanned for
 *   - the literal value of any credential-like variable in the local .env, and
 *   - well-known token shapes (Groq, GitHub, Anthropic, OpenAI, private keys).
 * Only file names are printed, never the matched text.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "maxify-support-agent-submission.zip";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Files in HEAD matching the given `git grep` arguments. Exit code 1 means "no match". */
function grepHead(args) {
  try {
    return git("grep", "-I", "-l", ...args, "HEAD")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^HEAD:/, ""));
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

const dirty = git("status", "--porcelain");
if (dirty) {
  console.warn("Warning: uncommitted changes are NOT in the ZIP (it is built from the last commit):\n" + dirty + "\n");
}

const tracked = git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
const offenders = new Set();
for (const file of tracked) {
  if (/(^|\/)\.env$/.test(file) || file.startsWith("node_modules/") || file.startsWith(".data/") || file.startsWith(".wrangler/")) {
    offenders.add(`${file} (must not be committed)`);
  }
}

// 1. Literal credential values from the local .env. Passed to git through a temp file,
//    not the command line, and removed afterwards.
if (existsSync(".env")) {
  const values = [];
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (value.length >= 12 && /(KEY|TOKEN|SECRET|PASSWORD|ACCOUNT_ID)/.test(match[1])) values.push(value);
  }
  if (values.length > 0) {
    const dir = mkdtempSync(join(tmpdir(), "pkg-scan-"));
    const patternFile = join(dir, "patterns");
    try {
      writeFileSync(patternFile, values.join("\n") + "\n");
      for (const file of grepHead(["-F", "-f", patternFile])) offenders.add(`${file} (contains a value from .env)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// 2. Well-known token shapes.
const TOKEN_SHAPES = [
  "gsk_[A-Za-z0-9]{20,}", // Groq
  "gh[pousr]_[A-Za-z0-9]{30,}", // GitHub
  "github_pat_[A-Za-z0-9_]{30,}",
  "sk-ant-[A-Za-z0-9-]{20,}", // Anthropic
  "sk-(proj-)?[A-Za-z0-9]{32,}", // OpenAI
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
];
for (const shape of TOKEN_SHAPES) {
  for (const file of grepHead(["-E", "-e", shape])) offenders.add(`${file} (contains something shaped like an API token)`);
}

if (offenders.size > 0) {
  console.error("Refusing to package. Possible secrets in:\n  " + [...offenders].join("\n  "));
  process.exit(1);
}

execFileSync("git", ["archive", "--format=zip", "--prefix=maxify-support-agent/", "-o", OUT, "HEAD"], { stdio: "inherit" });
console.log(
  `${OUT} written from commit ${git("rev-parse", "--short", "HEAD")}: ${tracked.length} files, ${(statSync(OUT).size / 1024).toFixed(0)} KB. No secrets found.`,
);
