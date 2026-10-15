import { policyEvidence, type ResolvedPolicy, resolvePolicy } from "./policy";
import { type Repo, type Task, taskRoutingError } from "./tasks";

export type DepartureTask = Pick<
  Task,
  | "id"
  | "repoId"
  | "title"
  | "type"
  | "scope"
  | "dependsOn"
  | "tokenBudget"
  | "testCommand"
  | "question"
  | "runAt"
  | "missionId"
> &
  Partial<Pick<Task, "workflow" | "status">>;
export interface DepartureSignal {
  code: string;
  kind: "hold" | "wait" | "notice";
  message: string;
  target: "settings" | "task" | "mission";
  taskId?: string;
  missionId?: string;
}
export interface TaskDeparture {
  taskId: string;
  title: string;
  route: ResolvedPolicy | null;
  evidence: string[];
  tokenBudget: number;
  signals: DepartureSignal[];
}
export interface DepartureReport {
  tasks: TaskDeparture[];
  budget: { daily: number; used: number; reserved: number; available: number; requested: number };
}

/** Configuration holds shared by the preview and the dispatcher. No commands run here. */
export function departureChecks(task: DepartureTask, repo: Repo | null): TaskDeparture {
  const signals: DepartureSignal[] = [];
  const add = (
    code: string,
    message: string,
    target: DepartureSignal["target"] = "settings",
    kind: DepartureSignal["kind"] = "hold",
  ) => signals.push({ code, kind, message, target });
  const routingError = taskRoutingError(task);
  const route = repo && !routingError ? resolvePolicy(repo, task.type) : null;
  if (routingError) add("task-routing", routingError, "task");
  if (!repo) add("repo", "Choose a repository before dispatch.");
  if (task.question?.trim()) add("question", "Answer the crew's question before dispatch.", "task");
  if (!task.title.trim()) add("title", "Give this task a title before dispatch.", "task");
  if (repo && route && route.authority !== "propose") {
    const tests = (task.testCommand ?? repo.testCommand)?.trim();
    if (route.requireTests && !tests)
      add("tests", "This route requires a test command. Set one on the task or repository.");
    else if (!tests)
      add("tests-optional", "No test command is configured. Automated tests will not run.", "settings", "notice");
    if (route.visual && !repo.previewCommand?.trim())
      add("preview", "This route requires visual evidence. Set a preview command on the repository.");
    if (route.authority === "ship" && (!repo.shipBranch || !repo.allowShip.length))
      add("ship", "Shipping needs a destination branch and allowed paths.");
    if (!task.scope.length)
      add(
        "scope",
        "Scope covers the whole repository. Narrow it if the work only needs a few paths.",
        "task",
        "notice",
      );
  }
  return {
    taskId: task.id,
    title: task.title,
    route,
    evidence: route ? policyEvidence(route) : [],
    tokenBudget: task.tokenBudget,
    signals,
  };
}

/** Conservative scope hint, not proof of a conflict: compare the literal prefixes of globs. */
export function scopesMayOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  const prefix = (s: string) => s.replace(/^(\.\/)+/, "").split(/[*?[\]{}!]/, 1)[0] ?? "";
  return a.some((left) =>
    b.some((right) => {
      const x = prefix(left),
        y = prefix(right);
      return x.startsWith(y) || y.startsWith(x);
    }),
  );
}
