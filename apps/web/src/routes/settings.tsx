import { AUTONOMY_LABEL, type AutonomyLevel, type Repo, type Settings } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { api, crewQuery, reposQuery, settingsQuery } from "../api";
import { AddRepo } from "../components/add-repo";
import { ChipsEditor, Field, Select, TextInput } from "../components/form";

const LEVEL_HINT: Record<AutonomyLevel, string> = {
  propose: "Plans only. No code changes.",
  draft_pr: "One draft PR per task. You merge.",
  train: "Ready tasks merge into one daily branch, tested together. You merge the train's PR.",
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
          <h2 className="font-medium text-[16px] tracking-[-0.02em]">Agents</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Agents at once" htmlFor="max-agents" hint="Across all repos.">
              <TextInput
                id="max-agents"
                type="number"
                min={1}
                max={12}
                defaultValue={s.maxAgents}
                onBlur={(e) =>
                  save.mutate({ maxAgents: Math.min(12, Math.max(1, Math.round(Number(e.target.value) || 1))) })
                }
                className="font-mono"
              />
            </Field>
            <Field
              label="Per repo"
              htmlFor="per-repo"
              hint="Above 1, same-repo agents use separate branches; the train catches conflicts."
            >
              <TextInput
                id="per-repo"
                type="number"
                min={1}
                max={6}
                defaultValue={s.maxPerRepo}
                onBlur={(e) =>
                  save.mutate({ maxPerRepo: Math.min(6, Math.max(1, Math.round(Number(e.target.value) || 1))) })
                }
                className="font-mono"
              />
            </Field>
            <Field
              label="Daily token budget (millions)"
              htmlFor="budget"
              hint="Tokens used today plus the caps of running agents. New agents wait rather than pass it."
            >
              <TextInput
                id="budget"
                type="number"
                min={0.1}
                step={1}
                defaultValue={s.dailyTokenBudget / 1_000_000}
                onBlur={(e) =>
                  save.mutate({ dailyTokenBudget: Math.max(100_000, Math.round(Number(e.target.value) * 1_000_000)) })
                }
                className="font-mono"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Dispatch" htmlFor="dispatch" hint="Paused: running agents finish, nothing new starts.">
              <Select
                id="dispatch"
                value={s.dispatch ? "on" : "off"}
                onChange={(e) => save.mutate({ dispatch: e.target.value === "on" })}
              >
                <option value="on">Start work as soon as it's added</option>
                <option value="off">Paused</option>
              </Select>
            </Field>
            <Field
              label="Schedule time"
              htmlFor="schedule"
              hint={'Where "Schedule" sends work, e.g. off-peak. Local time.'}
            >
              <TextInput
                id="schedule"
                type="time"
                defaultValue={s.scheduleAt}
                onBlur={(e) => {
                  // A cleared time field means "no change"; the schedule always needs a time.
                  if (!e.target.value) e.target.value = s.scheduleAt;
                  else if (e.target.value !== s.scheduleAt) save.mutate({ scheduleAt: e.target.value });
                }}
                className="font-mono"
              />
            </Field>
            <Field
              label="Slack webhook"
              htmlFor="slack"
              hint="Optional. Agents report there when they finish or need you."
            >
              <TextInput
                id="slack"
                defaultValue={s.slackWebhookUrl ?? ""}
                onBlur={(e) =>
                  (e.target.value || null) !== s.slackWebhookUrl &&
                  save.mutate({ slackWebhookUrl: e.target.value.trim() || null })
                }
                placeholder="https://hooks.slack.com/…"
                className="font-mono"
              />
            </Field>
          </div>
          <BrowserNotifications />
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
            Where the crew may work. Each task gets its own clone under NightCrew's{" "}
            <span className="font-mono">work</span> folder, and its result lands in your repo by commit.
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
  // A level picked here but not saved yet: Ship to dev needs a ship branch and
  // allowed paths first, so picking it shows those fields and saves once they're set.
  const [picked, setPicked] = useState<AutonomyLevel | null>(null);
  const level = picked ?? repo.level;
  const shipReady = (r: Pick<Repo, "shipBranch" | "allowShip">) => Boolean(r.shipBranch && r.allowShip.length);
  const update = useMutation({
    mutationFn: (patch: Partial<Repo>) => api.patch<Repo>(`/api/repos/${repo.id}`, patch),
    onSuccess: (saved, patch) => {
      if (patch.level) setPicked(null);
      // Ship was picked and this save completed its branch and paths: save the level now.
      else if (picked === "ship" && saved.level !== "ship" && shipReady(saved)) update.mutate({ level: "ship" });
      return qc.invalidateQueries({ queryKey: ["repos"] });
    },
  });
  const pickLevel = (l: AutonomyLevel) => {
    setPicked(l === repo.level ? null : l);
    if (l === "ship" && !shipReady(repo)) return update.reset();
    if (l !== repo.level) update.mutate({ level: l });
  };
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
        <Field
          label="Autonomy"
          htmlFor={`level-${repo.id}`}
          hintId={`level-hint-${repo.id}`}
          hint={
            picked === "ship" && repo.level !== "ship" ? (
              <>
                <span className="font-medium text-dawn">Not saved yet.</span>{" "}
                <span className="text-muted">Set a ship branch and the paths allowed to ship below.</span>
              </>
            ) : (
              LEVEL_HINT[level]
            )
          }
        >
          <Select
            id={`level-${repo.id}`}
            aria-describedby={`level-hint-${repo.id}`}
            value={level}
            onChange={(e) => pickLevel(e.target.value as AutonomyLevel)}
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
      {update.error && <p className="text-[12.5px] text-bad">{update.error.message}</p>}
      {(level === "ship" || level === "train") && (
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
                onBlur={(e) => {
                  const shipBranch = e.target.value.trim() || null;
                  if (shipBranch !== repo.shipBranch) update.mutate({ shipBranch });
                }}
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
        <Field label="Install command" htmlFor={`setup-${repo.id}`} hint="Runs in each fresh task clone before tests.">
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

function BrowserNotifications() {
  const supported = typeof Notification !== "undefined";
  const [perm, setPerm] = useState(supported ? Notification.permission : "denied");
  if (!supported) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-raised/50 px-4 py-3">
      <p className="text-[13.5px]">
        Desktop notifications{" "}
        <span className="text-muted">when an agent finishes or needs you and this tab isn't in front.</span>
      </p>
      {perm === "granted" ? (
        <span className="font-mono text-[12px] text-ok">On</span>
      ) : perm === "denied" ? (
        <span className="text-[12px] text-faint">Blocked in your browser settings</span>
      ) : (
        <button
          type="button"
          onClick={() => Notification.requestPermission().then(setPerm)}
          className="rounded-full bg-fg px-3.5 py-1.5 font-medium text-[12.5px] text-bg"
        >
          Turn on
        </button>
      )}
    </div>
  );
}
