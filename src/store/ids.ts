/**
 * Sequential, human-readable IDs (ACT-000001, ESC-000001...) backed by a counter row.
 * Sequential IDs keep the ledger easy to audit and make eval output identical run to run.
 */

import type { SqlDriver } from "../ports/index.ts";

export type CounterName = "ACT" | "ESC" | "RFND" | "EXCH" | "CANC";

export async function nextId(sql: SqlDriver, name: CounterName): Promise<string> {
  const row = await sql.first<{ value: number }>(
    `UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value`,
    [name],
  );
  if (!row) throw new Error(`Counter ${name} is missing; has the schema been created?`);
  return `${name}-${String(row.value).padStart(6, "0")}`;
}
