/**
 * Small pure helpers: money, calendar-day maths in the tenant's time zone,
 * stable hashing, and text normalisation. No I/O, safe on Node and Workers.
 */

import type { Cents } from "./types.ts";

// --- Money -------------------------------------------------------------------------

/** 6900 -> "S$69.00". */
export function formatMoney(cents: Cents, symbol: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${symbol}${whole}.${frac}`;
}

// --- Calendar days -----------------------------------------------------------------

export interface LocalDate {
  y: number;
  m: number;
  d: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** The calendar date an instant falls on in the given IANA time zone. */
export function localDate(instant: Date | string, timeZone: string): LocalDate {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function toUtcMidnight(date: LocalDate): number {
  return Date.UTC(date.y, date.m - 1, date.d);
}

/**
 * Whole calendar days from `from` to `to` in the tenant's time zone.
 * The delivery day is day 0, so "within 30 days" means a result of 30 or less.
 */
export function calendarDaysBetween(from: Date | string, to: Date | string, timeZone: string): number {
  const a = toUtcMidnight(localDate(from, timeZone));
  const b = toUtcMidnight(localDate(to, timeZone));
  return Math.round((b - a) / 86_400_000);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(toUtcMidnight(date) + days * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Calendar-month addition. An overflowing day rolls forward, which favours the customer. */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1 + months, date.d));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return toUtcMidnight(a) - toUtcMidnight(b);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** {2026, 11, 18} -> "18 Nov 2026". */
export function formatLocalDate(date: LocalDate): string {
  return `${date.d} ${MONTHS[date.m - 1]} ${date.y}`;
}

/** Instant -> "18 Nov 2026" in the tenant's time zone. */
export function formatDay(instant: Date | string, timeZone: string): string {
  return formatLocalDate(localDate(instant, timeZone));
}

/** Local calendar date as "2026-11-18", used to group per-day budgets. */
export function isoDay(instant: Date | string, timeZone: string): string {
  const d = localDate(instant, timeZone);
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

// --- Hashing and canonical JSON ----------------------------------------------------

/** JSON with object keys sorted, so the same data always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison for API keys. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// --- Text --------------------------------------------------------------------------

/** Lower-case, strip punctuation, collapse whitespace. Used to compare quotes with what was typed. */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function safeJsonParse<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function isTruthyFlag(value: string | undefined | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
