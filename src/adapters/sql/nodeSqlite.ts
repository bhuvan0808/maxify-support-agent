/**
 * SqlDriver backed by Node's built-in SQLite (`node:sqlite`).
 *
 * Used by the CLI, the evals and the unit tests. State lives in a single file
 * (default `.data/agent.db`), which is what lets a repeated request be recognised
 * across separate CLI invocations. Pass ":memory:" for an isolated throwaway database.
 *
 * This file is Node-only and must never be imported from the Worker entry point.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDriver, SqlResult, SqlStatement, SqlValue } from "../../ports/index.ts";

/** Statements that produce rows need `.all()`; the rest report `changes` through `.run()`. */
function returnsRows(sql: string): boolean {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  return head.startsWith("SELECT") || head.startsWith("WITH") || /\bRETURNING\b/i.test(sql);
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Wait briefly instead of failing if another process holds the write lock.
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  private exec(statement: SqlStatement): SqlResult {
    const prepared = this.db.prepare(statement.sql);
    const params = (statement.params ?? []) as SqlValue[];
    if (returnsRows(statement.sql)) {
      const rows = prepared.all(...params) as Record<string, unknown>[];
      return { rows, changes: rows.length };
    }
    const info = prepared.run(...params);
    return { rows: [], changes: Number(info.changes) };
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    return { changes: this.exec({ sql, params }).changes };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.exec({ sql, params }).rows as T[];
  }

  async first<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (this.exec({ sql, params }).rows[0] as T | undefined) ?? null;
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((s) => this.exec(s));
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
