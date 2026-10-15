// Model connections: a compatible endpoint NightCrew can talk to, and what a
// bounded synthetic check observed. Credentials are never stored here; a
// connection only names the environment variable that holds the key.

export interface ConnectionTarget {
  baseUrl: string;
  model: string;
  /** Name of the environment variable holding the key. Never the key itself. */
  apiKeyEnv: string | null;
}

export interface ConnectionUsage {
  /** reported: every response carried counters. partial: some did. unknown: none did. */
  status: "reported" | "partial" | "unknown";
  inputObserved: number | null;
  outputObserved: number | null;
}

export interface ConnectionCheck {
  status: "passed" | "failed" | "cancelled";
  /** A fixed, sanitized sentence. Never provider text. */
  summary: string;
  at: string;
  model: string;
  turns: number;
  elapsedMs: number;
  usage: ConnectionUsage;
}

export interface ModelConnection extends ConnectionTarget {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastCheck: ConnectionCheck | null;
}
