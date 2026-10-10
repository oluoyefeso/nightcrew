// Unsaved edits that survive the reload a restart forces (a new launch key).
// localStorage, not sessionStorage: the new launch link usually opens in a
// new tab, which starts with empty session storage.

import { useEffect, useRef } from "react";

const PREFIX = "nc-pending-";
const RETURN_TO = "nc-return-to";
/** A stash older than this is dropped rather than restored over newer work. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const RESTORED_NOTE = "Restored unsaved edits from before the restart.";

type Saver = () => unknown;
const savers = new Map<string, Saver>();

/** Write a stash now. A null or empty value clears it. */
export function stash(key: string, value: unknown) {
  try {
    if (value == null || (typeof value === "string" && !value.trim())) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {}
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
    stash(key, value);
    if (value != null && !(typeof value === "string" && !value.trim())) kept = true;
  }
  try {
    if (kept)
      localStorage.setItem(RETURN_TO, JSON.stringify({ at: Date.now(), path: location.pathname + location.search }));
  } catch {}
}

/**
 * The new launch link lands on /. If a reload stashed edits on another page,
 * go back there once so they're restored.
 */
export function resumeReturnPath() {
  try {
    const raw = localStorage.getItem(RETURN_TO);
    if (!raw) return;
    localStorage.removeItem(RETURN_TO);
    const { at, path } = JSON.parse(raw) as { at: number; path: string };
    if (Date.now() - at > MAX_AGE_MS || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
      return;
    if (location.pathname === "/" && !location.search && path !== "/") history.replaceState(null, "", path);
  } catch {}
}
