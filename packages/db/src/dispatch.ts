import { eq } from "drizzle-orm";
import type { Db } from "./index";
import { settings } from "./schema";

// Internal state: omitted from getSettings and not writable through the settings API.
const BACKOFF_KEY = "internal.dispatchBackoff";
export interface DispatchBackoff {
  until: number;
  strikes: number;
}

export function getDispatchBackoff(db: Db): DispatchBackoff {
  const row = db.select().from(settings).where(eq(settings.key, BACKOFF_KEY)).get();
  const value = row?.value as Partial<DispatchBackoff> | null | undefined;
  if (
    value &&
    Number.isSafeInteger(value.until) &&
    value.until! >= 0 &&
    Number.isSafeInteger(value.strikes) &&
    value.strikes! >= 0
  ) {
    return { until: value.until!, strikes: value.strikes! };
  }
  return { until: 0, strikes: 0 };
}

export function saveDispatchBackoff(db: Db, value: DispatchBackoff): void {
  if (
    !Number.isSafeInteger(value.until) ||
    value.until < 0 ||
    !Number.isSafeInteger(value.strikes) ||
    value.strikes < 0
  )
    throw new Error("Invalid dispatch cooldown.");
  db.insert(settings)
    .values({ key: BACKOFF_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
