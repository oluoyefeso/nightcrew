import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionCheck } from "@nightcrew/core";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  saveConnectionCheck,
  updateConnection,
} from "./connections";
import { openDb } from "./index";

const profile = {
  name: "Example",
  baseUrl: "https://example.com/v1",
  model: "example-model",
  apiKeyEnv: "MODEL_API_KEY",
};
const check: ConnectionCheck = {
  status: "passed",
  summary: "Synthetic exchange passed.",
  model: profile.model,
  at: "2027-01-01T12:00:00.000Z",
  turns: 2,
  elapsedMs: 30,
  usage: { status: "unknown", inputObserved: null, outputObserved: null },
};

test("connection migration and check results survive a database restart without storing credential values", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightcrew-connection-"));
  const file = join(dir, "test.db");
  let db = openDb(file);
  try {
    const extra = { ...profile, apiKey: "synthetic-secret" };
    const created = createConnection(db, extra);
    saveConnectionCheck(db, created.id, created.revision, check);
    db.$client.close();
    db = openDb(file);
    expect(listConnections(db)).toHaveLength(1);
    expect(getConnection(db, created.id)).toMatchObject({ ...profile, lastCheck: check });
    expect(JSON.stringify(db.$client.query("SELECT * FROM model_connections").all())).not.toContain("synthetic-secret");
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("results cannot certify an edited, removed or differently named model", () => {
  const db = openDb(":memory:");
  try {
    const c = createConnection(db, profile);
    expect(saveConnectionCheck(db, c.id, 1, { ...check, model: "different" })).toBeNull();
    expect(saveConnectionCheck(db, c.id, 1, check)?.lastCheck).toEqual(check);
    expect(updateConnection(db, c.id, 1, profile)).toMatchObject({ revision: 2, lastCheck: null });
    expect(saveConnectionCheck(db, c.id, 1, check)).toBeNull();
    expect(updateConnection(db, c.id, 1, { ...profile, name: "Outdated" })).toBeNull();
    expect(deleteConnection(db, c.id, 1)).toBe(false);
    expect(deleteConnection(db, c.id, 2)).toBe(true);
    expect(saveConnectionCheck(db, c.id, 2, check)).toBeNull();
    expect(listConnections(db)).toEqual([]);
  } finally {
    db.$client.close();
  }
});
