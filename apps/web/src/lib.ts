import type { Bucket } from "@nightcrew/core";

export const BUCKET_COLOR: Record<Bucket, string> = {
  shipped: "var(--ok)",
  ready: "var(--sky)",
  eyes: "var(--dawn)",
  back: "var(--muted)",
  failed: "var(--bad)",
};

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export function fmtTime(iso: string | null | undefined): string {
  return iso ? time.format(new Date(iso)) : "—";
}

export function fmtDay(iso: string | null | undefined): string {
  return iso ? day.format(new Date(iso)) : "—";
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });

export function fmtWeekday(iso: string): string {
  return weekday.format(new Date(iso));
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function fmtModel(model: string | null): string {
  if (!model) return "—";
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1")
    .replace(/^(\w)/, (c) => c.toUpperCase());
}

export function durationMs(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}
