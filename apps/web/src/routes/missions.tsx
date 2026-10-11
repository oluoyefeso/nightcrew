import { decisionFor, formatTokens, type Mission, type MissionSummary, needsDecision } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Flag, Pause, Play, Plus } from "lucide-react";
import { useState } from "react";
import { api, missionQuery, missionsQuery, tasksQuery, useInvalidateTasks } from "../api";
import { Field, Select, TextArea, TextInput } from "../components/form";
import { Button } from "../components/ui";

export function MissionCard({ mission }: { mission: MissionSummary }) {
  return (
    <Link
      to="/missions/$missionId"
      params={{ missionId: mission.id }}
      className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line hover:ring-dawn/50"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium text-[16px]">{mission.title}</h3>
        <span className="shrink-0 text-[12px] text-dawn">{mission.paused ? "Paused" : "Active"}</span>
      </div>
      <p className="line-clamp-2 whitespace-pre-wrap text-[13px] text-muted">{mission.objective}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>{mission.counts.total} tasks</span>
        <span>{mission.counts.running} working</span>
        <span>{mission.counts.needsYou} need review</span>
        <span>{formatTokens(mission.tokensUsed)} tokens used</span>
      </p>
      <span className="text-[12px] text-dawn">Open mission →</span>
    </Link>
  );
}

export function MissionsPage() {
  const missions = useQuery(missionsQuery);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const invalidate = useInvalidateTasks();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.post<Mission>("/api/missions", { title, objective }),
    onSuccess: (mission) => {
      invalidate();
      navigate({ to: "/missions/$missionId", params: { missionId: mission.id } });
    },
  });
  return (
    <div className="mx-auto grid max-w-[1080px] gap-8 px-4 pt-8 pb-24 sm:px-8 lg:pt-12">
      <header className="grid gap-3">
        <span className="t-eyebrow inline-flex items-center gap-2">
          <Flag className="size-4" /> Shared objectives
        </span>
        <h1 className="t-h1">Missions.</h1>
        <p className="max-w-[680px] text-[14px] text-muted">
          Give related tasks an objective, even across repositories. See their progress and decisions together, and
          pause new starts for a whole mission.
        </p>
      </header>
      <form
        className="grid gap-4 rounded-2xl bg-surface p-5 ring-1 ring-line"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="t-h3">Start a mission</h2>
        <Field label="Mission name" htmlFor="mission-title">
          <TextInput
            id="mission-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="Make onboarding effortless"
          />
        </Field>
        <Field label="Objective" htmlFor="mission-objective">
          <TextArea
            id="mission-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            required
            maxLength={10000}
            placeholder="What should be true when the work succeeds?"
            rows={3}
          />
        </Field>
        <p className="text-[12.5px] text-muted">
          Agents receive this objective alongside their task. Scope, verification and merge authority still come from
          each task and repository.
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {create.error && (
            <p role="alert" className="text-[13px] text-bad">
              {create.error.message}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={create.isPending || !title.trim() || !objective.trim()}>
            <Plus className="size-4" />
            Create mission
          </Button>
        </div>
      </form>
      {missions.error && (
        <p role="alert" className="text-bad">
          Couldn't load missions. {missions.error.message}
        </p>
      )}
      <section aria-label="Missions" className="grid gap-4 sm:grid-cols-2">
        {missions.data?.map((mission) => (
          <MissionCard key={mission.id} mission={mission} />
        ))}
        {missions.data?.length === 0 && (
          <p className="text-[14px] text-muted">
            Create your first mission, then draft new work or attach existing tasks.
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
  if (!detail.data) return <p className="p-8 text-muted">Loading mission…</p>;
  const { mission, tasks } = detail.data;
  const holds = tasks.filter((entry) => entry.departure?.kind === "setup").length;
  const questions = tasks.filter((entry) => entry.task.question).length;
  return (
    <div className="mx-auto grid max-w-[1080px] gap-7 px-4 pt-8 pb-24 sm:px-8 lg:pt-12">
      <Link to="/missions" className="inline-flex items-center gap-2 text-[13px] text-muted">
        <ArrowLeft className="size-4" />
        Missions
      </Link>
      <header className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="t-h1 break-words min-w-0">{mission.title}</h1>
          <Button onClick={() => change.mutate(!mission.paused)} disabled={change.isPending}>
            {mission.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {mission.paused ? "Resume mission" : "Pause mission"}
          </Button>
        </div>
        <p className="whitespace-pre-wrap text-[15px] text-muted leading-relaxed">{mission.objective}</p>
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
            Draft work for this mission
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
          <b className="font-mono">{formatTokens(mission.tokensUsed)}</b> tokens used across all attempts of current
          tasks
        </span>
        <span>
          <b className="font-mono">{formatTokens(mission.taskCaps)}</b> combined caps for queued and running tasks
        </span>
        <p className="w-full text-[12px] text-muted">
          Caps are limits, not forecasts or extra reservations. The crew's daily budget still governs dispatch.
        </p>
      </div>
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
      {!tasks.length && (
        <div>
          <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Delete empty mission
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
  const save = useMutation({
    mutationFn: () => api.patch(`/api/missions/${mission.id}`, { title, objective }),
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
      <Field label="Mission name" htmlFor="mission-title">
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
