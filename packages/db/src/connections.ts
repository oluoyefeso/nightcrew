import type { ConnectionCheck, ModelConnection } from "@nightcrew/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./index";
import { auditEvent } from "./operations";
import { modelConnections } from "./schema";

export type ConnectionInput = Pick<ModelConnection, "name" | "baseUrl" | "model" | "apiKeyEnv">;

export function listConnections(db: Db): ModelConnection[] {
  return db.select().from(modelConnections).orderBy(asc(modelConnections.createdAt), asc(modelConnections.id)).all();
}
export function getConnection(db: Db, id: string): ModelConnection | null {
  return db.select().from(modelConnections).where(eq(modelConnections.id, id)).get() ?? null;
}
/** Copy only profile fields; credential values are never part of this record. */
function fields(input: ConnectionInput): ConnectionInput {
  return { name: input.name, baseUrl: input.baseUrl, model: input.model, apiKeyEnv: input.apiKeyEnv };
}
export function createConnection(db: Db, input: ConnectionInput): ModelConnection {
  return db.transaction(() => {
    const at = new Date().toISOString();
    const connection: ModelConnection = {
      ...fields(input),
      id: `connection_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      lastCheck: null,
    };
    db.insert(modelConnections).values(connection).run();
    auditEvent(db, "you", "connection.created", connection.id);
    return connection;
  });
}
/** A changed endpoint, credential reference or model invalidates the old check. */
export function updateConnection(db: Db, id: string, revision: number, input: ConnectionInput): ModelConnection | null {
  return db.transaction(() => {
    const row = db
      .update(modelConnections)
      .set({ ...fields(input), revision: revision + 1, updatedAt: new Date().toISOString(), lastCheck: null })
      .where(and(eq(modelConnections.id, id), eq(modelConnections.revision, revision)))
      .returning()
      .get();
    if (row) auditEvent(db, "you", "connection.updated", id);
    return row ?? null;
  });
}
export function deleteConnection(db: Db, id: string, revision: number): boolean {
  return db.transaction(() => {
    const row = db
      .delete(modelConnections)
      .where(and(eq(modelConnections.id, id), eq(modelConnections.revision, revision)))
      .returning({ id: modelConnections.id })
      .get();
    if (row) auditEvent(db, "you", "connection.deleted", id);
    return Boolean(row);
  });
}
/** An in-flight result can never certify a profile that changed or was deleted. */
export function saveConnectionCheck(
  db: Db,
  id: string,
  revision: number,
  result: ConnectionCheck,
): ModelConnection | null {
  return db.transaction(() => {
    const current = getConnection(db, id);
    if (!current || current.model !== result.model) return null;
    const row = db
      .update(modelConnections)
      .set({ lastCheck: result })
      .where(and(eq(modelConnections.id, id), eq(modelConnections.revision, revision)))
      .returning()
      .get();
    if (row) auditEvent(db, "you", `connection.check.${result.status}`, id);
    return row ?? null;
  });
}
