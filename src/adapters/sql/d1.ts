/**
 * SqlDriver backed by Cloudflare D1 (serverless SQLite).
 *
 * The D1 types are declared structurally here so the project does not need the
 * Workers type package, and so the same core code type-checks for Node and Workers.
 * `batch` maps to D1's `batch()`, which runs its statements in one transaction.
 */

import type { SqlDriver, SqlResult, SqlStatement, SqlValue } from "../../ports/index.ts";

interface D1ResultLike {
  results?: Record<string, unknown>[];
  meta?: { changes?: number };
}

interface D1PreparedStatementLike {
  bind(...values: SqlValue[]): D1PreparedStatementLike;
  run(): Promise<D1ResultLike>;
  all(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
}

export class D1Driver implements SqlDriver {
  constructor(private readonly db: D1DatabaseLike) {}

  private prepare(sql: string, params: SqlValue[] = []): D1PreparedStatementLike {
    const statement = this.db.prepare(sql);
    return params.length > 0 ? statement.bind(...params) : statement;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.prepare(sql, params).run();
    return { changes: result.meta?.changes ?? 0 };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.prepare(sql, params).all();
    return (result.results ?? []) as T[];
  }

  async first<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    if (statements.length === 0) return [];
    const results = await this.db.batch(statements.map((s) => this.prepare(s.sql, s.params)));
    return results.map((r) => ({ rows: r.results ?? [], changes: r.meta?.changes ?? 0 }));
  }
}
