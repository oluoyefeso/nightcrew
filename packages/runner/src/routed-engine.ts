import { type Db, getConnection, getSettings } from "@nightcrew/db";
import { ConnectionEngine } from "./connection-engine";
import { type AgentEngine, admissionResult, ENGINE_PHASES, type EngineEvent, type PhaseRequest } from "./engine";

/** Connection selection is explicit; a missing selected profile never falls back to another provider. */
export class RoutedEngine implements AgentEngine {
  constructor(
    private readonly db: Db,
    private readonly fallback: AgentEngine,
  ) {}
  get name() {
    return getSettings(this.db).executionConnectionId ? "model-connection" : this.fallback.name;
  }
  get capabilities() {
    return getSettings(this.db).executionConnectionId
      ? { phases: ENGINE_PHASES, structuredOutput: true, sessionContinuation: false }
      : this.fallback.capabilities;
  }
  runPhase(req: PhaseRequest, onEvent: (event: EngineEvent) => void) {
    const id = getSettings(this.db).executionConnectionId;
    if (!id) return this.fallback.runPhase(req, onEvent);
    const connection = getConnection(this.db, id);
    if (!connection)
      return Promise.resolve(
        admissionResult("The selected model connection is unavailable. Choose a saved connection before continuing."),
      );
    // Snapshot the endpoint and credential reference for the entire phase.
    return new ConnectionEngine(connection).runPhase(req, onEvent);
  }
}
