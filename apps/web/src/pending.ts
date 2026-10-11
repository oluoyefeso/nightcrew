// Unsaved edits that survive the reload a restart forces (a new launch key).
// localStorage, not sessionStorage: the new launch link usually opens in a
// new tab, which starts with empty session storage.

import { useEffect, useRef } from "react";

const PREFIX = "nc-pending-";
const RETURN_TO = "return-to";
/** A stash older than this is dropped rather than restored over newer work. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Saver = () => unknown;
const savers = new Map<string, Saver>();

const isEmpty = (value: unknown) => value == null || (typeof value === "string" && !value.trim());

/** Write a stash now. A null or empty value clears it. Returns whether it kept anything. */
export function stash(key: string, value: unknown): boolean {
  try {
    if (isEmpty(value)) {
      localStorage.removeItem(PREFIX + key);
      return false;
    }
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
    return true;
  } catch {
    return false;
  }
}

/** A stash written in the last day, or null. Reading doesn't clear it. */
export function unstash<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { at, value } = JSON.parse(raw) as { at: number; value: T };
    if (typeof at !== "number" || Date.now() - at > MAX_AGE_MS) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function dropStash(key: string) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {}
}

/** Stash whatever `get` returns right before a forced reload. Null means nothing to keep. */
export function useStashOnReload(key: string, get: () => unknown) {
  const ref = useRef(get);
  ref.current = get;
  useEffect(() => {
    const saver = () => ref.current();
    savers.set(key, saver);
    return () => {
      if (savers.get(key) === saver) savers.delete(key);
    };
  }, [key]);
}

/** Run every saver, and remember this page if any of them kept something. */
export function stashBeforeReload() {
  let kept = false;
  for (const [key, get] of savers) {
    let value: unknown = null;
    try {
      value = get();
    } catch {}
    if (stash(key, value)) kept = true;
  }
  if (kept) stash(RETURN_TO, location.pathname + location.search);
}

/**
 * The new launch link lands on /. If a reload stashed edits on another page,
 * go back there once so they're restored.
 */
export function resumeReturnPath() {
  const path = unstash<string>(RETURN_TO);
  dropStash(RETURN_TO);
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return;
  try {
    if (location.pathname === "/" && !location.search && path !== "/") history.replaceState(null, "", path);
  } catch {}
}
