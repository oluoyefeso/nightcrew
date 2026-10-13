import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDispatchBackoff, getSettings, openDb, saveDispatchBackoff, schema, updateSettings } from "./index";

test("cooldown survives a closed database without becoming a user-editable setting", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-backoff-"));
  let db = openDb(join(dir, "state.db"));
  try {
    const cooldown = { until: Date.now() + 300_000, strikes: 1 };
    saveDispatchBackoff(db, cooldown);
    db.$client.close();
    db = openDb(join(dir, "state.db"));
    expect(getDispatchBackoff(db)).toEqual(cooldown);
    expect(getSettings(db)).not.toHaveProperty("internal.dispatchBackoff");
    updateSettings(db, { dispatch: false, slackWebhookUrl: null });
    expect(getDispatchBackoff(db)).toEqual(cooldown);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("absent or malformed legacy cooldown data does not strand dispatch", () => {
  const db = openDb(":memory:");
  try {
    expect(getDispatchBackoff(db)).toEqual({ until: 0, strikes: 0 });
    db.insert(schema.settings)
      .values({ key: "internal.dispatchBackoff", value: { until: "invalid", strikes: -1 } })
      .run();
    expect(getDispatchBackoff(db)).toEqual({ until: 0, strikes: 0 });
    expect(() => saveDispatchBackoff(db, { until: Number.NaN, strikes: 1 })).toThrow("Invalid dispatch cooldown");
  } finally {
    db.$client.close();
  }
});
