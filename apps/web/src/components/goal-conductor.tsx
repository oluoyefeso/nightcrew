import type { GoalConductor, GoalResult, Mission, QueueEntry, Repo } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, reposQuery, settingsQuery, useInvalidateTasks } from "../api";
import { Field, Select, TextInput } from "./form";
import { GoalLimitsEditor } from "./mission-controls";
import { useProjectChoice } from "./project-choice";
import { Button } from "./ui";

const labels: Record<GoalConductor["state"], string> = {
  planning: "The crew is planning",
  working: "Work is underway",
  verifying: "Verifying the outcome",
  needs_you: "Needs your judgment",
  paused: "Coordination is paused",
  ready: "Ready for your review",
};
export function GoalConductorPanel({ mission, waiting = [] }: { mission: Mission; waiting?: QueueEntry[] }) {
  const repos = useQuery(reposQuery);
  const settings = useQuery(settingsQuery);
  const [repoId, setRepoId] = useProjectChoice(repos.data);
  const [editingLimits, setEditingLimits] = useState(false);
  const invalidate = useInvalidateTasks();
  const status = useQuery({
    queryKey: ["conductor", mission.id],
    queryFn: () =>
      api.get<{ state: GoalConductor | null; result: GoalResult | null }>(`/api/missions/${mission.id}/conductor`),
    refetchInterval: 2000,
  });
  const state = status.data?.state;
  const activeRepo = state?.repoId || repoId || (repos.data?.length === 1 ? repos.data[0]?.id : "");
  const changed = () => {
    invalidate();
    void status.refetch();
  };
  const start = useMutation({
    mutationFn: () => api.post(`/api/missions/${mission.id}/conductor`, { repoId: activeRepo }),
    onSuccess: changed,
  });
  const stop = useMutation({ mutationFn: () => api.del(`/api/missions/${mission.id}/conductor`), onSuccess: changed });
  const resumeCrew = useMutation({
    mutationFn: () => api.post("/api/crew/resume", {}),
    onSuccess: () => {
      void settings.refetch();
      changed();
    },
  });
  const busy = state && ["planning", "working", "verifying"].includes(state.state) && !mission.paused;
  const result = status.data?.result;
  const crewPaused = settings.data?.dispatch === false;
  const departureHold = waiting.find((entry) => ["budget", "deadline", "setup"].includes(entry.kind));
  const heldForLimits =
    state &&
    (["budget", "deadline"].includes(state.code) ||
      (departureHold && ["budget", "deadline"].includes(departureHold.kind)));
  const project = repos.data?.find((repo) => repo.id === activeRepo);
  const canContinue =
    !state ||
    mission.paused ||
    (state.state === "needs_you" && !["question", "work", "setup", "budget", "deadline"].includes(state.code)) ||
    state.state === "paused";
  return (
    <section aria-label="Goal conductor" className="grid gap-4 rounded-xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px] font-medium" aria-live="polite">
          {state ? labels[state.state] : "Hand this goal to the crew"}
        </h2>
        {busy && (
          <Button size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
            Stop work
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted">
        {state?.state === "ready" && result
          ? result.summary
          : (state?.detail ??
            "The crew plans the work, coordinates agents and verifies the combined result. It asks you when a decision or permission is needed.")}
      </p>
      {departureHold && departureHold.reason !== state?.detail && (
        <p className="text-[13px] text-dawn">{departureHold.reason}</p>
      )}
      {state?.code === "setup" && project && !project.testCommand?.trim() && (
        <GoalProjectCheck
          project={project}
          onSaved={() => {
            void repos.refetch();
            changed();
          }}
        />
      )}
      {!state && repos.data && repos.data.length > 1 && (
        <label htmlFor="conductor-project" className="grid gap-2 text-[13px] text-muted">
          Project
          <Select id="conductor-project" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            <option value="">Choose a project</option>
            {repos.data.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {!state && repos.data?.length === 1 && <p className="text-[12px] text-muted">Project · {repos.data[0]?.name}</p>}
      {!state && repos.data?.length === 0 && (
        <Link to="/settings" className="text-[13px] text-dawn">
          Connect a project to begin →
        </Link>
      )}
      {crewPaused && state && state.state !== "ready" && (
        <div className="grid gap-2 text-[13px]">
          <p className="text-dawn">The whole crew is paused. Resuming allows all eligible queued work to start.</p>
          <div>
            <Button size="sm" disabled={resumeCrew.isPending} onClick={() => resumeCrew.mutate()}>
              Resume crew
            </Button>
          </div>
        </div>
      )}
      {heldForLimits && !editingLimits && (
        <div>
          <Button size="sm" onClick={() => setEditingLimits(true)}>
            Adjust limits
          </Button>
        </div>
      )}
      {editingLimits && (
        <GoalLimitsEditor
          key={mission.id}
          mission={mission}
          showCrewBudget={state?.code === "budget" || departureHold?.kind === "budget"}
          continueInProject={heldForLimits && !crewPaused ? activeRepo : undefined}
          onSaved={() => {
            setEditingLimits(false);
            changed();
          }}
          onCancel={() => setEditingLimits(false)}
        />
      )}
      {canContinue && !heldForLimits && !editingLimits && !(crewPaused && state) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!activeRepo || start.isPending || status.isPending || !!status.error}
            onClick={() => start.mutate()}
          >
            {start.isPending ? "Starting…" : state ? "Continue goal" : "Start goal"}
          </Button>
          <span className="text-[12px] text-muted">Uses model tokens within your limits and project permissions.</span>
        </div>
      )}
      {result && (
        <div className="grid gap-3 border-t border-line pt-4">
          {state?.state !== "ready" && <p className="text-[13px]">{result.summary}</p>}
          {state?.state === "ready" && (
            <p className="text-[12px] text-muted">
              Verified against this goal and the combined code. Merge and delivery follow your project permissions.
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-[13px] text-muted">Evidence & checks</summary>
            <div className="mt-4 grid gap-4">
              {result.criteria.map((criterion) => (
                <div key={criterion.criterion} className="grid gap-2 text-[13px]">
                  <p className="font-medium">
                    {criterion.met ? "Verified" : "Needs work"} · {criterion.criterion}
                  </p>
                  {criterion.evidence.map((evidence) => {
                    const source = result.sources.find((source) => source.id === evidence.source);
                    return (
                      <div
                        key={`${evidence.source}:${evidence.quote}`}
                        className="grid gap-1 border-l border-line pl-3"
                      >
                        <blockquote className="whitespace-pre-wrap break-words text-muted">{evidence.quote}</blockquote>
                        {source?.runId && (
                          <Link
                            to="/missions/$missionId"
                            params={{ missionId: mission.id }}
                            search={{ run: source.runId }}
                            className="text-dawn"
                          >
                            Inspect source evidence →
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {result.checks.map((check) => (
                <pre
                  key={check.detail}
                  role="region"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable check output must be reachable for keyboard scrolling.
                  tabIndex={0}
                  aria-label="Combined check output"
                  className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-3 text-[12px]"
                >
                  {check.ok ? "Combined checks passed" : "Combined checks failed"}
                  {"\n"}
                  {check.detail}
                </pre>
              ))}
              <p className="text-[12px] text-muted">
                {new Date(result.at).toLocaleString()}
                {result.commit ? ` · Commit ${result.commit.slice(0, 8)}` : ""}
              </p>
            </div>
          </details>
        </div>
      )}
      {(start.error || stop.error || status.error || resumeCrew.error || repos.error) && (
        <p role="alert" className="text-[13px] text-bad">
          {(start.error || stop.error || status.error || resumeCrew.error || repos.error)?.message}
        </p>
      )}
    </section>
  );
}

function GoalProjectCheck({ project, onSaved }: { project: Repo; onSaved: () => void }) {
  const [command, setCommand] = useState("");
  const save = useMutation({
    mutationFn: () => api.patch(`/api/repos/${project.id}`, { testCommand: command.trim() }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (command.trim()) save.mutate();
      }}
    >
      <Field
        label="How should the crew test this project?"
        htmlFor="goal-test-command"
        hint="Saved for this project so future goals can verify themselves."
      >
        <TextInput
          id="goal-test-command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="For example, npm test"
          required
        />
      </Field>
      <div>
        <Button type="submit" disabled={!command.trim() || save.isPending}>
          Save test command
        </Button>
      </div>
      {save.error && (
        <p role="alert" className="text-[13px] text-bad">
          {save.error.message}
        </p>
      )}
    </form>
  );
}

export function GoalAnswer({ taskId }: { taskId: string }) {
  const [answer, setAnswer] = useState("");
  const invalidate = useInvalidateTasks();
  const send = useMutation({
    mutationFn: () => api.patch(`/api/tasks/${taskId}`, { answer, status: "queued" }),
    onSuccess: invalidate,
  });
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (answer.trim()) send.mutate();
      }}
    >
      <div className="flex gap-2">
        <TextInput
          aria-label="Your answer"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Your answer"
        />
        <Button type="submit" disabled={!answer.trim() || send.isPending}>
          Answer & continue
        </Button>
      </div>
      {send.error && (
        <p role="alert" className="text-bad">
          {send.error.message}
        </p>
      )}
    </form>
  );
}
