import { type Routine, TASK_TYPE_LABEL, TASK_TYPES, type TaskType } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Repeat, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, reposQuery } from "../api";
import { Select, TextArea, TextInput } from "./form";
import { Button } from "./ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Routines() {
  const qc = useQueryClient();
  const routines = useQuery({ queryKey: ["routines"], queryFn: () => api.get<Routine[]>("/api/routines") });
  const repos = useQuery(reposQuery);
  const [adding, setAdding] = useState(false);
  const toggle = useMutation({
    mutationFn: (r: Routine) => api.patch(`/api/routines/${r.id}`, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routines"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/routines/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routines"] }),
  });

  return (
    <section className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2 font-medium text-[13px]">
          <Repeat className="size-3.5 text-faint" /> Routines
        </h2>
        {!adding && repos.data?.length ? (
          <button type="button" onClick={() => setAdding(true)} className="text-[12.5px] text-muted hover:text-fg">
            New routine
          </button>
        ) : null}
      </div>
      {adding && <NewRoutine onDone={() => setAdding(false)} />}
      {routines.data?.length ? (
        <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          {routines.data.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-5 py-3.5">
              <div className={clsx("grid min-w-0 flex-1 gap-0.5", !r.enabled && "opacity-50")}>
                <span className="truncate font-medium text-[14px]">{r.title}</span>
                <span className="font-mono text-[11.5px] text-faint">
                  {r.repoName} · {r.days.map((d) => DAYS[d]).join(" ")}
                  {r.lastNight ? ` · last queued ${r.lastNight}` : ""}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>
                {r.enabled ? "Pause" : "Resume"}
              </Button>
              <button
                type="button"
                aria-label="Delete routine"
                onClick={() => remove.mutate(r.id)}
                className="grid size-7 place-items-center rounded-full text-faint hover:bg-raised hover:text-bad"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        !adding && (
          <p className="text-[13px] text-faint">
            Recurring work, like "Fridays: bump dependencies" or "Every night: fix one flaky test". It joins the queue
            on its days.
          </p>
        )
      )}
    </section>
  );
}

function NewRoutine({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const repos = useQuery(reposQuery);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [repoId, setRepoId] = useState(repos.data?.[0]?.id ?? "");
  const [type, setType] = useState<TaskType>("implementation");
  const [days, setDays] = useState<number[]>([5]);
  const save = useMutation({
    mutationFn: () => api.post("/api/routines", { title, brief, repoId, type, days }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routines"] });
      onDone();
    },
  });
  return (
    <div className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-line">
      <TextInput
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Bump minor dependency versions and fix what breaks"
        aria-label="Routine title"
        autoFocus
      />
      <TextArea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={3}
        placeholder="Details the crew should know every time."
        aria-label="Routine brief"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Select aria-label="Repo" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          {repos.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value as TaskType)}>
          {TASK_TYPES.map((t) => (
            <option key={t} value={t}>
              {TASK_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
        {DAYS.map((d, i) => (
          <button
            key={d}
            type="button"
            aria-pressed={days.includes(i)}
            onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}
            className={clsx(
              "rounded-full px-3 py-1 text-[12.5px] ring-1 transition-colors",
              days.includes(i) ? "bg-dawn text-on-dawn ring-transparent" : "text-muted ring-line hover:text-fg",
            )}
          >
            {d}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        {save.error && <span className="self-center text-[12px] text-bad">{save.error.message}</span>}
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => save.mutate()}
          disabled={!title.trim() || !days.length || save.isPending}
        >
          Save routine
        </Button>
      </div>
    </div>
  );
}
