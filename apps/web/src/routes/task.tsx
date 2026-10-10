import { EVIDENCE_FOR, TASK_TYPE_LABEL, TASK_TYPES, type Task } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ArrowLeft, Check, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, reposQuery, taskQuery, useInvalidateTasks } from "../api";
import { ChipsEditor, Field, ListEditor, Select, TextArea, TextInput } from "../components/form";
import { Button, Pill } from "../components/ui";
import { fmtDay, fmtTime } from "../lib";

const STATUS_COPY: Record<Task["status"], { label: string; color: string }> = {
  draft: { label: "Draft", color: "var(--muted)" },
  queued: { label: "Queued", color: "var(--dawn)" },
  later: { label: "Later", color: "var(--sky)" },
  running: { label: "Running", color: "var(--dawn)" },
  done: { label: "Ran", color: "var(--ok)" },
  archived: { label: "Archived", color: "var(--faint)" },
};

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
  const [t, setT] = useState(initial);
  const [saved, setSaved] = useState(false);
  const repos = useQuery(reposQuery);
  const invalidate = useInvalidateTasks();
  const navigate = useNavigate();
  const locked = initial.status === "running";

  useEffect(() => setT(initial), [initial]);

  const save = useMutation({
    mutationFn: (patch: Partial<Task>) => api.patch<Task>(`/api/tasks/${t.id}`, patch),
    onSuccess: (next) => {
      setT(next);
      invalidate();
      setSaved(true);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/tasks/${t.id}`),
    onSuccess: () => {
      invalidate();
      navigate({ to: "/agents" });
    },
  });

  // Autosave edits after a short pause.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const edit = (patch: Partial<Task>) => {
    setT((prev) => ({ ...prev, ...patch }));
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(patch), 600);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

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
          className="t-h2 w-full bg-transparent outline-none"
        />
        <div className="flex flex-wrap gap-2">
          {t.status !== "queued" && t.status !== "running" && (
            <Button variant="primary" size="sm" onClick={() => save.mutate({ status: "queued" })}>
              Run now
            </Button>
          )}
          {t.status === "queued" && (
            <Button size="sm" onClick={() => save.mutate({ status: "later" })}>
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
          <Field label="Budget" htmlFor="budget" hint="Stops when it's spent.">
            <TextInput
              id="budget"
              type="number"
              min={0.1}
              step={0.5}
              value={(t.budgetCents / 100).toString()}
              onChange={(e) => edit({ budgetCents: Math.max(10, Math.round(Number(e.target.value) * 100) || 0) })}
              className="font-mono"
            />
          </Field>
          <Field label="Time cap (minutes)" htmlFor="minutes">
            <TextInput
              id="minutes"
              type="number"
              min={5}
              step={5}
              value={t.maxMinutes}
              onChange={(e) => edit({ maxMinutes: Math.max(5, Number(e.target.value) || 45) })}
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

      <section className="grid gap-2">
        <h2 className="font-medium text-[13px] text-muted">Evidence the crew must bring back</h2>
        <ul className="grid gap-1.5">
          {EVIDENCE_FOR[t.type].map((e) => (
            <li key={e} className="flex items-center gap-2.5 text-[13.5px]">
              <span className="size-1.5 rounded-full bg-ok" />
              {e}
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3">
        <h2 className="font-medium text-[13px] text-muted">Notes and attempts</h2>
        <Timeline notes={notes} runs={runs} budget={t.budgetCents} />
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
  budget: number;
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
