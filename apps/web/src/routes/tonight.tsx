import { formatCost, type Repo, TASK_TYPE_LABEL, TASK_TYPES, type Task } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowRight, CircleHelp, GitBranch, GripVertical, Moon, Play, Sparkles, Square } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, crewQuery, type DraftTask, reposQuery, settingsQuery, tasksQuery, useInvalidateTasks } from "../api";
import { AddRepo } from "../components/add-repo";
import { CrewBar } from "../components/crew-bar";
import { ChipsEditor, ListEditor, Select, TextInput } from "../components/form";
import { Button } from "../components/ui";
import { isTypingTarget } from "../lib";

export function TonightPage() {
  const repos = useQuery(reposQuery);
  const settings = useQuery(settingsQuery);
  const crew = useQuery(crewQuery);
  const queued = useQuery(tasksQuery(["queued", "running"]));
  const waiting = useQuery(tasksQuery(["draft"]));
  const [drafts, setDrafts] = useState<DraftTask[] | null>(null);

  const s = settings.data;
  const queue = queued.data ?? [];
  const estimate = queue.reduce((n, t) => n + t.budgetCents, 0);
  const running = crew.data && crew.data.state !== "idle";

  return (
    <div className="mx-auto grid max-w-[860px] gap-8 px-4 pt-8 pb-28 sm:px-8 lg:pt-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <h1 className="font-serif text-[40px] leading-none tracking-[-0.01em] sm:text-[48px]">Tonight</h1>
          <p className="text-[14px] text-muted">
            {running ? (
              "The crew is working."
            ) : s?.autoStart ? (
              <>
                The crew starts at <span className="font-mono text-fg">{s.startAt}</span>
                {crew.data && <> · {untilText(crew.data.nextStartAt)}</>}
              </>
            ) : (
              "Auto-start is off. Press Run now when you're ready."
            )}
          </p>
        </div>
        <CrewControls hasQueue={queue.length > 0} />
      </header>

      <CrewBar />

      {repos.data && repos.data.length === 0 ? (
        <section className="grid gap-4 rounded-2xl bg-surface p-6 ring-1 ring-line">
          <h2 className="font-semibold text-[16px]">Where should the crew work?</h2>
          <p className="text-[14px] text-muted">
            Add a git repository on this machine. The crew works in its own worktree and never touches your checkout.
          </p>
          <AddRepo />
        </section>
      ) : (
        <Composer repos={repos.data ?? []} onDrafts={setDrafts} />
      )}

      {drafts && (
        <Drafts drafts={drafts} repos={repos.data ?? []} onChange={setDrafts} onDone={() => setDrafts(null)} />
      )}

      {(waiting.data?.length ?? 0) > 0 && (
        <section className="grid gap-2.5">
          <h2 className="flex items-center gap-2 font-medium text-[13px]">
            <CircleHelp className="size-3.5 text-dawn" /> Needs an answer before tonight
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
            Queue <span className="font-mono text-[12px] text-faint">{queue.length}</span>
          </h2>
          <Link to="/later" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
            Later <ArrowRight className="size-3" />
          </Link>
        </div>
        {s && queue.length > 0 && <BudgetMeter estimate={estimate} budget={s.nightlyBudgetCents} />}
        {queue.length === 0 ? (
          <div className="grid place-items-center gap-2 rounded-2xl border border-line border-dashed px-6 py-12 text-center">
            <Moon className="size-5 text-faint" />
            <p className="text-[14px] text-muted">
              Nothing queued yet. Describe some work above, or pull something from Later.
            </p>
          </div>
        ) : (
          <Queue tasks={queue} />
        )}
      </section>
    </div>
  );
}

function untilText(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "any minute";
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  return `in ${h ? `${h}h ` : ""}${m % 60}m`;
}

function CrewControls({ hasQueue }: { hasQueue: boolean }) {
  const crew = useQuery(crewQuery);
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.post("/api/crew/start"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["crew"] }),
  });
  const stop = useMutation({ mutationFn: () => api.post("/api/crew/stop") });
  const state = crew.data?.state ?? "idle";
  if (state === "idle") {
    return (
      <div className="grid justify-items-end gap-1">
        <Button variant="primary" onClick={() => start.mutate()} disabled={!hasQueue || start.isPending}>
          <Play className="size-3.5" /> Run now
        </Button>
        {start.error && <p className="text-[12px] text-bad">{start.error.message}</p>}
      </div>
    );
  }
  return (
    <Button variant="danger" onClick={() => stop.mutate()} disabled={state === "stopping"}>
      <Square className="size-3" /> {state === "stopping" ? "Stopping…" : "Stop"}
    </Button>
  );
}

function BudgetMeter({ estimate, budget }: { estimate: number; budget: number }) {
  const pct = Math.min(100, (estimate / budget) * 100);
  const over = estimate > budget;
  return (
    <div className="grid gap-1.5">
      <div className="h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={clsx("h-full rounded-full transition-[width] duration-300", over ? "bg-bad" : "bg-dawn")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="font-mono text-[11.5px] text-muted tabular">
        up to {formatCost(estimate)} of the {formatCost(budget)} nightly budget
        {over && <span className="text-bad"> · the crew stops before the budget runs out</span>}
      </p>
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

function Composer({ repos, onDrafts }: { repos: Repo[]; onDrafts: (d: DraftTask[]) => void }) {
  const [text, setText] = useState("");
  const [repoId, setRepoId] = useState<string | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);
  const compose = useMutation({
    mutationFn: () =>
      api.post<{ drafts: DraftTask[]; fallback: boolean }>("/api/compose", { text, repoId: repoId ?? repos[0]?.id }),
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
        What should the crew do tonight?
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
        placeholder="What should the crew do tonight? Describe it like you'd brief a contractor. Several things at once is fine."
        className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[15.5px] leading-relaxed outline-none placeholder:text-faint"
      />
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
  const save = useMutation({
    mutationFn: (status: "queued" | "later") =>
      api.post("/api/tasks/batch", {
        status,
        tasks: drafts.map((d) => ({ ...d, dependsOnIndex: d.dependsOn, dependsOn: undefined })),
      }),
    onSuccess: () => {
      invalidate();
      onDone();
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
                className="min-w-0 flex-1 bg-transparent font-semibold text-[14.5px] outline-none"
              />
              <span
                className={clsx(
                  "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
                  d.question
                    ? "bg-[color-mix(in_srgb,var(--dawn)_14%,transparent)] text-dawn"
                    : "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok",
                )}
              >
                {d.question ? "1 question" : "Ready"}
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        {save.error && <span className="text-[12px] text-bad">{save.error.message}</span>}
        <Button variant="ghost" onClick={onDone}>
          Discard
        </Button>
        <Button onClick={() => save.mutate("later")} disabled={save.isPending}>
          Save to Later
        </Button>
        <Button variant="primary" onClick={() => save.mutate("queued")} disabled={save.isPending}>
          Queue{" "}
          {ready === drafts.length ? (drafts.length === 1 ? "it" : `all ${drafts.length}`) : `${ready} for tonight`}
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
          placeholder="Answer, and it joins tonight's queue"
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
          Queue
        </Button>
      </div>
    </div>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

function Queue({ tasks }: { tasks: Task[] }) {
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
        <QueueRow key={t.id} task={t} index={i} onDrop={() => persist.mutate(order.map((x) => x.id))} />
      ))}
    </Reorder.Group>
  );
}

function QueueRow({ task, index, onDrop }: { task: Task; index: number; onDrop: () => void }) {
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
      </button>
      <span className="hidden font-mono text-[11.5px] text-muted tabular sm:inline">
        ≤{formatCost(task.budgetCents)} · {task.maxMinutes}m
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
