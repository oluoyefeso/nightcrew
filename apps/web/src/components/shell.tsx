import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { clsx } from "clsx";
import { Monitor, Moon, RefreshCw, Search, Settings2, Sun } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { crewQuery, tasksQuery, useCrewStream, useSync } from "../api";
import { CommandBar } from "./command-bar";
import { BrandMark, Kbd } from "./ui";

function NavLink({
  to,
  children,
  className,
}: {
  to: "/" | "/tonight" | "/later";
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

/** Idle: when the crew starts. Working: what it's on. */
function CrewPill() {
  const crew = useQuery(crewQuery);
  const s = crew.data;
  if (!s) return null;
  if (s.state === "idle") {
    const t = new Date(s.nextStartAt);
    return (
      <Link
        to="/tonight"
        className="hidden items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[11.5px] text-faint hover:text-muted lg:inline-flex"
      >
        <span className="size-1.5 rounded-full bg-faint" />
        starts {t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </Link>
    );
  }
  return (
    <Link
      to={s.runId ? "/run/$runId" : "/tonight"}
      params={s.runId ? { runId: s.runId } : undefined}
      className="inline-flex items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--dawn)_14%,transparent)] px-3 py-1.5 font-mono text-[11.5px] text-dawn"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-dawn" />
      {s.state === "waiting" ? "waiting" : s.state === "stopping" ? "stopping" : "crew working"}
    </Link>
  );
}

export function Shell() {
  useCrewStream();
  const tasks = useQuery(tasksQuery(["queued", "running"]));
  const queued = tasks.data?.length ?? 0;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-line border-b bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 font-medium text-[15px] tracking-[-0.02em]">
            <BrandMark className="size-[22px]" />
            NightCrew
          </Link>
          <nav className="flex items-center gap-0.5 overflow-x-auto text-[13px]">
            <NavLink to="/">Morning Report</NavLink>
            <NavLink to="/tonight">
              Tonight
              {queued > 0 && (
                <span className="rounded-full bg-[color-mix(in_srgb,var(--dawn)_18%,transparent)] px-1.5 font-mono text-[10.5px] text-dawn">
                  {queued}
                </span>
              )}
            </NavLink>
            <NavLink to="/later" className="hidden sm:inline-flex">
              Later
            </NavLink>
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
            <SyncButton />
            <Link
              to="/settings"
              aria-label="Settings"
              title="Settings"
              className="grid size-8 place-items-center rounded-full text-muted hover:bg-raised hover:text-fg data-[status=active]:text-fg"
            >
              <Settings2 className="size-4" />
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <CommandBar />
    </div>
  );
}

function SyncButton() {
  const sync = useSync();
  return (
    <button
      type="button"
      onClick={() => sync.mutate()}
      disabled={sync.isPending}
      className="inline-flex h-8 items-center gap-2 rounded-full px-3 text-[12.5px] text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-60"
      title="Re-import runs and refresh PR state from GitHub"
    >
      <RefreshCw className={clsx("size-3.5", sync.isPending && "animate-spin")} strokeWidth={2} />
      <span className="hidden sm:inline">{sync.isPending ? "Syncing" : sync.isError ? "Sync failed" : "Sync"}</span>
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
