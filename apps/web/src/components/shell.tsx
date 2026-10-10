import { Link, Outlet } from "@tanstack/react-router";
import { clsx } from "clsx";
import { Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useSync } from "../api";
import { BrandMark } from "./ui";

export function Shell() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-line border-b bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-[-0.01em]">
            <BrandMark className="size-[22px]" />
            NightCrew
          </Link>
          <nav className="flex items-center gap-1 text-[13px]">
            <Link
              to="/"
              activeOptions={{ includeSearch: false }}
              className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted transition-colors hover:text-fg data-[status=active]:bg-raised data-[status=active]:text-fg"
            >
              Morning Report
            </Link>
            <span
              className="hidden cursor-default items-center gap-1.5 rounded-md px-2.5 py-1.5 text-faint sm:inline-flex"
              title="The task composer arrives in M1"
            >
              Tonight
              <span className="rounded-full border border-line px-1.5 font-mono text-[10px] leading-4">soon</span>
            </span>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <SyncButton />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
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
            theme === value ? "bg-raised text-fg" : "text-faint hover:text-muted",
          )}
        >
          <Icon className="size-3.5" strokeWidth={2} />
        </button>
      ))}
    </div>
  );
}
