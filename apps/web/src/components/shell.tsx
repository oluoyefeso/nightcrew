import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { clsx } from "clsx";
import { ChevronDown, Monitor, Moon, RefreshCw, Search, Settings2, Sun } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { crewQuery, tasksQuery, useCrewStream, useSync } from "../api";
import { CommandBar } from "./command-bar";
import { BrandMark, Kbd } from "./ui";

function NavLink({
  to,
  children,
  className,
}: {
  to: "/" | "/agents" | "/later" | "/history" | "/missions" | "/operations";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/", includeSearch: false }}
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted transition-colors hover:text-fg data-[status=active]:bg-raised data-[status=active]:text-fg",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** How many agents are working right now. */
function CrewPill() {
  const crew = useQuery(crewQuery);
  const s = crew.data;
  if (!s) return null;
  const working = s.active.length;
  const label =
    s.state === "paused"
      ? "dispatch paused"
      : s.state === "waiting"
        ? "backing off"
        : working
          ? `${working} working`
          : "agents idle";
  return (
    <Link
      to="/agents"
      aria-label={label}
      className={clsx(
        "inline-flex items-center gap-2 whitespace-nowrap rounded-full px-2.5 py-1.5 font-mono text-[11.5px] sm:px-3",
        working ? "bg-[color-mix(in_srgb,var(--dawn)_14%,transparent)] text-dawn" : "text-faint hover:text-muted",
      )}
    >
      <span
        className={clsx(
          "size-1.5 rounded-full",
          working ? "animate-pulse bg-dawn" : s.state === "paused" ? "bg-bad" : "bg-faint",
        )}
      />
      {/* Phones get the dot (and the count when agents are working); the words from sm up. */}
      <span className="hidden sm:inline">{label}</span>
      {working > 0 && <span className="sm:hidden">{working}</span>}
    </Link>
  );
}

/** Toasts from anywhere: window.dispatchEvent(new CustomEvent("nc:toast", { detail: "…" })). */
function Toasts() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);
  useEffect(() => {
    let n = 0;
    const onToast = (e: Event) => {
      const id = ++n;
      setItems((list) => [...list.slice(-2), { id, text: String((e as CustomEvent).detail) }]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), 3600);
    };
    window.addEventListener("nc:toast", onToast);
    return () => window.removeEventListener("nc:toast", onToast);
  }, []);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 grid justify-items-center gap-2 px-4"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded-full bg-fg px-4 py-2 text-[13px] text-bg shadow-[var(--shadow)] motion-safe:animate-[nc-rise_.24s_var(--ease-out-quint)]"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Shell() {
  useCrewStream();
  const tasks = useQuery(tasksQuery(["queued", "running"]));
  // Working + waiting: everything the agents have on their plate.
  const queued = tasks.data?.length ?? 0;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link
            to="/"
            aria-label="NightCrew"
            className="flex shrink-0 items-center gap-2.5 font-medium text-[15px] tracking-[-0.02em]"
          >
            <BrandMark className="size-[22px]" />
            <span className="hidden sm:inline">NightCrew</span>
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-0.5 text-[13px]">
            <NavLink to="/">Home</NavLink>
            <NavLink to="/missions">Goals</NavLink>
            <MoreMenu queued={queued} />
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <CrewPill />
            <button
              type="button"
              onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              className="hidden h-8 items-center gap-2 rounded-full px-3 text-[12.5px] text-muted ring-1 ring-line ring-inset hover:text-fg md:inline-flex"
            >
              <Search className="size-3.5" /> <Kbd>⌘K</Kbd>
            </button>
            <Link
              to="/settings"
              aria-label="Settings"
              title="Settings"
              className="grid size-8 place-items-center rounded-full text-muted hover:bg-raised hover:text-fg data-[status=active]:text-fg"
            >
              <Settings2 className="size-4" />
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <CommandBar />
      <Toasts />
    </div>
  );
}

const AUX = [
  { to: "/agents", label: "Agents" },
  { to: "/later", label: "Later" },
  { to: "/operations", label: "Operations" },
  { to: "/history", label: "History" },
] as const;

/** Everything that is not Home or Goals, plus the quiet controls. */
function MoreMenu({ queued }: { queued: number }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const previousPath = useRef(pathname);
  const activeAux = AUX.find((a) => pathname === a.to || pathname.startsWith(`${a.to}/`));

  const close = useCallback(() => {
    if (ref.current) ref.current.open = false;
  }, []);

  useEffect(() => {
    if (previousPath.current !== pathname) close();
    previousPath.current = pathname;
  }, [pathname, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      ref.current?.querySelector("summary")?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  return (
    <details ref={ref} className="relative" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        aria-label={activeAux ? `More destinations, current: ${activeAux.label}` : "More destinations"}
        className={clsx(
          "inline-flex cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors hover:text-fg [&::-webkit-details-marker]:hidden",
          activeAux ? "bg-raised text-fg" : "text-muted",
        )}
      >
        More
        <ChevronDown className="size-3.5" />
      </summary>
      <div className="absolute top-full right-0 z-40 sm:right-auto sm:left-0 mt-1.5 w-56 rounded-lg bg-surface p-1 text-[13px] shadow-[var(--shadow)] ring-1 ring-line">
        {AUX.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            onClick={close}
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-muted hover:bg-raised hover:text-fg data-[status=active]:bg-raised data-[status=active]:text-fg"
          >
            {a.label}
            {a.to === "/agents" && queued > 0 && (
              <span className="rounded-full bg-[color-mix(in_srgb,var(--dawn)_18%,transparent)] px-1.5 font-mono text-[10.5px] text-dawn">
                {queued}
              </span>
            )}
          </Link>
        ))}
        <div className="my-1 border-line border-t" />
        <SyncButton />
        <div className="flex items-center justify-between px-2.5 py-1">
          <span className="text-muted">Theme</span>
          <ThemeToggle />
        </div>
      </div>
    </details>
  );
}

function SyncButton() {
  const sync = useSync();
  return (
    <button
      type="button"
      onClick={() => sync.mutate()}
      disabled={sync.isPending}
      aria-label="Sync"
      className="flex h-8 w-full items-center justify-start gap-2 rounded-md px-2.5 text-[13px] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-60"
      title="Re-import runs and refresh PR state from GitHub"
    >
      <RefreshCw className={clsx("size-3.5", sync.isPending && "animate-spin")} strokeWidth={2} />
      <span>{sync.isPending ? "Syncing" : sync.isError ? "Sync failed" : "Sync"}</span>
    </button>
  );
}

type Theme = "system" | "dark" | "light";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("nc-theme");
    return t === "dark" || t === "light" ? t : "system";
  } catch {
    return "system";
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("nc-theme");
      else localStorage.setItem("nc-theme", theme);
    } catch {}
  }, [theme]);

  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "system", label: "Match system", icon: Monitor },
    { value: "dark", label: "Night", icon: Moon },
    { value: "light", label: "Morning", icon: Sun },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex rounded-full bg-surface p-0.5 ring-1 ring-line ring-inset"
    >
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={clsx(
            "grid size-7 place-items-center rounded-full transition-colors duration-150",
            theme === value ? "bg-fg text-bg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          <Icon className="size-3.5" strokeWidth={2} />
        </button>
      ))}
    </div>
  );
}
