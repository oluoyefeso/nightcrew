import type { Task } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, useInvalidateTasks } from "../api";
import { Button } from "./ui";

export function RecoveryPanel({ task }: { task: Task }) {
  const invalidate = useInvalidateTasks();
  const info = useQuery({
    queryKey: ["recovery", task.id, task.lastRunId],
    queryFn: () =>
      api.get<{ checkpoint: { stage: string; at: string } | null; retries: number; reason: string | null }>(
        `/api/tasks/${task.id}/recovery`,
      ),
  });
  const recover = useMutation({
    mutationFn: (mode: string) => api.post(`/api/tasks/${task.id}/recover`, { mode }),
    onSuccess: invalidate,
  });
  if (!task.lastRunId) return null;
  const blocked = task.status === "running" || task.status === "queued" || recover.isPending;
  return (
    <section className="grid gap-3 rounded-xl bg-surface p-4 ring-1 ring-line">
      <h2 className="font-medium">Recovery</h2>
      <p className="text-[13px] text-muted">
        {info.data?.checkpoint ? `Saved ${info.data.checkpoint.stage} checkpoint. ` : "No reusable checkpoint yet. "}
        Resume checks that the task and commit still match. Verify repeats checks and review without agent edits.
        Rebuild revisits the saved work with a new plan.
      </p>
      {info.data?.reason && <p className="text-[13px] text-dawn">{info.data.reason}</p>}
      <p className="text-[12px] text-muted">
        Automatic retries used: {info.data?.retries ?? 0}. Flaky failures get one retry; rate limits and crashes stop
        after two.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={blocked} onClick={() => recover.mutate("auto")}>
          Resume
        </Button>
        <Button disabled={blocked || info.data?.checkpoint?.stage !== "build"} onClick={() => recover.mutate("verify")}>
          Verify saved build
        </Button>
        <Button variant="ghost" disabled={blocked} onClick={() => recover.mutate("rebuild")}>
          Rebuild
        </Button>
      </div>
      {recover.error && (
        <p role="alert" className="text-bad">
          {recover.error.message}
        </p>
      )}
    </section>
  );
}
