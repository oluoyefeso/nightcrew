import type { Run } from "./model";
import type { QueueEntry } from "./station";
import type { Task } from "./tasks";

/** An objective shared by tasks; repository routes remain the authority boundary. */
export interface Mission {
  id: string;
  title: string;
  objective: string;
  paused: boolean;
  criteria: string[];
  tokenBudget: number | null;
  priority: number;
  deadline: string | null;
  /** Absolute limit for agent execution; active attempts keep their earliest observed limit. */
  stopAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionSummary extends Mission {
  counts: { total: number; running: number; queued: number; parked: number; needsYou: number; resolved: number };
  /** All local attempts charged to this mission at dispatch, including detached or deleted tasks. */
  tokensUsed: number;
  taskCaps: number;
  repos: string[];
}

export interface MissionDetail {
  mission: MissionSummary;
  tasks: { task: Task; run: Run | null; departure: QueueEntry | null }[];
}

export const MISSION_STOP_REASON = "Mission stop deadline reached.";

/** Invalid stored limits fail closed; an absent limit leaves execution unbounded by the mission. */
export function missionStopTime(stopAt: string | null | undefined): number | null {
  if (stopAt == null) return null;
  const time = Date.parse(stopAt);
  return Number.isFinite(time) ? time : 0;
}
