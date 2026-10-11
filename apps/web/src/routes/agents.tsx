import { formatTokens, type QueueEntry, type Repo, TASK_TYPE_LABEL, TASK_TYPES, type Task } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowRight, CalendarClock, CircleHelp, GitBranch, GripVertical, Inbox, Play, Sparkles, X } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  crewQuery,
  type DraftTask,
  missionsQuery,
  queueQuery,
  reposQuery,
  settingsQuery,
  tasksQuery,
  toast,
  useInvalidateTasks,
} from "../api";
import { AddRepo } from "../components/add-repo";
import { AgentBoard, CrewSummary } from "../components/agent-board";
import { DepartureChecks } from "../components/departure-checks";
import { ChipsEditor, inlineEdit, ListEditor, Select, TextInput } from "../components/form";
import { TaskRoute } from "../components/task-route";
import { Button } from "../components/ui";
import { isTypingTarget } from "../lib";
import { dropStash, unstash, useStashOnReload } from "../pending";

export function AgentsPage({ initialMissionId }: { initialMissionId?: string }) {
  const repos = useQuery(reposQuery);
  const crew = useQuery(crewQuery);
  const queued = useQuery(tasksQuery(["queued"]));
  const waiting = useQuery(tasksQuery(["draft"]));
  const departures = useQuery(queueQuery);
  const missions = useQuery(missionsQuery);
  // Composer text and unsaved drafts a restart's reload stashed (pending.ts).
  const [restored] = useState(() => {
    const text = unstash<string>("composer");
    const drafts = unstash<DraftTask[]>("drafts");
    const mission = unstash<unknown>("composer-mission");
    return {
      text: typeof text === "string" ? text : "",
      drafts: Array.isArray(drafts) && drafts.length ? drafts : null,
      mission: typeof mission === "string" ? mission : "",
    };
  });
  const [drafts, setDrafts] = useState<DraftTask[] | null>(restored.drafts);
  const [missionId, setMissionId] = useState(initialMissionId ?? restored.drafts?.[0]?.missionId ?? restored.mission);
  useStashOnReload("composer-mission", () => missionId);
  useEffect(() => {
    if (initialMissionId !== undefined) setMissionId(initialMissionId);
  }, [initialMissionId]);
  // Shown until you dismiss it, send the text, or save or discard the drafts.
  const [note, setNote] = useState(() =>
    restored.text && restored.drafts
      ? "Put back your unsaved text and drafts from before NightCrew restarted."
      : restored.text
        ? "Put back your unsaved text from before NightCrew restarted."
        : restored.drafts
          ? "Put back your unsaved drafts from before NightCrew restarted."
          : null,
  );
  useStashOnReload("drafts", () => drafts);
  useEffect(() => {
    dropStash("composer");
    dropStash("drafts");
    dropStash("composer-mission");
  }, []);

  const now = Date.now();
  const all = queued.data ?? [];
  const queue = all.filter((t) => !t.runAt || new Date(t.runAt).getTime() <= now);
  const scheduled = all.filter((t) => t.runAt && new Date(t.runAt).getTime() > now);
  const working = crew.data?.active.length ?? 0;

  return (
    <div className="mx-auto grid max-w-[920px] gap-8 px-4 pt-8 pb-28 sm:px-8 lg:pt-12">
      <header className="grid gap-5">
        <h1 className="t-h1">
          Agents.{" "}
          <span className="text-faint">
            {working
              ? `${working} working right now.`
              : queue.length
                ? "Work is queued."
                : "Give them something to do."}
          </span>
        </h1>
        <CrewSummary />
      </header>

      <AgentBoard />

      {repos.data && repos.data.length === 0 ? (
        <section className="grid gap-4 rounded-2xl bg-surface p-6 ring-1 ring-line">
          <h2 className="t-h3">Where should the crew work?</h2>
          <p className="text-[14px] text-muted">
            Add a git repository on this machine. Each agent works in its own clone and never touches your checkout.
          </p>
          <AddRepo />
        </section>
      ) : (
        <div className="grid gap-3">
          <label htmlFor="composer-mission" className="grid gap-1.5 text-[13px] text-muted">
            Mission for this work
            <Select
              id="composer-mission"
              value={missionId}
              onChange={(e) => {
                setMissionId(e.target.value);
                setDrafts((current) => current?.map((d) => ({ ...d, missionId: e.target.value || null })) ?? null);
              }}
            >
              <option value="">No mission</option>
              {missionId && !missions.data?.some((m) => m.id === missionId) && (
                <option value={missionId}>Loading mission…</option>
              )}
              {missions.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                  {m.paused ? " · paused" : ""}
                </option>
              ))}
            </Select>
          </label>
          <Link to="/missions" className="text-[12.5px] text-dawn">
            Create or manage missions →
          </Link>
          <Composer
            missionId={missionId || null}
            repos={repos.data ?? []}
            onDrafts={(d) => {
              setDrafts(d);
              setMissionId(d[0]?.missionId ?? "");
              setNote(null);
            }}
            initialText={restored.text}
            note={note}
            onDismissNote={() => setNote(null)}
          />
        </div>
      )}

      {drafts && (
        <Drafts
          drafts={drafts}
          repos={repos.data ?? []}
          onChange={setDrafts}
          onDone={() => {
            setDrafts(null);
            setNote(null);
          }}
        />
      )}

      {(waiting.data?.length ?? 0) > 0 && (
        <section className="grid gap-2.5">
          <h2 className="flex items-center gap-2 font-medium text-[13px]">
            <CircleHelp className="size-3.5 text-dawn" /> Needs an answer before an agent can start
          </h2>
          <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
            {waiting.data?.map((t) => (
              <QuestionRow key={t.id} task={t} />
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="flex items-center gap-2.5 font-medium text-[13px]">
            Waiting for an agent <span className="font-mono text-[12px] text-faint">{queue.length}</span>
          </h2>
          <Link to="/later" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
            Later <ArrowRight className="size-3" />
          </Link>
        </div>
        {queue.length === 0 ? (
          <div className="grid place-items-center gap-2 rounded-2xl border border-line border-dashed px-6 py-10 text-center">
            <Inbox className="size-5 text-faint" />
            <p className="text-[14px] text-muted">
              {working
                ? "Every task has an agent. New work starts the moment you add it."
                : "Nothing waiting. Describe some work above and an agent starts on it right away."}
            </p>
          </div>
        ) : (
          <Queue tasks={queue} departures={departures.data ?? []} />
        )}
      </section>

      {scheduled.length > 0 && (
        <section className="grid gap-3">
          <h2 className="flex items-center gap-2.5 font-medium text-[13px]">
            <CalendarClock className="size-3.5 text-faint" /> Scheduled
            <span className="font-mono text-[12px] text-faint">{scheduled.length}</span>
          </h2>
          <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
            {scheduled.map((t) => (
              <ScheduledRow key={t.id} task={t} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ScheduledRow({ task }: { task: Task }) {
  const invalidate = useInvalidateTasks();
  const runNow = useMutation({
    mutationFn: () => api.patch(`/api/tasks/${task.id}`, { runAt: null }),
    onSuccess: invalidate,
  });
  const when = task.runAt ? new Date(task.runAt) : null;
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <Link to="/task/$taskId" params={{ taskId: task.id }} className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate font-medium text-[14px]">{task.title}</span>
        <span className="font-mono text-[11.5px] text-faint">
          {task.repoName} · starts{" "}
          {when?.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      </Link>
      <Button size="sm" onClick={() => runNow.mutate()}>
        <Play className="size-3" /> Run now
      </Button>
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function Composer({
  missionId,
  repos,
  onDrafts,
  initialText,
  note,
  onDismissNote,
}: {
  missionId: string | null;
  repos: Repo[];
  onDrafts: (d: DraftTask[]) => void;
  initialText: string;
  /** Says a restart's reload put work back. */
  note: string | null;
  onDismissNote: () => void;
}) {
  const [text, setText] = useState(initialText);
  useStashOnReload("composer", () => text);
  const [repoId, setRepoId] = useState<string | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);
  const compose = useMutation({
    mutationFn: () =>
      api.post<{ drafts: DraftTask[]; fallback: boolean }>("/api/compose", {
        text,
        repoId: repoId ?? repos[0]?.id,
        missionId,
      }),
    onSuccess: (r) => {
      onDrafts(r.drafts);
      setText("");
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    const onFocus = () => ref.current?.focus();
    window.addEventListener("keydown", onKey);
    window.addEventListener("nc:compose", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("nc:compose", onFocus);
    };
  }, []);

  const active = repoId ?? repos[0]?.id;
  const submit = () => text.trim() && !compose.isPending && compose.mutate();

  return (
    <section className="overflow-hidden rounded-2xl bg-surface ring-1 ring-line focus-within:ring-[color-mix(in_srgb,var(--dawn)_45%,transparent)]">
      <label htmlFor="composer" className="sr-only">
        What should the agents work on?
      </label>
      <textarea
        id="composer"
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={3}
        placeholder="What should the agents work on? Describe it like you'd brief a contractor. Several things at once is fine."
        className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15.5px] leading-relaxed outline-none placeholder:text-faint"
      />
      {note && (
        <div className="flex items-start gap-2 px-5 pb-2">
          <p className="min-w-0 flex-1 text-[13px] text-muted">{note}</p>
          <button
            type="button"
            onClick={onDismissNote}
            aria-label="Dismiss"
            className="rounded-md p-1 text-faint transition-colors duration-150 ease-out hover:bg-raised hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        {repos.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setRepoId(r.id)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11.5px] transition-colors",
              r.id === active ? "bg-raised text-fg ring-1 ring-line-strong" : "text-faint hover:text-muted",
            )}
          >
            <GitBranch className="size-3" />
            {r.name}
          </button>
        ))}
        <span className="flex-1" />
        {compose.error && <span className="text-[12px] text-bad">{compose.error.message}</span>}
        <Button variant="primary" size="sm" onClick={submit} disabled={!text.trim() || compose.isPending} kbd="⌘↵">
          <Sparkles className="size-3.5" />
          {compose.isPending ? "Drafting…" : "Draft tasks"}
        </Button>
      </div>
    </section>
  );
}

function Drafts({
  drafts,
  repos,
  onChange,
  onDone,
}: {
  drafts: DraftTask[];
  repos: Repo[];
  onChange: (d: DraftTask[]) => void;
  onDone: () => void;
}) {
  const invalidate = useInvalidateTasks();
  const settings = useQuery(settingsQuery);
  const save = useMutation({
    mutationFn: (when: "now" | "schedule" | "later") =>
      api.post("/api/tasks/batch", {
        when,
        status: when === "later" ? "later" : "queued",
        tasks: drafts.map((d) => ({ ...d, dependsOnIndex: d.dependsOn, dependsOn: undefined })),
      }),
    onSuccess: (_, when) => {
      invalidate();
      onDone();
      toast(
        when === "now"
          ? "Queued. Agents start when departure checks pass and a slot is free."
          : when === "schedule"
            ? `Scheduled for ${settings.data?.scheduleAt ?? "later"}.`
            : "Saved to Later.",
      );
    },
  });
  const update = (i: number, patch: Partial<DraftTask>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const ready = drafts.filter((d) => !d.question).length;

  return (
    <section className="grid gap-3">
      <h2 className="font-medium text-[13px]">
        The crew drafted {drafts.length} {drafts.length === 1 ? "task" : "tasks"}. Fix anything that's off, then queue.
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {drafts.map((d, i) => (
          <article
            // biome-ignore lint/suspicious/noArrayIndexKey: drafts are edited in place; keying on the title would drop focus while typing
            key={i}
            className="grid content-start gap-3 rounded-2xl bg-surface p-4 ring-1 ring-line"
          >
            <div className="flex items-start justify-between gap-2">
              <input
                value={d.title}
                onChange={(e) => update(i, { title: e.target.value })}
                aria-label="Title"
                className={clsx(
                  "-ml-1.5 min-w-0 flex-1 rounded-md bg-transparent px-1.5 font-medium text-[15px] tracking-[-0.015em] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-raised/50 focus:bg-transparent",
                  inlineEdit,
                )}
              />
              <span
                className={clsx(
                  "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
                  d.question
                    ? "bg-[color-mix(in_srgb,var(--dawn)_14%,transparent)] text-dawn"
                    : "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok",
                )}
              >
                {d.question ? "1 question" : "Draft"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select aria-label="Repo" value={d.repoId} onChange={(e) => update(i, { repoId: e.target.value })}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Type"
                value={d.type}
                onChange={(e) => update(i, { type: e.target.value as DraftTask["type"] })}
              >
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TASK_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            {d.brief && <p className="line-clamp-3 text-[13px] text-muted">{d.brief}</p>}
            {repos.find((r) => r.id === d.repoId) && (
              <TaskRoute repo={repos.find((r) => r.id === d.repoId)!} type={d.type} compact />
            )}
            <ChipsEditor
              value={d.scope}
              onChange={(scope) => update(i, { scope })}
              placeholder="Scope, e.g. src/auth/** (empty = whole repo)"
            />
            <ListEditor
              value={d.criteria}
              onChange={(criteria) => update(i, { criteria })}
              placeholder="Add an acceptance criterion"
            />
            {d.question && (
              <div className="grid gap-2 rounded-xl bg-raised p-3">
                <p className="text-[13px]">{d.question}</p>
                <div className="flex gap-2">
                  <TextInput
                    placeholder="Your answer"
                    aria-label="Answer"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.currentTarget.value.trim()) {
                        update(i, {
                          brief: `${d.brief}\n\nQ: ${d.question}\nA: ${e.currentTarget.value.trim()}`,
                          question: null,
                        });
                      }
                    }}
                  />
                  <Button size="sm" variant="ghost" onClick={() => update(i, { question: null })}>
                    Skip
                  </Button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      <DepartureChecks tasks={drafts.map((d) => ({ ...d, dependsOn: undefined, dependsOnIndex: d.dependsOn }))} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {save.error && <span className="text-[12px] text-bad">{save.error.message}</span>}
        <Button variant="ghost" onClick={onDone}>
          Discard
        </Button>
        <Button variant="ghost" onClick={() => save.mutate("later")} disabled={save.isPending}>
          Save to Later
        </Button>
        <Button
          onClick={() => save.mutate("schedule")}
          disabled={save.isPending}
          title="Hold until the schedule time in Settings"
        >
          <CalendarClock className="size-3.5" /> Schedule for {settings.data?.scheduleAt ?? "later"}
        </Button>
        <Button variant="primary" onClick={() => save.mutate("now")} disabled={save.isPending}>
          <Play className="size-3.5" /> Run{" "}
          {ready === drafts.length ? (drafts.length === 1 ? "now" : `all ${drafts.length} now`) : `${ready} now`}
        </Button>
      </div>
    </section>
  );
}

function QuestionRow({ task }: { task: Task }) {
  const invalidate = useInvalidateTasks();
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    mutationFn: () => api.patch(`/api/tasks/${task.id}`, { answer, status: "queued" }),
    onSuccess: invalidate,
  });
  return (
    <div className="grid gap-2.5 px-5 py-4">
      <Link to="/task/$taskId" params={{ taskId: task.id }} className="font-medium text-[14px] hover:underline">
        {task.title}
      </Link>
      <p className="text-[13.5px] text-muted">{task.question ?? "This draft hasn't been queued yet."}</p>
      <div className="flex gap-2">
        <TextInput
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Answer, and an agent picks it up"
          aria-label="Answer"
          onKeyDown={(e) => e.key === "Enter" && answer.trim() && send.mutate()}
        />
        <Button
          variant="primary"
          size="sm"
          className="h-9"
          disabled={!answer.trim() && Boolean(task.question)}
          onClick={() => send.mutate()}
        >
          Run
        </Button>
      </div>
    </div>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

function Queue({ tasks, departures }: { tasks: Task[]; departures: QueueEntry[] }) {
  const [order, setOrder] = useState(tasks);
  const invalidate = useInvalidateTasks();
  useEffect(() => setOrder(tasks), [tasks]);
  const persist = useMutation({
    mutationFn: (ids: string[]) => api.post("/api/tasks/reorder", { ids }),
    onSettled: invalidate,
  });

  return (
    <Reorder.Group
      axis="y"
      values={order}
      onReorder={setOrder}
      className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line"
    >
      {order.map((t, i) => (
        <QueueRow
          key={t.id}
          task={t}
          departure={departures.find((entry) => entry.taskId === t.id)}
          index={i}
          onDrop={() => persist.mutate(order.map((x) => x.id))}
        />
      ))}
    </Reorder.Group>
  );
}

function QueueRow({
  task,
  departure,
  index,
  onDrop,
}: {
  task: Task;
  departure?: QueueEntry;
  index: number;
  onDrop: () => void;
}) {
  const controls = useDragControls();
  const navigate = useNavigate();
  const invalidate = useInvalidateTasks();
  const later = useMutation({
    mutationFn: () => api.patch(`/api/tasks/${task.id}`, { status: "later" }),
    onSuccess: invalidate,
  });
  const running = task.status === "running";
  return (
    <Reorder.Item
      value={task}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="relative flex items-center gap-3 bg-surface py-3 pr-4 pl-2"
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        onPointerDown={(e) => !running && controls.start(e)}
        className={clsx(
          "grid h-8 w-6 touch-none place-items-center rounded text-faint",
          running ? "cursor-default opacity-30" : "cursor-grab hover:text-muted active:cursor-grabbing",
        )}
      >
        <GripVertical className="size-4" />
      </button>
      <span className="w-5 font-mono text-[11.5px] text-faint tabular">{index + 1}</span>
      <button
        type="button"
        onClick={() => navigate({ to: "/task/$taskId", params: { taskId: task.id } })}
        className="grid min-w-0 flex-1 gap-0.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-[14px]">{task.title}</span>
          {running && (
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-dawn">
              <span className="size-1.5 animate-pulse rounded-full bg-dawn" /> working
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11.5px] text-faint">
          <span>{task.repoName}</span>
          <span>{TASK_TYPE_LABEL[task.type]}</span>
          {task.scope.length > 0 && <span className="truncate">{task.scope.join(" ")}</span>}
          {task.dependsOn.length > 0 && <span>after {task.dependsOn.length} other</span>}
        </span>
        {departure && (
          <span className={departure.kind === "setup" ? "text-[12px] text-dawn" : "text-[12px] text-muted"}>
            {departure.reason}
          </span>
        )}
      </button>
      <span className="hidden font-mono text-[11.5px] text-muted tabular sm:inline">
        ≤{formatTokens(task.tokenBudget)} tokens · {task.maxMinutes}m
      </span>
      {!running && (
        <button
          type="button"
          onClick={() => later.mutate()}
          className="rounded-full px-2 py-1 text-[12px] text-faint hover:bg-raised hover:text-fg"
        >
          Later
        </button>
      )}
    </Reorder.Item>
  );
}
