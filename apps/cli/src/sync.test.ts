import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb, schema, upsertRuns } from "@nightcrew/db";
import { eq } from "drizzle-orm";
import * as github from "./github";

// syncClassic calls prInfoMany directly. Stand in for GitHub only while a test
// sets `fresh`; otherwise defer to the real module so other files are untouched.
let fresh: Map<string, github.PrInfo> | null = null;
const real = { ...github };
mock.module("./github", () => ({
  ...real,
  prInfoMany: (urls: string[], concurrency?: number) =>
    fresh ? Promise.resolve(fresh) : real.prInfoMany(urls, concurrency),
}));
const { syncClassic } = await import("./sync");

const PR = "https://github.com/o/r/pull/13";
const RUN_ID = "pagination@2026-04-17T11:31:41Z";
let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nc-sync-"));
  const dir = join(root, "state", "sessions", "2026-04-17T111503Z");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "progress.json"),
    JSON.stringify({ tasks: { pagination: { status: "complete", started_at: "2026-04-17T11:31:41Z", pr_url: PR } } }),
  );
  db = openDb(":memory:");
  fresh = null;
});
afterEach(() => {
  fresh = null;
  rmSync(root, { recursive: true, force: true });
});

const stored = () => db.select().from(schema.runs).where(eq(schema.runs.id, RUN_ID)).get();

describe("syncClassic", () => {
  // Value: protects=an offline re-sync keeps the merged PR state and real title an earlier sync recorded, while fresh GitHub info replaces them; fails_when=the keep list is dropped (merged regresses to draft, the title to the task id) or applied even when GitHub answered; why_new=the keep decision had no test; seam=bun mock.module of ./github (syncClassic takes no PR lookup)
  test("offline keeps what an earlier sync recorded; fresh GitHub state wins", async () => {
    await syncClassic(db, { root, cwd: root, github: false });
    expect(stored()).toMatchObject({ prState: "draft", title: "Pagination" });

    // What an earlier online sync would have written.
    const run = stored();
    if (!run) throw new Error("run not imported");
    upsertRuns(db, [{ run: { ...run, prState: "merged", title: "Add cursor pagination" }, artifacts: [] }]);

    const offline = await syncClassic(db, { root, cwd: root, github: false });
    expect(offline).toEqual({ root, runs: 1, prsChecked: 0 });
    expect(stored()).toMatchObject({ prState: "merged", title: "Add cursor pagination" });

    fresh = new Map([
      [
        PR,
        {
          state: "closed",
          branch: "crew/pagination",
          additions: 12,
          deletions: 3,
          changedFiles: 2,
          title: "Pagination v2",
        },
      ],
    ]);
    const online = await syncClassic(db, { root, cwd: root, github: true });
    expect(online.prsChecked).toBe(1);
    expect(stored()).toMatchObject({
      prState: "closed",
      title: "Pagination v2",
      branch: "crew/pagination",
      additions: 12,
    });
  });
});
