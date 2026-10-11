import type { Run } from "./model";
import type { QueueEntry } from "./station";
import type { Task } from "./tasks";

/** An objective shared by tasks; repository routes remain the authority boundary. */
export interface Mission {
  id: string;
  title: string;
  objective: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MissionSummary extends Mission {
  counts: { total: number; running: number; queued: number; parked: number; needsYou: number; resolved: number };
  /** All local attempts of the tasks currently in this mission, including retries. */
  tokensUsed: number;
  taskCaps: number;
  repos: string[];
}

export interface MissionDetail {
  mission: MissionSummary;
  tasks: { task: Task; run: Run | null; departure: QueueEntry | null }[];
}
