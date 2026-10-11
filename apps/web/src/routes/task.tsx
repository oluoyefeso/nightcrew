import { TASK_TYPE_LABEL, TASK_TYPES, type Task } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowLeft, Check, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, reposQuery, settingsQuery, taskQuery, tasksQuery, useInvalidateTasks } from "../api";
import { DepartureChecks } from "../components/departure-checks";
import { ChipsEditor, Field, inlineEdit, ListEditor, Select, TextArea, TextInput } from "../components/form";
import { TaskRoute } from "../components/task-route";
import { Button, Pill } from "../components/ui";
import { fmtDay, fmtTime } from "../lib";
import { dropStash, unstash, useStashOnReload } from "../pending";

const STATUS_COPY: Record<Task["status"], { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--muted)" },
  queued: { label: "Queued", color: "var(--dawn)" },
  later: { label: "Later", color: "var(--sky)" },
  running: { label: "Running", color: "var(--dawn)" },
  done: { label: "Ran", color: "var(--ok)" },
  archived: { label: "Archived", color: "var(--faint)" },
};

/** The fields a failed autosave may send again. Never status or runAt. */
const CONTENT_FIELDS = [
  "title",
  "brief",
  "type",
  "scope",
  "criteria",
  "tokenBudget",
  "maxMinutes",
  "model",
  "testCommand",
  "repoId",
  "dependsOn",
] as const satisfies readonly (keyof Task)[];

type Edits = Partial<Task>;

function contentOf(patch: Edits | null): Edits {
  const content: Edits = {};
  for (const k of CONTENT_FIELDS) if (patch && k in patch) Object.assign(content, { [k]: patch[k] });
  return content;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of `from` named in `keys`. */
function pick(from: Edits, keys: Edits): Edits {
  const out: Edits = {};
  for (const k of CONTENT_FIELDS) if (k in keys) Object.assign(out, { [k]: from[k] });
  return out;
}

/** What a restart stashes for a task: the edits, and the server's values for those fields at the time. */
interface TaskStash {
  edits: Edits;
  /** Null for a stash written before bases were kept: treated as changed since. */
  base: Edits | null;
}

/** Kept until the run ends; put back and saving; or waiting on Use mine / Discard. */
type Restore = { kind: "locked" | "saving" | "conflict"; stash: TaskStash } | null;

const RESTORE_COPY: Record<NonNullable<Restore>["kind"], string> = {
  locked: "Your unsaved edits from before the restart are kept until this run finishes.",
  saving: "Put back your unsaved edits from before NightCrew restarted. They're saving now.",
  conflict: "You had unsaved edits from before the restart, but this task changed since.",
};

function readStash(id: string): TaskStash | null {
  const raw = unstash<unknown>(id);
  if (!raw || typeof raw !== "object") return null;
  if ("edits" in raw) {
    const s = raw as TaskStash;
    return { edits: contentOf(s.edits), base: s.base && typeof s.base === "object" ? s.base : null };
  }
  return { edits: contentOf(raw as Edits), base: null };
}

/** Weigh a stash against the server copy. Only fields that differ from it come back. */
function decide(task: Task, s: TaskStash | null): Restore {
  if (!s) return null;
  const edits: Edits = {};
  for (const k of CONTENT_FIELDS)
    if (k in s.edits && !same(s.edits[k], task[k])) Object.assign(edits, { [k]: s.edits[k] });
  if (!Object.keys(edits).length) {
    dropStash(task.id);
    return null;
  }
  const stash = { edits, base: s.base };
  if (task.status === "running") return { kind: "locked", stash };
  const changed = !s.base || Object.keys(edits).some((k) => !same(s.base?.[k as keyof Task], task[k as keyof Task]));
  return { kind: changed ? "conflict" : "saving", stash };
}

export function TaskPage({ taskId }: { taskId: string }) {
  const { data, error } = useQuery(taskQuery(taskId));
  if (error) return <p className="p-10 text-bad">{error.message}</p>;
  if (!data) return <div className="p-10 text-muted">Loading…</div>;
  return <TaskEditor key={data.task.id} initial={data.task} notes={data.notes} runs={data.runs} />;
}

function TaskEditor({
  initial,
  notes,
  runs,
}: {
  initial: Task;
  notes: { id: number; author: string; body: string; at: string }[];
  runs: { id: string; status: string; startedAt: string | null; reason: string | null }[];
}) {
  // Edits a restart's reload stashed (pending.ts). Put back and saved only if the
  // task is editable and unchanged since; otherwise kept until you choose.
  const [restore, setRestore] = useState<Restore>(() => decide(initial, readStash(initial.id)));
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const [t, setT] = useState(() => ({ ...initial, ...(restore?.kind === "saving" ? restore.stash.edits : {}) }));
  const [saved, setSaved] = useState(false);
  const repos = useQuery(reposQuery);
  const settings = useQuery(settingsQuery);
  const allTasks = useQuery(tasksQuery([]));
  // The API refuses a task budget above the daily budget, so the field stops there too.
  const maxTokens = settings.data?.dailyTokenBudget ?? Number.POSITIVE_INFINITY;
  const invalidate = useInvalidateTasks();
  const navigate = useNavigate();
  const locked = initial.status === "running";

  // Autosave edits after a short pause. Edits within the pause merge, so a
  // quick title-then-brief change saves both; leaving the page saves the rest.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Edits>(restore?.kind === "saving" ? restore.stash.edits : {});
  /** The patch on the wire. A 401 reloads before onError can queue it again, so the stash reads it here. */
  const inflight = useRef<Edits>({});
  /** The last copy the server sent, for a stash's base. */
  const server = useRef(initial);
  /** Server values to send back once the save on the wire lands: Discard came too late to stop it. */
  const revert = useRef<Edits | null>(null);
  /** A stash still waiting on the run or on Use mine / Discard isn't dropped by other saves. */
  const keepStash = () => restoreRef.current?.kind === "locked" || restoreRef.current?.kind === "conflict";

  // A refetch keeps edits that haven't saved yet.
  useEffect(() => {
    server.current = initial;
    setT({ ...initial, ...pending.current });
  }, [initial]);

  const save = useMutation({
    mutationFn: (patch: Edits) => {
      inflight.current = patch;
      return api.patch<Task>(`/api/tasks/${t.id}`, patch);
    },
    onSettled: () => {
      inflight.current = {};
      const back = revert.current;
      revert.current = null;
      if (back) save.mutate(back);
    },
    onSuccess: (next) => {
      server.current = next;
      // Keep anything typed while this save was in flight.
      setT({ ...next, ...pending.current });
      invalidate();
      const done = Object.keys(pending.current).length === 0;
      setSaved(done);
      if (done && !keepStash()) {
        dropStash(initial.id);
        setRestore((r) => (r?.kind === "saving" ? null : r));
      }
    },
    // A save that didn't get through (offline, a server error, locked out) puts its
    // text back in the queue so it isn't lost; newer edits win, and the next save
    // (or leaving the page) sends it again. Status and timing never replay: Run now
    // later would be a surprise. A refusal (400, 409) shows its error instead.
    onError: (err, patch) => {
      setSaved(false);
      if (err instanceof ApiError && err.status !== 401 && err.status < 500) {
        if (!keepStash()) dropStash(initial.id);
        return;
      }
      pending.current = { ...contentOf(patch), ...pending.current };
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/tasks/${t.id}`),
    onSuccess: () => {
      invalidate();
      navigate({ to: "/agents" });
    },
  });

  useStashOnReload(initial.id, () => {
    const edits = contentOf({ ...inflight.current, ...pending.current });
    const kept = keepStash() ? restoreRef.current?.stash : null;
    if (!Object.keys(edits).length) return kept ?? null;
    const base = pick(server.current, edits);
    if (!kept) return { edits, base } satisfies TaskStash;
    return { edits: { ...kept.edits, ...edits }, base: kept.base && { ...kept.base, ...base } } satisfies TaskStash;
  });
  const flush = useRef((_extra?: Edits) => {});
  // Run now and Move to Later go through here too, so the agent gets the latest text.
  flush.current = (extra = {}) => {
    clearTimeout(timer.current);
    const patch = { ...pending.current, ...extra };
    pending.current = {};
    if (Object.keys(patch).length) save.mutate(patch);
  };
  const edit = (patch: Edits) => {
    setT((prev) => ({ ...prev, ...patch }));
    setSaved(false);
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), 600);
  };
  const keepMine = () => {
    const next = decide({ ...initial, status: "draft" }, restore?.stash ?? null);
    if (!next) return setRestore(null);
    setRestore({ kind: "saving", stash: next.stash });
    edit(next.stash.edits);
  };
  const discard = () => {
    const edits = restore?.stash.edits ?? {};
    clearTimeout(timer.current);
    pending.current = {};
    if (Object.keys(inflight.current).length) revert.current = pick(server.current, edits);
    dropStash(initial.id);
    setRestore(null);
    setSaved(false);
    setT({ ...server.current });
  };
  useEffect(() => {
    if (restoreRef.current?.kind === "saving") timer.current = setTimeout(() => flush.current(), 600);
    return () => flush.current();
  }, []);
  // A run that held a stash has finished: weigh it again now the task is editable.
  const unlocked = !locked && restore?.kind === "locked";
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the lock lifts
  useEffect(() => {
    const r = restoreRef.current;
    if (!unlocked || !r) return;
    const next = decide(server.current, r.stash);
    setRestore(next);
    if (next?.kind === "saving") edit(next.stash.edits);
  }, [unlocked]);

  const status = STATUS_COPY[t.status];

  return (
    <div className="mx-auto grid max-w-[860px] gap-8 px-4 pt-6 pb-28 sm:px-8 lg:pt-10">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => history.back()}
          className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg"
        >
          <ArrowLeft className="size-3.5" /> Back
        </button>
        <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-faint">
          {save.isPending ? (
            "Saving…"
          ) : saved ? (
            <>
              <Check className="size-3" /> Saved
            </>
          ) : null}
          {save.error && <span className="text-bad">{save.error.message}</span>}
        </span>
      </div>

      <header className="grid gap-3">
        {restore && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-raised px-3.5 py-2.5">
            <p className="min-w-0 flex-1 basis-60 text-[13px] text-muted">{RESTORE_COPY[restore.kind]}</p>
            {restore.kind !== "locked" && (
              <div className="flex gap-2">
                {restore.kind === "conflict" && (
                  <Button size="sm" onClick={keepMine}>
                    Use mine
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={discard}>
                  Discard
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Pill color={status.color}>{status.label}</Pill>
          <span className="font-mono text-[11.5px] text-faint">
            {t.repoName} · {t.branch}
          </span>
        </div>
        <input
          value={t.title}
          disabled={locked}
          onChange={(e) => edit({ title: e.target.value })}
          aria-label="Title"
          className={clsx(
            "t-h2 -mx-2 w-[calc(100%+1rem)] rounded-lg bg-transparent px-2 outline-none transition-[background-color,box-shadow] duration-150 ease-out enabled:hover:bg-raised/50 focus:bg-transparent",
            inlineEdit,
          )}
        />
        <div className="flex flex-wrap gap-2">
          {t.status !== "queued" && t.status !== "running" && (
            <Button variant="primary" size="sm" onClick={() => flush.current({ status: "queued", runAt: null })}>
              Run now
            </Button>
          )}
          {t.status === "queued" && (
            <Button size="sm" onClick={() => flush.current({ status: "later" })}>
              Move to Later
            </Button>
          )}
          {t.lastRunId && (
            <Link to="/run/$runId" params={{ runId: t.lastRunId }}>
              <Button size="sm" variant="ghost">
                Latest run
              </Button>
            </Link>
          )}
          {!locked && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-faint hover:text-bad"
              onClick={() => remove.mutate()}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
        </div>
      </header>

      {t.question && (
        <div className="grid gap-2 rounded-2xl bg-[color-mix(in_srgb,var(--dawn)_9%,var(--surface))] p-4">
          <span className="font-mono text-[11px] text-dawn uppercase tracking-[0.08em]">The crew asks</span>
          <p className="text-[14px]">{t.question}</p>
          <AnswerBox taskId={t.id} onDone={invalidate} />
        </div>
      )}

      <fieldset disabled={locked} className="grid gap-5 disabled:opacity-60">
        <Field label="Brief" htmlFor="brief" hint="Everything the crew should know. It can't ask you at 3am.">
          <TextArea
            id="brief"
            rows={6}
            value={t.brief}
            onChange={(e) => edit({ brief: e.target.value })}
            placeholder="What to do, why, and anything to avoid."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Repo" htmlFor="repo">
            <Select id="repo" value={t.repoId} onChange={(e) => edit({ repoId: e.target.value })}>
              {repos.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor="type">
            <Select id="type" value={t.type} onChange={(e) => edit({ type: e.target.value as Task["type"] })}>
              {TASK_TYPES.map((x) => (
                <option key={x} value={x}>
                  {TASK_TYPE_LABEL[x]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" htmlFor="model" hint="Blank uses your default.">
            <TextInput
              id="model"
              value={t.model ?? ""}
              onChange={(e) => edit({ model: e.target.value || null })}
              placeholder="claude-sonnet-5-5"
              className="font-mono"
            />
          </Field>
        </div>

        <Field label="Acceptance criteria" hint="The reviewer checks each one against real evidence.">
          <ListEditor value={t.criteria} onChange={(criteria) => edit({ criteria })} placeholder="Add a criterion" />
        </Field>

        <Field
          label="Scope"
          htmlFor="scope"
          hint="Files the crew may change. Anything else is refused. Empty means the whole repo."
        >
          <ChipsEditor
            id="scope"
            value={t.scope}
            onChange={(scope) => edit({ scope })}
            placeholder="src/auth/**, tests/auth/**"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Token budget (thousands)"
            htmlFor="budget"
            hint="Input, cache and output across all phases. The agent stops at it."
          >
            <TextInput
              id="budget"
              type="number"
              min={50}
              max={Number.isFinite(maxTokens) ? maxTokens / 1000 : undefined}
              step={100}
              value={Math.round(t.tokenBudget / 1000).toString()}
              onChange={(e) =>
                edit({
                  tokenBudget: Math.min(maxTokens, Math.max(50_000, Math.round(Number(e.target.value) * 1000) || 0)),
                })
              }
              className="font-mono"
            />
          </Field>
          <Field label="Time cap (minutes)" htmlFor="minutes">
            <TextInput
              id="minutes"
              type="number"
              min={5}
              max={600}
              step={5}
              value={t.maxMinutes}
              onChange={(e) =>
                edit({ maxMinutes: Math.min(600, Math.max(5, Math.round(Number(e.target.value)) || 45)) })
              }
              className="font-mono"
            />
          </Field>
          <Field label="Test command" htmlFor="test" hint="Blank uses the repo's.">
            <TextInput
              id="test"
              value={t.testCommand ?? ""}
              onChange={(e) => edit({ testCommand: e.target.value || null })}
              placeholder="bun test"
              className="font-mono"
            />
          </Field>
        </div>
      </fieldset>

      {!locked && (
        <section className="grid gap-2">
          <h2 className="text-[13px] font-medium">Wait for tasks</h2>
          {t.dependsOn.map((id) => (
            <div
              key={id}
              className="flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-[13px]"
            >
              <span>{allTasks.data?.find((task) => task.id === id)?.title ?? "Missing prerequisite"}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => edit({ dependsOn: t.dependsOn.filter((dep) => dep !== id) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Select
            aria-label="Add prerequisite"
            value=""
            onChange={(e) => {
              if (e.target.value) edit({ dependsOn: [...t.dependsOn, e.target.value] });
            }}
          >
            <option value="">Add a prerequisite…</option>
            {allTasks.data
              ?.filter((task) => task.id !== t.id && !t.dependsOn.includes(task.id))
              .map((task) => (
                <option key={task.id} value={task.id}>
                  {task.repoName} · {task.title}
                </option>
              ))}
          </Select>
        </section>
      )}
      {repos.data?.find((r) => r.id === t.repoId) && (
        <TaskRoute repo={repos.data.find((r) => r.id === t.repoId)!} type={t.type} />
      )}
      {!locked && <DepartureChecks tasks={[t]} />}

      <section className="grid gap-3">
        <h2 className="font-medium text-[13px] text-muted">Notes and attempts</h2>
        <Timeline notes={notes} runs={runs} />
        <NoteBox taskId={t.id} onDone={invalidate} />
      </section>
    </div>
  );
}

function Timeline({
  notes,
  runs,
}: {
  notes: { id: number; author: string; body: string; at: string }[];
  runs: { id: string; status: string; startedAt: string | null; reason: string | null }[];
}) {
  const items = [
    ...notes.map((n) => ({ at: n.at, key: `n${n.id}`, node: <NoteItem author={n.author} body={n.body} at={n.at} /> })),
    ...runs.map((r, i) => ({
      at: r.startedAt ?? "",
      key: r.id,
      node: (
        <Link
          to="/run/$runId"
          params={{ runId: r.id }}
          className="group flex items-baseline gap-3 rounded-lg px-1 py-1 hover:bg-surface"
        >
          <span
            className={clsx(
              "size-2 shrink-0 translate-y-[-1px] rounded-full",
              r.status === "complete" ? "bg-ok" : r.status === "running" ? "animate-pulse bg-dawn" : "bg-bad",
            )}
          />
          <span className="text-[13.5px]">
            Night {i + 1}: {r.status === "complete" ? "completed" : r.status === "running" ? "running now" : r.status}
            {r.reason && r.status !== "complete" ? <span className="text-muted"> · {r.reason}</span> : null}
          </span>
          <span className="ml-auto font-mono text-[11px] text-faint">
            {fmtDay(r.startedAt)} {fmtTime(r.startedAt)}
          </span>
        </Link>
      ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!items.length) return <p className="text-[13px] text-faint">No attempts yet.</p>;
  return (
    <ol className="grid gap-1.5">
      {items.map((i) => (
        <li key={i.key}>{i.node}</li>
      ))}
    </ol>
  );
}

function NoteItem({ author, body, at }: { author: string; body: string; at: string }) {
  return (
    <div className="grid gap-0.5 rounded-xl bg-raised px-3.5 py-2.5">
      <span className="font-mono text-[11px] text-faint">
        {author === "you" ? "You" : "Crew"} · {fmtDay(at)} {fmtTime(at)}
      </span>
      <p className="whitespace-pre-wrap text-[13.5px]">{body}</p>
    </div>
  );
}

function NoteBox({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.post(`/api/tasks/${taskId}/notes`, { text }),
    onSuccess: () => {
      setText("");
      onDone();
    },
  });
  return (
    <div className="flex gap-2">
      <TextInput
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a note for the next attempt"
        aria-label="Note"
        onKeyDown={(e) => e.key === "Enter" && text.trim() && add.mutate()}
      />
      <Button size="sm" className="h-9" disabled={!text.trim()} onClick={() => add.mutate()}>
        Add
      </Button>
    </div>
  );
}

function AnswerBox({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    mutationFn: () => api.patch(`/api/tasks/${taskId}`, { answer, status: "queued" }),
    onSuccess: onDone,
  });
  return (
    <div className="flex gap-2">
      <TextInput
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Your answer"
        aria-label="Answer"
        onKeyDown={(e) => e.key === "Enter" && answer.trim() && send.mutate()}
      />
      <Button variant="primary" size="sm" className="h-9" disabled={!answer.trim()} onClick={() => send.mutate()}>
        Answer and queue
      </Button>
    </div>
  );
}
