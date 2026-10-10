import type { Train } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, TrainFront } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Button } from "./ui";

/** Tonight's trains: one integration branch per repo, one PR to merge. */
export function TrainCards({ nightId, onOpen }: { nightId: string; onOpen: (runId: string) => void }) {
  const trains = useQuery({
    queryKey: ["trains", nightId],
    queryFn: () => api.get<Train[]>(`/api/trains?night=${nightId}`),
  });
  const list = (trains.data ?? []).filter((t) => t.cars.length > 0);
  if (!list.length) return null;
  return (
    <div className="grid gap-3">
      {list.map((t) => {
        const on = t.cars.filter((c) => c.state === "on");
        return (
          <section
            key={t.id}
            className="grid gap-3 rounded-2xl bg-surface p-5 ring-1 ring-[color-mix(in_srgb,var(--sky)_35%,transparent)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2.5 font-medium text-[14px]">
                <TrainFront className="size-4 text-sky" />
                Nightly train · {t.repoName}
                <span className="font-mono text-[12px] text-faint">
                  {on.length} {on.length === 1 ? "task" : "tasks"}, tested together
                </span>
              </h2>
              {t.prUrl ? (
                <a
                  href={t.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5 font-mono text-[12px] hover:text-dawn"
                >
                  PR #{t.prNumber} <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="font-mono text-[11.5px] text-faint">{t.branch} · PR opens when the night ends</span>
              )}
            </div>
            <ol className="flex flex-wrap gap-1.5">
              {t.cars.map((c) => (
                <li key={c.runId}>
                  <button
                    type="button"
                    onClick={() => onOpen(c.runId)}
                    title={
                      c.state === "broke"
                        ? "Broke the train's tests, so it came off"
                        : c.state === "pulled"
                          ? "Taken off by you"
                          : "On the train"
                    }
                    className={
                      c.state === "on"
                        ? "rounded-lg bg-raised px-2.5 py-1 font-mono text-[11.5px] ring-1 ring-[color-mix(in_srgb,var(--ok)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--raised)_70%,var(--fg)_8%)]"
                        : "rounded-lg px-2.5 py-1 font-mono text-[11.5px] text-faint line-through ring-1 ring-line"
                    }
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

interface Track {
  repoId: string;
  repoName: string;
  level: string;
  recent: number;
  mergedAsIs: number;
  suggestion: { level: "train" | "ship"; reason: string } | null;
}

const COPY = {
  train: { ask: "Let the crew use the nightly train?", button: "Promote to the train" },
  ship: { ask: "Let the crew ship to dev on its own?", button: "Promote to Ship to dev" },
};

/** "14 of the last 15 merged unchanged. Promote?" Trust is earned from the record. */
export function PromotionBanners({ onToast }: { onToast: (m: string) => void }) {
  const qc = useQueryClient();
  const track = useQuery({ queryKey: ["track"], queryFn: () => api.get<Track[]>("/api/track") });
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("nc-promo-dismissed") ?? "[]");
    } catch {
      return [];
    }
  });
  const promote = useMutation({
    mutationFn: (t: Track) => api.post(`/api/repos/${t.repoId}/promote`, { level: t.suggestion?.level }),
    onSuccess: (_, t) => {
      onToast(`${t.repoName} moved up to ${t.suggestion?.level === "ship" ? "Ship to dev" : "the nightly train"}.`);
      qc.invalidateQueries({ queryKey: ["track"] });
      qc.invalidateQueries({ queryKey: ["repos"] });
    },
    onError: (e) => onToast(e.message),
  });
  const dismiss = (key: string) => {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      localStorage.setItem("nc-promo-dismissed", JSON.stringify(next));
    } catch {}
  };
  const items = (track.data ?? []).filter(
    (t) => t.suggestion && !dismissed.includes(`${t.repoId}:${t.suggestion.level}:${t.mergedAsIs}`),
  );
  if (!items.length) return null;
  return (
    <div className="grid gap-2">
      {items.map((t) => {
        const s = t.suggestion as NonNullable<Track["suggestion"]>;
        const key = `${t.repoId}:${s.level}:${t.mergedAsIs}`;
        return (
          <div
            key={key}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface px-5 py-3.5 ring-1 ring-line"
          >
            <p className="text-[14px]">
              <b className="font-semibold">{s.reason.replace("tasks", `tasks in ${t.repoName}`)}</b>{" "}
              <span className="text-muted">{COPY[s.level].ask}</span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => dismiss(key)}>
                Not yet
              </Button>
              <Button size="sm" variant="primary" onClick={() => promote.mutate(t)} disabled={promote.isPending}>
                {COPY[s.level].button}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
