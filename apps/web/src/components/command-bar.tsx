import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { clsx } from "clsx";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, crewQuery, tasksQuery } from "../api";
import { Kbd } from "./ui";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/** ⌘K: jump anywhere, pause or resume the agents, open any task. */
export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const crew = useQuery(crewQuery);
  const tasks = useQuery({ ...tasksQuery(["queued", "later", "draft", "running", "done"]), enabled: open });
  const resume = useMutation({ mutationFn: () => api.post("/api/crew/resume") });
  const pause = useMutation({ mutationFn: () => api.post("/api/crew/pause") });
  const stopAll = useMutation({ mutationFn: () => api.post("/api/crew/stop-all") });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate({ to });
    const base: Command[] = [
      {
        id: "new",
        label: "New task",
        hint: "N",
        group: "Actions",
        run: () => {
          navigate({ to: "/agents" });
          setTimeout(() => window.dispatchEvent(new Event("nc:compose")), 60);
        },
      },
      crew.data?.state === "paused"
        ? { id: "resume", label: "Resume dispatch", group: "Actions", run: () => resume.mutate() }
        : { id: "pause", label: "Pause dispatch (running agents finish)", group: "Actions", run: () => pause.mutate() },
      ...(crew.data?.active.length
        ? [
            {
              id: "stop-all",
              label: `Stop all ${crew.data.active.length} agents`,
              group: "Actions",
              run: () => stopAll.mutate(),
            },
          ]
        : []),
      { id: "report", label: "Inbox", group: "Go to", run: go("/") },
      { id: "agents", label: "Agents", group: "Go to", run: go("/agents") },
      { id: "later", label: "Later", group: "Go to", run: go("/later") },
      { id: "settings", label: "Settings and repos", group: "Go to", run: go("/settings") },
      {
        id: "theme",
        label: "Switch Night / Morning theme",
        group: "Actions",
        run: () => {
          const root = document.documentElement;
          const dark = root.dataset.theme
            ? root.dataset.theme === "dark"
            : !matchMedia("(prefers-color-scheme: light)").matches;
          root.dataset.theme = dark ? "light" : "dark";
          try {
            localStorage.setItem("nc-theme", root.dataset.theme);
          } catch {}
        },
      },
    ];
    const taskCmds = (tasks.data ?? []).map<Command>((t) => ({
      id: t.id,
      label: t.title,
      hint: t.repoName,
      group: "Tasks",
      run: () => navigate({ to: "/task/$taskId", params: { taskId: t.id } }),
    }));
    const all = [...base, ...taskCmds];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(needle)) : all.slice(0, 14);
  }, [q, tasks.data, crew.data?.state, crew.data?.active.length, navigate, resume, pause, stopAll]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  let lastGroup = "";
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Command bar"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow)] ring-1 ring-line-strong motion-safe:animate-[nc-rise_.18s_var(--ease-out-quint)]"
      >
        <div className="flex items-center gap-3 border-line border-b px-4">
          <Search className="size-4 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(commands.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") run(commands[active]);
            }}
            placeholder="Type a command or a task"
            aria-label="Command"
            className="h-12 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-faint"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5">
          {commands.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-faint">Nothing matches.</li>}
          {commands.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id}>
                {header && (
                  <div className="px-3 pt-2 pb-1 font-mono text-[10.5px] text-faint uppercase tracking-[0.08em]">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13.5px]",
                    i === active ? "bg-raised text-fg" : "text-muted",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="font-mono text-[11px] text-faint">{c.hint}</span>}
                  {i === active && <CornerDownLeft className="size-3.5 text-faint" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
