import { decisionFor, formatTokens, type Mission, type MissionSummary, needsDecision } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pause, Play, Plus } from "lucide-react";
import { useState } from "react";
import { api, missionQuery, missionsQuery, tasksQuery, useInvalidateTasks } from "../api";
import { Field, Select, TextArea, TextInput } from "../components/form";
import { MissionAcceptancePanel } from "../components/mission-acceptance";
import { MissionControls, missionControlPatch, missionControlValues } from "../components/mission-controls";
import { Button } from "../components/ui";

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
          {stopped ? "Stop time reached" : mission.paused ? "Paused" : "Active"}
        </span>
      </div>
      <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted">{mission.objective}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span>
          {mission.counts.total} {mission.counts.total === 1 ? "task" : "tasks"}
        </span>
        {mission.counts.running > 0 && <span>{mission.counts.running} working</span>}
        {mission.counts.needsYou > 0 && <span className="text-dawn">{mission.counts.needsYou} need review</span>}
        <span>{formatTokens(mission.tokensUsed)} tokens used</span>
        {mission.stopAt && <span>Stop work at {new Date(mission.stopAt).toLocaleString()}</span>}
        <span className="ml-auto text-fg group-hover:text-dawn">Open goal →</span>
      </div>
    </Link>
  );
}

export function MissionsPage() {
  const missions = useQuery(missionsQuery);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [controls, setControls] = useState(() => missionControlValues());
  const [paused, setPaused] = useState(true);
  const invalidate = useInvalidateTasks();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () =>
      api.post<Mission>("/api/missions", {
        title: title.trim() || objective.trim().split(/\r?\n/)[0]?.slice(0, 80),
        objective: objective.trim(),
        paused,
        ...missionControlPatch(controls),
      }),
    onSuccess: (mission) => {
      invalidate();
      navigate({ to: "/missions/$missionId", params: { missionId: mission.id } });
    },
  });
  return (
    <div className="mx-auto grid max-w-[920px] gap-10 px-4 pt-8 pb-24 sm:px-8 lg:pt-12">
      <header className="grid gap-2">
        <h1 className="text-[30px] font-medium tracking-[-0.03em]">Goals</h1>
        <p className="max-w-[620px] text-[14px] text-muted">
          Set the direction. Keep progress, decisions and evidence together.
        </p>
      </header>
      <form
        id="new-goal"
        aria-labelledby="new-goal-title"
        className="grid scroll-mt-20 gap-5 rounded-xl border border-line bg-surface p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 id="new-goal-title" className="text-[16px] font-medium">
          What do you want to achieve?
        </h2>
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
        <Field
          label="What does done look like?"
          htmlFor="mission-criteria"
          hint="Optional for now. Add one checkable outcome per line."
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
        <details className="border-y border-line py-3">
          <summary className="cursor-pointer text-[13px] text-muted hover:text-fg">
            Details & limits <span className="ml-2 text-[11px]">Optional</span>
          </summary>
          <div className="mt-5 grid gap-4">
            <Field label="Goal name" htmlFor="mission-title" hint="Leave blank to use the first line of your outcome.">
              <TextInput
                id="mission-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="Make onboarding effortless"
              />
            </Field>
            <MissionControls values={controls} onChange={setControls} includeCriteria={false} />
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="accent-dawn"
              />
              Start paused while I review the work
            </label>
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
            <p>
              {paused
                ? "Saved paused. Next, draft and review the work before starting."
                : "Next, draft the work. Queued tasks may start within your crew's limits."}
            </p>
          </div>
          <Button type="submit" variant="primary" disabled={create.isPending || !objective.trim()}>
            <Plus className="size-3.5" />
            {create.isPending ? "Creating…" : "Create goal"}
          </Button>
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
            Couldn't load goals. {missions.error.message}
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

export function MissionPage({ missionId }: { missionId: string }) {
  const detail = useQuery(missionQuery(missionId));
  const available = useQuery(tasksQuery([]));
  const invalidate = useInvalidateTasks();
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
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
      navigate({ to: "/missions" });
    },
  });
  if (detail.error)
    return (
      <div className="grid gap-4 p-8">
        <Link to="/missions" className="text-dawn">
          ← Missions
        </Link>
        <p role="alert" className="text-bad">
          {detail.error.message}
        </p>
      </div>
    );
  if (!detail.data) return <p className="p-8 text-muted">Loading goal…</p>;
  const { mission, tasks } = detail.data;
  const holds = tasks.filter((entry) => entry.departure?.kind === "setup").length;
  const questions = tasks.filter((entry) => entry.task.question).length;
  return (
    <div className="mx-auto grid max-w-[1080px] gap-7 px-4 pt-8 pb-24 sm:px-8 lg:pt-12">
      <Link to="/missions" className="inline-flex items-center gap-2 text-[13px] text-muted">
        <ArrowLeft className="size-4" />
        Goals
      </Link>
      <header className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="t-h1 break-words min-w-0">{mission.title}</h1>
          <Button onClick={() => change.mutate(!mission.paused)} disabled={change.isPending}>
            {mission.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {mission.paused ? "Resume goal" : "Pause goal"}
          </Button>
        </div>
        <p className="whitespace-pre-wrap text-[15px] text-muted leading-relaxed">{mission.objective}</p>
        <p className="text-[13px] text-muted">
          Priority: {["Normal", "Raised", "High", "Urgent"][mission.priority]} · Token limit:{" "}
          {mission.tokenBudget === null ? "Daily budget only" : formatTokens(mission.tokenBudget)}
          {mission.stopAt
            ? ` · Stop work at ${new Date(mission.stopAt).toLocaleString()}${Date.parse(mission.stopAt) <= Date.now() ? " (reached)" : ""}`
            : ""}
          {mission.deadline ? ` · New starts before ${new Date(mission.deadline).toLocaleString()}` : ""}
        </p>
        <p className="text-[12.5px] text-muted">
          {mission.paused
            ? "New starts are paused. Agents already working finish their current run."
            : "Queued tasks may start when departure checks, dependencies and crew limits allow."}{" "}
          Pausing does not change repository merge authority.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/agents"
            search={{ mission: mission.id }}
            className="rounded-full bg-dawn px-4 py-2 text-[13px] font-medium text-on-dawn"
          >
            Draft work for this goal
          </Link>
          <Button variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel editing" : "Edit objective"}
          </Button>
        </div>
        {change.error && (
          <p role="alert" className="text-bad">
            {change.error.message}
          </p>
        )}
      </header>
      {editing && (
        <MissionEditor
          mission={mission}
          onSaved={() => {
            setEditing(false);
            invalidate();
          }}
        />
      )}
      <section aria-label="Mission progress" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Working", mission.counts.running],
          ["Queued", mission.counts.queued],
          ["Need review", mission.counts.needsYou],
          ["Resolved", mission.counts.resolved],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-surface p-4 ring-1 ring-line">
            <p className="text-[12px] text-muted">{label}</p>
            <p className="mt-1 font-mono text-[24px]">{value}</p>
          </div>
        ))}
      </section>
      <p className="text-[12.5px] text-muted">
        {mission.counts.parked} draft or parked · {holds} setup holds · {questions} unanswered questions. Resolved
        includes merged, shipped and dismissed work; it does not certify the mission objective.
      </p>
      <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-2xl bg-surface p-5 text-[13px] ring-1 ring-line">
        <span>
          <b className="font-mono">{formatTokens(mission.tokensUsed)}</b> tokens charged across all attempts dispatched
          for this mission
        </span>
        <span>
          <b className="font-mono">{formatTokens(mission.taskCaps)}</b> combined caps for queued and running tasks
        </span>
        <p className="w-full text-[12px] text-muted">
          Caps are limits, not forecasts or extra reservations. The crew's daily budget still governs dispatch.
        </p>
      </div>
      <section
        aria-label="Mission criterion coverage"
        className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line"
      >
        <h2 className="t-h3">Planned criterion coverage</h2>
        <p className="text-[12px] text-muted">
          See which tasks are intended to support each outcome. Links are planning metadata; acceptance still needs your
          evidence and passing combined checks.
        </p>
        {!mission.criteria.length && (
          <p className="text-[13px] text-dawn">Add acceptance criteria before reviewing coverage.</p>
        )}
        {mission.criteria.map((criterion) => {
          const linked = tasks.filter(({ task }) => task.missionCriteria?.includes(criterion));
          return (
            <div key={criterion} className="grid gap-2 rounded-xl bg-raised/40 p-3">
              <h3 className="text-[13px] font-medium break-words">{criterion}</h3>
              {!linked.length ? (
                <p className="text-[12px] text-dawn">No task linked yet</p>
              ) : (
                linked.map(({ task }) => (
                  <Link
                    key={task.id}
                    to="/task/$taskId"
                    params={{ taskId: task.id }}
                    className="text-[12px] text-dawn break-words"
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
      <section aria-label="Mission tasks" className="grid gap-3">
        <h2 className="t-h3">Tasks · {mission.counts.total}</h2>
        {tasks.map(({ task, run, departure }) => (
          <article key={task.id} className="grid gap-2 rounded-2xl bg-surface p-5 ring-1 ring-line">
            <div className="flex flex-wrap justify-between gap-2">
              <Link to="/task/$taskId" params={{ taskId: task.id }} className="font-medium hover:text-dawn">
                {task.title}
              </Link>
              <span className="text-[12px] text-muted">
                {task.repoName} ·{" "}
                {task.status === "done"
                  ? run
                    ? needsDecision(run)
                      ? decisionFor(run).label
                      : "Resolved"
                    : "Needs review"
                  : { queued: "Queued", running: "Working", draft: "Draft", later: "Parked", archived: "Archived" }[
                      task.status
                    ]}
              </span>
            </div>
            {departure && <p className="text-[13px] text-dawn">{departure.reason}</p>}
            {task.question && <p className="text-[13px] text-dawn">Question: {task.question}</p>}
            {task.status === "done" && run && needsDecision(run) && (
              <p className="text-[13px] text-dawn">{decisionFor(run).reason}</p>
            )}
            {task.dependsOn.length > 0 && (
              <p className="text-[12px] text-muted">
                Prerequisites:{" "}
                {task.dependsOn
                  .map((id) => available.data?.find((t) => t.id === id)?.title ?? "Missing task")
                  .join(", ")}
              </p>
            )}
            <div className="flex flex-wrap gap-4 text-[12.5px] text-dawn">
              <Link to="/task/$taskId" params={{ taskId: task.id }}>
                Edit task & departure checks →
              </Link>
              {run &&
                (run.status === "running" ? (
                  <Link to="/run/$runId" params={{ runId: run.id }}>
                    Watch active run →
                  </Link>
                ) : (
                  <Link to="/" search={{ run: run.id }}>
                    Inspect latest run →
                  </Link>
                ))}
            </div>
          </article>
        ))}
        {!tasks.length && (
          <p className="text-[14px] text-muted">
            No tasks yet. Draft work for this objective or attach an existing task below.
          </p>
        )}
      </section>
      <section className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line">
        <h2 className="text-[14px] font-medium">Attach an existing task</h2>
        <p className="text-[12.5px] text-muted">
          Unassigned tasks keep their current status, scope and dependencies. Move tasks between missions in the task
          editor; running tasks stay in their mission until they stop.
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
        {attach.error && (
          <p role="alert" className="text-bad">
            {attach.error.message}
          </p>
        )}
      </section>
      <MissionAcceptancePanel key={`${mission.id}:${JSON.stringify(mission.criteria)}`} mission={mission} />
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
        ...missionControlPatch(controls),
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
      <MissionControls values={controls} onChange={setControls} />
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
          Save objective
        </Button>
      </div>
    </form>
  );
}
