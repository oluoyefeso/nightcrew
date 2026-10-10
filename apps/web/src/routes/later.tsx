import { formatTokens, TASK_TYPE_LABEL } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Inbox, MoonStar } from "lucide-react";
import { api, tasksQuery, useInvalidateTasks } from "../api";
import { Routines } from "../components/routines";
import { Button } from "../components/ui";

export function LaterPage() {
  const later = useQuery(tasksQuery(["later"]));
  const archived = useQuery(tasksQuery(["archived", "done"]));
  const invalidate = useInvalidateTasks();
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/api/tasks/${id}`, { status }),
    onSuccess: invalidate,
  });

  const intake = useMutation({
    mutationFn: () => api.post<{ added: number; errors: string[] }>("/api/intake/github"),
    onSuccess: invalidate,
  });

  return (
    <div className="mx-auto grid max-w-[860px] gap-8 px-4 pt-8 pb-28 sm:px-8 lg:pt-12">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="t-h1">Later</h1>
          <Button
            size="sm"
            onClick={() => intake.mutate()}
            disabled={intake.isPending}
            title='Imports open issues labelled "crew" from each repo'
          >
            <Inbox className="size-3.5" /> {intake.isPending ? "Importing…" : "Import GitHub issues"}
          </Button>
        </div>
        {intake.data && (
          <p className="text-[12.5px] text-muted">
            {intake.data.added
              ? `Imported ${intake.data.added} ${intake.data.added === 1 ? "issue" : "issues"}.`
              : 'No new issues labelled "crew".'}
            {intake.data.errors.length ? ` ${intake.data.errors.join(" ")}` : ""}
          </p>
        )}
        <p className="text-[14px] text-muted">
          Work you've captured but haven't started. Send anything to an agent with one click.
        </p>
      </header>

      {later.data?.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-2xl border border-line border-dashed px-6 py-12 text-center">
          <MoonStar className="size-5 text-faint" />
          <p className="text-[14px] text-muted">Nothing parked. Drafts you save to Later show up here.</p>
        </div>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          {later.data?.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-5 py-3.5">
              <Link to="/task/$taskId" params={{ taskId: t.id }} className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate font-medium text-[14px]">{t.title}</span>
                <span className="font-mono text-[11.5px] text-faint">
                  {t.repoName} · {TASK_TYPE_LABEL[t.type]} · ≤{formatTokens(t.tokenBudget)} tokens
                </span>
              </Link>
              <Button size="sm" onClick={() => move.mutate({ id: t.id, status: "queued" })}>
                Run now
              </Button>
              <button
                type="button"
                aria-label="Archive"
                title="Archive"
                onClick={() => move.mutate({ id: t.id, status: "archived" })}
                className="grid size-7 place-items-center rounded-full text-faint hover:bg-raised hover:text-fg"
              >
                <Archive className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Routines />

      {(archived.data?.length ?? 0) > 0 && (
        <section className="grid gap-2.5">
          <h2 className="font-medium text-[13px] text-muted">Finished and archived</h2>
          <div className="divide-y divide-line overflow-hidden rounded-2xl ring-1 ring-line">
            {archived.data?.slice(0, 30).map((t) => (
              <Link
                key={t.id}
                to="/task/$taskId"
                params={{ taskId: t.id }}
                className="flex items-center justify-between gap-3 px-5 py-3 text-[13.5px] text-muted hover:bg-surface hover:text-fg"
              >
                <span className="truncate">{t.title}</span>
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {t.status === "done" ? "ran" : "archived"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
