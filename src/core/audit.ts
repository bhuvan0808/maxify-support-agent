/**
 * Append-only, tamper-evident audit log.
 *
 * Every customer message, model call, tool call, gate decision, money action,
 * escalation and reply is recorded with the trace ID of the turn it belongs to.
 *
 * Events are hash-chained per conversation: each row stores the hash of the previous
 * row in its chain, so editing or removing a row breaks every hash after it.
 * `verifyAuditChains` recomputes the chains and reports any break. Database triggers
 * additionally reject UPDATE and DELETE on the table (see schema.ts).
 *
 * Events are buffered and written in one batch to keep database round-trips low. The
 * buffer is always flushed before a money action executes, so the decision to pay is
 * on disk before any money moves.
 */

import type { Clock, SqlDriver, SqlStatement } from "../ports/index.ts";
import { isConstraintError } from "../ports/index.ts";
import { sha256Hex, stableStringify } from "./util.ts";

export const GENESIS_HASH = "0".repeat(64);

interface BufferedEvent {
  ts: string;
  event: string;
  data: Record<string, unknown>;
}

function hashInput(
  prevHash: string,
  chainId: string,
  seq: number,
  ts: string,
  traceId: string,
  event: string,
  dataJson: string,
): string {
  return [prevHash, chainId, String(seq), ts, traceId, event, dataJson].join("|");
}

export class AuditLog {
  private buffer: BufferedEvent[] = [];

  constructor(
    private readonly sql: SqlDriver,
    private readonly clock: Clock,
    /** One chain per conversation; admin actions use the chain "admin". */
    private readonly chainId: string,
    public readonly traceId: string,
  ) {}

  record(event: string, data: Record<string, unknown> = {}): void {
    this.buffer.push({ ts: this.clock.now().toISOString(), event, data });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];

    // Two writers on the same chain would compute the same seq; the UNIQUE (chain_id, seq)
    // constraint rejects the loser, which re-reads the head and tries again.
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.sql.first<{ seq: number; hash: string }>(
        `SELECT seq, hash FROM audit_log WHERE chain_id = ? ORDER BY seq DESC LIMIT 1`,
        [this.chainId],
      );
      let seq = head?.seq ?? 0;
      let prevHash = head?.hash ?? GENESIS_HASH;
      const statements: SqlStatement[] = [];
      for (const e of pending) {
        seq += 1;
        const dataJson = stableStringify(e.data);
        const hash = await sha256Hex(hashInput(prevHash, this.chainId, seq, e.ts, this.traceId, e.event, dataJson));
        statements.push({
          sql: `INSERT INTO audit_log (chain_id, seq, ts, trace_id, event, data, prev_hash, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [this.chainId, seq, e.ts, this.traceId, e.event, dataJson, prevHash, hash],
        });
        prevHash = hash;
      }
      try {
        await this.sql.batch(statements);
        return;
      } catch (err) {
        if (!isConstraintError(err, "UNIQUE") || attempt === 3) throw err;
      }
    }
  }
}

export interface AuditVerification {
  chains: number;
  events: number;
  ok: boolean;
  /** First broken link of each damaged chain. */
  broken: { chainId: string; seq: number; problem: string }[];
}

/** Recomputes every hash chain and reports the first inconsistency in each. */
export async function verifyAuditChains(sql: SqlDriver): Promise<AuditVerification> {
  const rows = await sql.all<{
    chain_id: string;
    seq: number;
    ts: string;
    trace_id: string;
    event: string;
    data: string;
    prev_hash: string;
    hash: string;
  }>(`SELECT chain_id, seq, ts, trace_id, event, data, prev_hash, hash FROM audit_log ORDER BY chain_id, seq`);

  const broken: AuditVerification["broken"] = [];
  const damaged = new Set<string>();
  let chains = 0;
  let currentChain: string | null = null;
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.chain_id !== currentChain) {
      currentChain = row.chain_id;
      chains += 1;
      expectedSeq = 1;
      prevHash = GENESIS_HASH;
    }
    if (!damaged.has(row.chain_id)) {
      let problem: string | null = null;
      if (row.seq !== expectedSeq) problem = `expected seq ${expectedSeq}, found ${row.seq} (row removed?)`;
      else if (row.prev_hash !== prevHash) problem = "prev_hash does not match the previous row";
      else {
        const recomputed = await sha256Hex(
          hashInput(row.prev_hash, row.chain_id, row.seq, row.ts, row.trace_id, row.event, row.data),
        );
        if (recomputed !== row.hash) problem = "row content does not match its hash (row edited?)";
      }
      if (problem) {
        broken.push({ chainId: row.chain_id, seq: row.seq, problem });
        damaged.add(row.chain_id);
      }
    }
    expectedSeq = row.seq + 1;
    prevHash = row.hash;
  }
  return { chains, events: rows.length, ok: broken.length === 0, broken };
}
