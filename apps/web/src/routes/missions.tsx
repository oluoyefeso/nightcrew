import { decisionFor, formatTokens, type Mission, type MissionSummary, needsDecision, type Run } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowLeft, Pause, Play, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, missionQuery, missionsQuery, reposQuery, tasksQuery, toast, useInvalidateTasks } from "../api";
import { Field, Select, TextArea, TextInput } from "../components/form";
import { GoalAnswer, GoalConductorPanel } from "../components/goal-conductor";
import { MissionAcceptancePanel } from "../components/mission-acceptance";
import {
  GoalLimitsEditor,
  MissionControls,
  missionControlPatch,
  missionControlValues,
} from "../components/mission-controls";
import { useProjectChoice } from "../components/project-choice";
import { RunPane } from "../components/run-pane";
import { Button } from "../components/ui";
import { isTypingTarget } from "../lib";
import { GoalWork } from "./agents";

function goalTitle(objective: string) {
  const first = objective.trim().split(/\r?\n|(?<=[.!?])\s+/)[0] ?? "";
  return first.length <= 80
    ? first
    : `${first
        .slice(0, 76)
        .replace(/\s+\S*$/, "")
        .trimEnd()}…`;
}

export function MissionCard({ mission }: { mission: MissionSummary }) {
  const stopped = Boolean(mission.stopAt && Date.parse(mission.stopAt) <= Date.now());
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: mission.id }}
      className="group grid gap-2 px-4 py-4 transition-colors hover:bg-raised/50 sm:px-5"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="min-w-0 break-words font-medium text-[14px]">{mission.title}</h3>
        <span className="shrink-0 text-[11px] text-muted">
          {stopped
            ? "Stop time reached"
            : mission.paused
              ? "Paused"
              : mission.conductor
                ? {
                    planning: "Planning",
                    working: "Working",
                    verifying: "Verifying",
                    needs_you: "Needs you",
                    paused: "Paused",
                    ready: "Verified",
                  }[mission.conductor.state]
                : "Active"}
        </span>
      </div>
      {mission.objective !== mission.title && (
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted">{mission.objective}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span>
          {mission.counts.total} {mission.counts.total === 1 ? "task" : "tasks"}
        </span>
        {mission.counts.running > 0 && <span>{mission.counts.running} working</span>}
        {!mission.conductor && mission.counts.needsYou > 0 && (
          <span className="text-dawn">{mission.counts.needsYou} need review</span>
        )}
        <span>
          {formatTokens(mission.tokensUsed)} tokens {mission.conductor ? "accounted" : "used"}
        </span>
        {mission.stopAt && <span>Stop work at {new Date(mission.stopAt).toLocaleString()}</span>}
        <span className="ml-auto text-fg group-hover:text-dawn">Open goal →</span>
      </div>
    </Link>
  );
}

export function MissionsPage() {
  const missions = useQuery(missionsQuery);
  const repos = useQuery(reposQuery);
  const [activeRepo, setRepoId] = useProjectChoice(repos.data);
  const hash = useRouterState({ select: (s) => s.location.hash });
  const creating = hash === "new-goal" || missions.data?.length === 0;
  const [objective, setObjective] = useState("");
  const [controls, setControls] = useState(() => missionControlValues());
  const invalidate = useInvalidateTasks();
  const navigate = useNavigate();
  useEffect(() => {
    if (hash === "new-goal") document.getElementById("mission-objective")?.focus({ preventScroll: true });
  }, [hash]);
  const create = useMutation({
    mutationFn: (start: boolean) =>
      api.post<Mission>("/api/missions", {
        title: goalTitle(objective),
        objective: objective.trim(),
        paused: !start,
        ...missionControlPatch(controls),
        ...(start ? { conductor: { repoId: activeRepo } } : {}),
      }),
    onSuccess: (mission) => {
      invalidate();
      navigate({ to: "/missions/$missionId", params: { missionId: mission.id } });
    },
  });
  return (
    <div className="mx-auto grid max-w-[920px] gap-10 px-4 pt-8 pb-24 sm:px-8 lg:pt-12">
      <header className="grid gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-[30px] font-medium tracking-[-0.03em]">Goals</h1>
          {!creating && (
            <Link
              to="/missions"
              hash="new-goal"
              className="inline-flex items-center gap-2 rounded-lg bg-fg px-3 py-2 text-[13px] text-bg"
            >
              <Plus className="size-3.5" /> New goal
            </Link>
          )}
        </div>
        <p className="max-w-[620px] text-[14px] text-muted">
          Set the direction. Keep progress, decisions and evidence together.
        </p>
      </header>
      <form
        hidden={!creating}
        id="new-goal"
        aria-labelledby="new-goal-title"
        className={clsx(
          "scroll-mt-20 gap-5 rounded-xl border border-line bg-surface p-5 sm:p-6",
          creating ? "grid" : "hidden",
        )}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(true);
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="new-goal-title" className="text-[16px] font-medium">
            What do you want to achieve?
          </h2>
          {!!missions.data?.length && (
            <Link to="/missions" className="text-[13px] text-muted">
              Back to goals
            </Link>
          )}
        </div>
        <Field label="Outcome" htmlFor="mission-objective">
          <TextArea
            id="mission-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            required
            maxLength={10000}
            placeholder="Make onboarding effortless. New users should reach their first useful result without getting stuck."
            rows={3}
          />
        </Field>
        {repos.data && repos.data.length > 1 && (
          <Field label="Project" htmlFor="new-goal-project">
            <Select id="new-goal-project" value={activeRepo} onChange={(event) => setRepoId(event.target.value)}>
              <option value="">Choose where the crew should work</option>
              {repos.data.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {repos.data?.length === 1 && <p className="text-[13px] text-muted">Project · {repos.data[0]?.name}</p>}
        {repos.data?.length === 0 && (
          <Link to="/settings" className="text-[13px] text-dawn">
            Connect a project to start work →
          </Link>
        )}
        {repos.error && (
          <p role="alert" className="text-bad">
            Couldn't load projects.{" "}
            <button type="button" className="underline" onClick={() => repos.refetch()}>
              Try again
            </button>
          </p>
        )}
        <details className="group">
          <summary className="cursor-pointer text-[13px] text-muted hover:text-fg">Add success criteria</summary>
          <div className="mt-3">
            <Field
              label="What does done look like?"
              htmlFor="mission-criteria"
              hint="Optional. Without these, the crew verifies the outcome you described."
            >
              <TextArea
                id="mission-criteria"
                rows={2}
                value={controls.criteria}
                maxLength={30030}
                placeholder="A new user can create a workspace and invite a teammate."
                onChange={(e) => setControls({ ...controls, criteria: e.target.value })}
              />
            </Field>
          </div>
        </details>
        <details className="border-y border-line py-3">
          <summary className="cursor-pointer text-[13px] text-muted hover:text-fg">
            Budget & deadline <span className="ml-2 text-[11px]">Optional</span>
          </summary>
          <div className="mt-5 grid gap-4">
            <MissionControls values={controls} onChange={setControls} includeCriteria={false} simple />
          </div>
        </details>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid max-w-[520px] gap-1 text-[12px] text-muted">
            <p>
              {controls.budget
                ? `${formatTokens(Number(controls.budget))} goal token limit. `
                : "Daily crew budget applies. "}
              Repository authority stays in place.
            </p>
            <p>The crew plans, executes and verifies. It brings questions back here.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={create.isPending || !objective.trim()}
              onClick={(event) => {
                if (event.currentTarget.form?.reportValidity()) create.mutate(false);
              }}
            >
              Save for later
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending || !objective.trim() || !activeRepo}>
              <Plus className="size-3.5" />
              {create.isPending ? (create.variables ? "Starting…" : "Saving…") : "Start goal"}
            </Button>
          </div>
        </div>
        {create.error && (
          <p role="alert" className="text-[13px] text-bad">
            {create.error.message}
          </p>
        )}
      </form>
      <section aria-label="Goals" className="grid gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[14px] font-medium">Your goals</h2>
          {missions.data && <span className="font-mono text-[12px] text-muted">{missions.data.length}</span>}
        </div>
        {missions.isPending && <p className="text-[13px] text-muted">Loading goals…</p>}
        {missions.error && (
          <p role="alert" className="text-bad">
            Couldn't load goals. {missions.error.message}{" "}
            <button type="button" className="underline" onClick={() => missions.refetch()}>
              Try again
            </button>
          </p>
        )}
        {Boolean(missions.data?.length) && (
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {missions.data?.map((mission) => (
              <MissionCard key={mission.id} mission={mission} />
            ))}
          </div>
        )}
        {missions.data?.length === 0 && (
          <p className="text-[13px] text-muted">
            Your first goal starts above. Its progress and evidence will stay together here.
          </p>
        )}
      </section>
    </div>
  );
}

export function MissionPage({ missionId, runId }: { missionId: string; runId?: string }) {
  const detail = useQuery(missionQuery(missionId));
  const available = useQuery(tasksQuery([]));
  const invalidate = useInvalidateTasks();
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<"goal" | "limits" | null>(null);
  const navigate = useNavigate();
  const opener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousRun = useRef(runId);
  const closeEvidence = useCallback(() => {
    void navigate({ to: "/missions/$missionId", params: { missionId }, search: {}, resetScroll: false });
  }, [missionId, navigate]);
  useEffect(() => {
    if (previousRun.current && !runId) {
      (opener.current?.isConnected ? opener.current : heading.current)?.focus();
    }
    previousRun.current = runId;
  }, [runId]);
  const change = useMutation({
    mutationFn: (paused: boolean) => api.patch(`/api/missions/${missionId}`, { paused }),
    onSuccess: invalidate,
  });
  const attach = useMutation({
    mutationFn: () => api.patch(`/api/tasks/${selected}`, { missionId }),
    onSuccess: () => {
      setSelected("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/missions/${missionId}`),
    onSuccess: () => {
      invalidate();
      void navigate({ to: "/missions" });
    },
  });
  if (detail.error)
    return (
      <div className="grid gap-4 p-8">
        <Link to="/missions" className="text-dawn">
          ← Goals
        </Link>
        <p role="alert" className="text-bad">
          {detail.error.message}
        </p>
      </div>
    );
  if (!detail.data) return <p className="p-8 text-muted">Loading goal…</p>;
  const { mission, tasks } = detail.data;
  const decisions = tasks.filter(
    ({ task, run, departure }) =>
      task.question ||
      departure?.kind === "setup" ||
      (task.status === "done" &&
        (!run || (mission.conductor ? run.verdict !== "ready" || run.status !== "complete" : needsDecision(run)))),
  );
  const evidenceLink = (run: Run, label = "Inspect evidence") => (
    <Link
      to="/missions/$missionId"
      params={{ missionId }}
      search={{ run: run.id }}
      resetScroll={false}
      onClick={(event) => {
        opener.current = event.currentTarget;
      }}
      className="text-[12.5px] text-dawn hover:underline"
    >
      {label} →
    </Link>
  );
  return (
    <div className={clsx("mx-auto grid max-w-[1440px]", runId && "lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]")}>
      <div className={clsx("min-w-0 px-4 pt-8 pb-24 sm:px-8 lg:pt-12", runId && "hidden lg:block")}>
        <div className="mx-auto grid max-w-[980px] gap-8 [&>*]:min-w-0">
          <Link to="/missions" className="inline-flex w-fit items-center gap-2 text-[13px] text-muted hover:text-fg">
            <ArrowLeft className="size-4" /> Goals
          </Link>
          <header className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[12px] text-muted">
                {mission.stopAt && Date.parse(mission.stopAt) <= Date.now()
                  ? "Stop time reached"
                  : mission.paused
                    ? "New starts paused"
                    : mission.conductor?.state === "ready"
                      ? "Outcome verified"
                      : "Active goal"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={editing === "goal"}
                onClick={() => setEditing(editing === "goal" ? null : "goal")}
              >
                Edit goal
              </Button>
              {tasks.length > 0 && !mission.conductor && (
                <Button onClick={() => change.mutate(!mission.paused)} disabled={change.isPending}>
                  {mission.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  {mission.paused ? "Resume goal" : "Pause goal"}
                </Button>
              )}
            </div>
            <h1
              ref={heading}
              tabIndex={-1}
              className="break-words text-[30px] font-medium tracking-[-0.03em] leading-tight outline-none"
            >
              {mission.title}
            </h1>
            {mission.objective !== mission.title && (
              <p className="whitespace-pre-wrap break-words text-[15px] text-muted leading-relaxed">
                {mission.objective}
              </p>
            )}
            <section
              aria-label="Goal progress"
              className="flex flex-wrap gap-x-5 gap-y-2 border-y border-line py-3 text-[12px] text-muted"
            >
              {(!mission.conductor || mission.counts.running > 0) && <span>{mission.counts.running} working</span>}
              {(!mission.conductor || mission.counts.queued > 0) && <span>{mission.counts.queued} queued</span>}
              {(!mission.conductor || mission.counts.parked > 0) && (
                <span>{mission.counts.parked} draft or parked</span>
              )}
              <span>
                {mission.conductor
                  ? `Checked work: ${tasks.filter(({ run }) => run?.status === "complete" && run.verdict === "ready").length} of ${tasks.length}`
                  : `${mission.counts.resolved} resolved tasks`}
              </span>
              <span>
                {formatTokens(mission.tokensUsed)} tokens {mission.conductor ? "accounted" : "used"}
                {mission.tokenBudget ? ` of ${formatTokens(mission.tokenBudget)}` : ""}
              </span>
              {mission.stopAt && <span>Deadline · {new Date(mission.stopAt).toLocaleString()}</span>}
              <button
                type="button"
                className="text-dawn hover:underline"
                aria-expanded={editing === "limits"}
                onClick={() => setEditing(editing === "limits" ? null : "limits")}
              >
                Budget & deadline
              </button>
            </section>
            {!mission.conductor && (
              <p className="text-[12px] text-muted">
                {mission.paused
                  ? "New starts are paused. Agents already working finish their current run."
                  : "Queued tasks start when departure checks, dependencies and crew limits allow."}
              </p>
            )}
            {change.error && (
              <p role="alert" className="text-bad">
                {change.error.message}
              </p>
            )}
          </header>

          {editing === "goal" && (
            <div className="grid gap-2">
              <MissionEditor
                key={mission.id}
                mission={mission}
                onSaved={() => {
                  setEditing(null);
                  invalidate();
                }}
              />
              <div>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel editing
                </Button>
              </div>
            </div>
          )}
          {editing === "limits" && (
            <GoalLimitsEditor
              key={`limits-${mission.id}`}
              mission={mission}
              onSaved={() => {
                setEditing(null);
                invalidate();
              }}
              onCancel={() => setEditing(null)}
            />
          )}

          <GoalConductorPanel
            key={mission.id}
            mission={mission}
            waiting={tasks.flatMap(({ departure }) => (departure ? [departure] : []))}
          />

          {(decisions.length > 0 || !mission.conductor) && (
            <section aria-label="Goal decisions" className="grid gap-3">
              <h2 className="text-[15px] font-medium">
                {decisions.length ? `Needs your decision · ${decisions.length}` : "No decisions waiting"}
              </h2>
              {decisions.length ? (
                <div className="divide-y divide-line border-y border-line">
                  {decisions.map(({ task, run, departure }) => (
                    <article key={task.id} className="grid gap-2 py-4">
                      <h3 className="break-words text-[14px] font-medium">{task.title}</h3>
                      <p className="whitespace-pre-wrap break-words text-[13px] text-muted">
                        {task.question
                          ? `Question: ${task.question}`
                          : departure?.kind === "setup"
                            ? departure.reason
                            : run
                              ? decisionFor(run).reason
                              : "This task finished without an inspectable run. Review the task before accepting its result."}
                      </p>
                      {task.question && <GoalAnswer taskId={task.id} />}
                      <div className="flex flex-wrap gap-x-5 gap-y-2">
                        {run && evidenceLink(run, "Review decision")}
                        {!task.question && (departure?.kind === "setup" || !run) && (
                          <Link to="/task/$taskId" params={{ taskId: task.id }} className="text-[12.5px] text-dawn">
                            Review task →
                          </Link>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted">
                  {tasks.length
                    ? mission.conductor
                      ? "The crew handles the next steps. You can inspect its work below."
                      : "Work and outcome verification remain visible below."
                    : mission.conductor
                      ? "The crew will surface questions and permission decisions here."
                      : "Start the goal above when you are ready."}
                </p>
              )}
            </section>
          )}

          {!mission.conductor && tasks.length > 0 && (
            <MissionAcceptancePanel key={`${mission.id}:${JSON.stringify(mission.criteria)}`} mission={mission} />
          )}

          <section aria-label="Goal work and evidence" className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[15px] font-medium">
                Work & evidence <span className="ml-2 font-mono text-[12px] text-muted">{tasks.length}</span>
              </h2>
            </div>
            {!mission.conductor && (
              <details>
                <summary className="cursor-pointer text-[12px] text-muted">Prepare work manually</summary>
                <div className="mt-4">
                  <GoalWork key={mission.id} mission={mission} hasTasks={tasks.length > 0} />
                </div>
              </details>
            )}
            {!mission.conductor && (
              <p className="text-[12px] text-muted">
                Resolved includes merged, shipped and dismissed tasks. It does not establish that the goal is achieved.
              </p>
            )}
            <div className="divide-y divide-line border-y border-line">
              {tasks.map(({ task, run, departure }) => (
                <article key={task.id} className="grid gap-2 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <Link
                      to="/task/$taskId"
                      params={{ taskId: task.id }}
                      className="min-w-0 break-words text-[14px] font-medium hover:text-dawn"
                    >
                      {task.title}
                    </Link>
                    <span className="text-[12px] text-muted">
                      {task.status === "done"
                        ? run
                          ? mission.conductor && run.status === "complete" && run.verdict === "ready"
                            ? "Checked"
                            : needsDecision(run)
                              ? decisionFor(run).label
                              : "Resolved"
                          : "Needs review"
                        : {
                            queued: "Queued",
                            running: "Working",
                            draft: "Draft",
                            later: "Parked",
                            archived: "Archived",
                          }[task.status]}
                    </span>
                  </div>
                  <span className="break-words text-[12px] text-muted">{task.repoName}</span>
                  {departure && <p className="break-words text-[12px] text-muted">{departure.reason}</p>}
                  {run?.summary && (
                    <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted">{run.summary}</p>
                  )}
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {run && evidenceLink(run)}
                    {run?.status === "running" && (
                      <Link to="/run/$runId" params={{ runId: run.id }} className="text-[12.5px] text-dawn">
                        Watch live activity →
                      </Link>
                    )}
                    {!mission.conductor && (
                      <Link
                        to="/task/$taskId"
                        params={{ taskId: task.id }}
                        className="text-[12.5px] text-muted hover:text-fg"
                      >
                        Task details →
                      </Link>
                    )}
                  </div>
                  {task.dependsOn.length > 0 && (
                    <p className="break-words text-[12px] text-muted">
                      Prerequisites:{" "}
                      {task.dependsOn
                        .map((id) => available.data?.find((t) => t.id === id)?.title ?? "Missing task")
                        .join(", ")}
                    </p>
                  )}
                </article>
              ))}
              {!tasks.length && <p className="py-4 text-[13px] text-muted">No work attached yet.</p>}
            </div>
          </section>

          <details className="border-y border-line py-4">
            <summary className="cursor-pointer text-[13px] text-muted hover:text-fg">Work details</summary>
            <div className="mt-5 grid gap-6 [&>*]:min-w-0">
              <p className="text-[13px] text-muted">
                Priority: {["Normal", "Raised", "High", "Urgent"][mission.priority]} · Token limit:{" "}
                {mission.tokenBudget === null ? "Daily budget only" : formatTokens(mission.tokenBudget)}
                {mission.stopAt ? ` · Stop work at ${new Date(mission.stopAt).toLocaleString()}` : ""}
                {mission.deadline ? ` · New starts before ${new Date(mission.deadline).toLocaleString()}` : ""}
              </p>
              <p className="text-[12px] text-muted">
                {formatTokens(mission.tokensUsed)} tokens charged across all attempts dispatched for this goal.{" "}
                {formatTokens(mission.taskCaps)} combined caps for queued and running tasks. Caps are limits, not
                forecasts or extra reservations. Daily crew budget and repository authority still apply.
              </p>
              <section aria-label="Goal criterion coverage" className="grid gap-3">
                <h2 className="text-[14px] font-medium">Planned criterion coverage</h2>
                <p className="text-[12px] text-muted">
                  Task links describe intended coverage. Acceptance needs your evidence and passing combined checks.
                </p>
                {!mission.criteria.length && (
                  <p className="text-[13px] text-muted">Add success criteria to review coverage.</p>
                )}
                {mission.criteria.map((criterion) => {
                  const linked = tasks.filter(({ task }) => task.missionCriteria?.includes(criterion));
                  return (
                    <div key={criterion} className="grid gap-2 border-l border-line pl-3">
                      <h3 className="break-words text-[13px] font-medium">{criterion}</h3>
                      {!linked.length ? (
                        <p className="text-[12px] text-dawn">No task linked yet</p>
                      ) : (
                        linked.map(({ task }) => (
                          <Link
                            key={task.id}
                            to="/task/$taskId"
                            params={{ taskId: task.id }}
                            className="break-words text-[12px] text-dawn"
                          >
                            {task.title} · {task.status}
                          </Link>
                        ))
                      )}
                    </div>
                  );
                })}
                {tasks.some(({ task }) => task.missionCriteria?.some((c) => !mission.criteria.includes(c))) && (
                  <p className="text-[12px] text-dawn">
                    Some task links refer to changed or removed criteria. Open those tasks to review their links.
                  </p>
                )}
              </section>
              <section className="grid gap-3">
                <h2 className="text-[14px] font-medium">Attach an existing task</h2>
                <p className="text-[12px] text-muted">
                  Unassigned tasks keep their status, scope and dependencies. Move tasks between goals in the task
                  editor; running tasks stay in their goal until they stop.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Select
                    aria-label="Task to attach"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    className="min-w-0 flex-1"
                  >
                    <option value="">Choose a task…</option>
                    {available.data
                      ?.filter((t) => !t.missionId && t.status !== "running")
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.repoName} · {t.title}
                        </option>
                      ))}
                  </Select>
                  <Button disabled={!selected || attach.isPending} onClick={() => attach.mutate()}>
                    Attach task
                  </Button>
                </div>
                {available.error && (
                  <p role="alert" className="text-bad">
                    Couldn't load tasks. {available.error.message}
                  </p>
                )}
                {attach.error && (
                  <p role="alert" className="text-bad">
                    {attach.error.message}
                  </p>
                )}
              </section>
              {!tasks.length && (
                <div>
                  <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
                    Delete empty goal
                  </Button>
                  {remove.error && (
                    <p role="alert" className="text-bad">
                      {remove.error.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
      {runId && (
        <GoalEvidence
          key={missionId}
          mission={mission}
          runId={runId}
          taskIds={tasks.map(({ task }) => task.id)}
          onClose={closeEvidence}
        />
      )}
    </div>
  );
}

function GoalEvidence({
  mission,
  runId,
  taskIds,
  onClose,
}: {
  mission: Mission;
  runId: string;
  taskIds: string[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: move focus when a different attempt opens
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1023px)").matches) panel.current?.scrollIntoView({ block: "start" });
  }, [runId]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTypingTarget(event.target)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <section
      aria-label="Goal evidence"
      className="min-w-0 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:border-l lg:border-line"
    >
      <div ref={panel} className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-full">
        <p className="truncate border-b border-line px-4 py-3 text-[12px] text-muted">Evidence for {mission.title}</p>
        <div className="min-h-0 flex-1">
          <RunPane runId={runId} allowedTaskIds={taskIds} navigationHint={false} onClose={onClose} onToast={toast} />
        </div>
      </div>
    </section>
  );
}

function MissionEditor({ mission, onSaved }: { mission: Mission; onSaved: () => void }) {
  const [title, setTitle] = useState(mission.title);
  const [objective, setObjective] = useState(mission.objective);
  const [controls, setControls] = useState(() => missionControlValues(mission));
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/missions/${mission.id}`, {
        title,
        objective,
        criteria: missionControlPatch(controls).criteria,
      }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Goal name" htmlFor="mission-title">
        <TextInput
          id="mission-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
      </Field>
      <Field label="Objective" htmlFor="mission-objective">
        <TextArea
          id="mission-objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          required
          maxLength={10000}
          rows={4}
        />
      </Field>
      <Field label="Success criteria" htmlFor="mission-criteria" hint="Optional. One checkable outcome per line.">
        <TextArea
          id="mission-criteria"
          rows={3}
          value={controls.criteria}
          maxLength={30030}
          onChange={(event) => setControls({ ...controls, criteria: event.target.value })}
        />
      </Field>
      <p className="text-[12px] text-muted">
        Changes apply to future attempts. Agents already running keep the objective they started with.
      </p>
      {save.error && (
        <p role="alert" className="text-bad">
          {save.error.message}
        </p>
      )}
      <div>
        <Button type="submit" disabled={save.isPending || !title.trim() || !objective.trim()}>
          Save goal
        </Button>
      </div>
    </form>
  );
}
