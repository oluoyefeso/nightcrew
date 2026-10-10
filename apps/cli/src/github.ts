// PR state and diff stats come from the gh CLI, which the classic runner
// already required. Everything here degrades to "unknown" when gh is missing.

import type { PrState } from "@nightcrew/core";

export interface PrInfo {
  state: PrState;
  branch: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  title: string;
}

export async function prInfo(url: string): Promise<PrInfo | null> {
  const out = await gh([
    "pr",
    "view",
    url,
    "--json",
    "state,isDraft,headRefName,additions,deletions,changedFiles,title",
  ]);
  if (!out.ok) return null;
  try {
    const j = JSON.parse(out.stdout) as {
      state: "OPEN" | "MERGED" | "CLOSED";
      isDraft: boolean;
      headRefName: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      title: string;
    };
    const state: PrState =
      j.state === "MERGED" ? "merged" : j.state === "CLOSED" ? "closed" : j.isDraft ? "draft" : "open";
    return {
      state,
      branch: j.headRefName || null,
      additions: j.additions,
      deletions: j.deletions,
      changedFiles: j.changedFiles,
      title: j.title,
    };
  } catch {
    return null;
  }
}

/** Mark a draft ready and squash-merge it. */
export async function mergePr(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const info = await prInfo(url);
  if (info?.state === "merged") return { ok: true };
  if (info?.state === "draft") {
    const ready = await gh(["pr", "ready", url]);
    if (!ready.ok) return { ok: false, error: ready.stderr || "Could not mark the PR ready." };
  }
  const merged = await gh(["pr", "merge", url, "--squash"]);
  return merged.ok ? { ok: true } : { ok: false, error: merged.stderr || "GitHub refused the merge." };
}

/** Fetch PR info for many URLs, a few at a time. */
export async function prInfoMany(urls: string[], concurrency = 4): Promise<Map<string, PrInfo>> {
  const out = new Map<string, PrInfo>();
  const queue = [...new Set(urls)];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        const info = await prInfo(url);
        if (info) out.set(url, info);
      }
    }),
  );
  return out;
}

async function gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, stdout, stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "The gh CLI is not installed." };
  }
}
