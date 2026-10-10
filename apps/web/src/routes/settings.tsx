import { AUTONOMY_LABEL, type AutonomyLevel, type Repo, type Settings } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api, crewQuery, reposQuery, settingsQuery } from "../api";
import { AddRepo } from "../components/add-repo";
import { ChipsEditor, Field, Select, TextInput } from "../components/form";

const LEVEL_HINT: Record<AutonomyLevel, string> = {
  propose: "Plans only. No code changes.",
  draft_pr: "One draft PR per task. You merge.",
  train: "Ready tasks merge into one nightly branch, tested together. You merge the train's PR.",
  ship: "The crew merges into your ship branch itself when evidence, the Skeptic and the rules below agree. You get Undo.",
};

export function SettingsPage() {
  const settings = useQuery(settingsQuery);
  const repos = useQuery(reposQuery);
  const crew = useQuery(crewQuery);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.patch<Settings>("/api/settings", patch),
    onSuccess: (s) => {
      qc.setQueryData(settingsQuery.queryKey, s);
      qc.invalidateQueries({ queryKey: ["crew"] });
    },
  });
  const s = settings.data;

  return (
    <div className="mx-auto grid max-w-[860px] gap-10 px-4 pt-8 pb-28 sm:px-8 lg:pt-12">
      <header className="grid gap-2">
        <h1 className="t-h1">Settings</h1>
        <p className="text-[14px] text-muted">
          Crew engine: <span className="font-mono text-fg">{crew.data?.engine ?? "…"}</span>
          {crew.data?.engine === "demo" && " (pretend runs, nothing is spent or pushed)"}
        </p>
      </header>

      {s && (
        <section className="grid gap-5">
          <h2 className="font-medium text-[16px] tracking-[-0.02em]">The night</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Start time" htmlFor="start" hint="24-hour, your local time.">
              <TextInput
                id="start"
                type="time"
                defaultValue={s.startAt}
                onBlur={(e) => e.target.value !== s.startAt && save.mutate({ startAt: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label="Nightly budget (USD)" htmlFor="budget" hint="The crew stops before passing it.">
              <TextInput
                id="budget"
                type="number"
                min={1}
                step={1}
                defaultValue={s.nightlyBudgetCents / 100}
                onBlur={(e) =>
                  save.mutate({ nightlyBudgetCents: Math.max(100, Math.round(Number(e.target.value) * 100)) })
                }
                className="font-mono"
              />
            </Field>
            <Field label="Start automatically" htmlFor="auto">
              <Select
                id="auto"
                value={s.autoStart ? "yes" : "no"}
                onChange={(e) => save.mutate({ autoStart: e.target.value === "yes" })}
              >
                <option value="yes">Yes, at the start time</option>
                <option value="no">No, I'll press Run now</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["planModel", "Planning model"],
                ["buildModel", "Building model"],
                ["reviewModel", "Review model"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label} htmlFor={key}>
                <TextInput
                  id={key}
                  defaultValue={s[key]}
                  onBlur={(e) => e.target.value && e.target.value !== s[key] && save.mutate({ [key]: e.target.value })}
                  className="font-mono"
                />
              </Field>
            ))}
          </div>
          {save.error && <p className="text-[12.5px] text-bad">{save.error.message}</p>}
        </section>
      )}

      <section className="grid gap-5">
        <div className="grid gap-1">
          <h2 className="font-medium text-[16px] tracking-[-0.02em]">Repos</h2>
          <p className="text-[13.5px] text-muted">
            Where the crew may work. Each task gets its own worktree under the repo's{" "}
            <span className="font-mono">.worktrees</span> folder.
          </p>
        </div>
        <div className="grid gap-3">
          {repos.data?.map((r) => (
            <RepoCard key={r.id} repo={r} />
          ))}
        </div>
        <div className="rounded-2xl bg-surface p-5 ring-1 ring-line">
          <AddRepo />
        </div>
      </section>
    </div>
  );
}

function RepoCard({ repo }: { repo: Repo }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (patch: Partial<Repo>) => api.patch(`/api/repos/${repo.id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/repos/${repo.id}`),
    onSuccess: () => qc.invalidateQueries(),
  });
  const extra = repo.protectedBranches.filter((b) => ![repo.defaultBranch, "main", "master"].includes(b));
  return (
    <article className="grid gap-4 rounded-2xl bg-surface p-5 ring-1 ring-line">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="font-medium text-[16px] tracking-[-0.02em]">{repo.name}</h3>
          <span className="font-mono text-[11.5px] text-faint">{repo.path}</span>
        </div>
        <button
          type="button"
          aria-label={`Remove ${repo.name}`}
          title="Remove (deletes its tasks)"
          onClick={() => remove.mutate()}
          className="grid size-7 place-items-center rounded-full text-faint hover:bg-raised hover:text-bad"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Autonomy" htmlFor={`level-${repo.id}`} hint={LEVEL_HINT[repo.level]}>
          <Select
            id={`level-${repo.id}`}
            value={repo.level}
            onChange={(e) => update.mutate({ level: e.target.value as AutonomyLevel })}
          >
            {(Object.keys(AUTONOMY_LABEL) as AutonomyLevel[]).map((l) => (
              <option key={l} value={l}>
                {AUTONOMY_LABEL[l]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Test command" htmlFor={`test-${repo.id}`} hint="NightCrew runs it after every task.">
          <TextInput
            id={`test-${repo.id}`}
            defaultValue={repo.testCommand ?? ""}
            onBlur={(e) => update.mutate({ testCommand: e.target.value || null })}
            placeholder="bun test"
            className="font-mono"
          />
        </Field>
      </div>
      {(repo.level === "ship" || repo.level === "train") && (
        <div className="grid gap-4 rounded-xl bg-raised/50 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Ship branch"
              htmlFor={`ship-${repo.id}`}
              hint="Where the crew may merge on its own, like dev or staging. Never a protected branch."
            >
              <TextInput
                id={`ship-${repo.id}`}
                defaultValue={repo.shipBranch ?? ""}
                onBlur={(e) => update.mutate({ shipBranch: e.target.value.trim() || null })}
                placeholder="dev"
                className="font-mono"
              />
            </Field>
            <Field
              label="Allowed to ship on their own"
              htmlFor={`allow-${repo.id}`}
              hint="A task ships only if every file it changes matches."
            >
              <ChipsEditor
                id={`allow-${repo.id}`}
                value={repo.allowShip}
                onChange={(allowShip) => update.mutate({ allowShip })}
                placeholder="src/components/**, docs/**"
              />
            </Field>
          </div>
          <Field
            label="Always wait for me"
            htmlFor={`ask-${repo.id}`}
            hint="Any change touching these goes to Needs your eyes, whatever the level."
          >
            <ChipsEditor
              id={`ask-${repo.id}`}
              value={repo.alwaysAsk}
              onChange={(alwaysAsk) => update.mutate({ alwaysAsk })}
              placeholder="migrations/**, src/auth/**, package.json"
            />
          </Field>
          <TrackLine repoId={repo.id} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Install command" htmlFor={`setup-${repo.id}`} hint="Runs in each fresh worktree before tests.">
          <TextInput
            id={`setup-${repo.id}`}
            defaultValue={repo.setupCommand ?? ""}
            onBlur={(e) => update.mutate({ setupCommand: e.target.value || null })}
            placeholder="bun install --frozen-lockfile"
            className="font-mono"
          />
        </Field>
        <Field
          label="Preview command"
          htmlFor={`preview-${repo.id}`}
          hint={
            <>
              For UI screenshots. Gets <span className="font-mono">$PORT</span>; use{" "}
              <span className="font-mono">static</span> to serve the folder.
            </>
          }
        >
          <TextInput
            id={`preview-${repo.id}`}
            defaultValue={repo.previewCommand ?? ""}
            onBlur={(e) => update.mutate({ previewCommand: e.target.value || null })}
            placeholder="bun run dev -- --port $PORT"
            className="font-mono"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Preview URL" htmlFor={`url-${repo.id}`}>
          <TextInput
            id={`url-${repo.id}`}
            defaultValue={repo.previewUrl ?? "http://localhost:{port}"}
            onBlur={(e) => update.mutate({ previewUrl: e.target.value || null })}
            className="font-mono"
          />
        </Field>
        <Field label="Pages to screenshot" htmlFor={`paths-${repo.id}`} hint="Up to six paths.">
          <ChipsEditor
            id={`paths-${repo.id}`}
            value={repo.previewPaths}
            onChange={(previewPaths) => update.mutate({ previewPaths })}
            placeholder="/, /settings"
          />
        </Field>
      </div>
      <Field
        label="Also protect these branches"
        htmlFor={`pb-${repo.id}`}
        hint={`${[...new Set([repo.defaultBranch, "main", "master"])].join(", ")} are always protected.`}
      >
        <ChipsEditor
          id={`pb-${repo.id}`}
          value={extra}
          onChange={(protectedBranches) => update.mutate({ protectedBranches })}
          placeholder="production, release/*"
        />
      </Field>
    </article>
  );
}

function TrackLine({ repoId }: { repoId: string }) {
  const t = useQuery({
    queryKey: ["track", repoId],
    queryFn: () =>
      api.get<{ recent: number; mergedAsIs: number; sentBack: number; undone: number }>(`/api/repos/${repoId}/track`),
  });
  if (!t.data) return null;
  const { recent, mergedAsIs, sentBack, undone } = t.data;
  return (
    <p className="font-mono text-[11.5px] text-muted">
      Track record, last {recent} finished: {mergedAsIs} merged unchanged · {sentBack} sent back · {undone} undone
    </p>
  );
}
