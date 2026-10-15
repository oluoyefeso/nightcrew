import type { ModelConnection } from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "../api";
import { Field, Select, TextInput } from "./form";

type ConnectionView = ModelConnection & {
  credentialConfigured: boolean;
  active: { kind: "models" | "check"; stopping: boolean } | null;
};
type Profile = Pick<ModelConnection, "name" | "baseUrl" | "model" | "apiKeyEnv">;
const queryKey = ["connections"];
const button = "rounded-lg border border-line px-3 py-1.5 text-[12.5px] hover:bg-raised disabled:opacity-40";
const initial: Profile = { name: "Local model", baseUrl: "http://localhost:11434/v1", model: "", apiKeyEnv: null };

/** Optional connection management stays inside Settings, away from the goal workspace. */
export function ModelConnections() {
  const [open, setOpen] = useState(false);
  const connections = useQuery({
    queryKey,
    queryFn: () => api.get<ConnectionView[]>("/api/connections"),
    refetchInterval: open ? 2000 : false,
  });
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const create = useMutation({
    mutationFn: (profile: Profile) => api.post<ConnectionView>("/api/connections", profile),
    onSuccess: () => {
      setAdding(false);
      qc.invalidateQueries({ queryKey });
    },
  });
  return (
    <section aria-label="Model connections" className="border-y border-line py-5">
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-[15px] font-medium">
          Model connections <span className="ml-2 text-[12px] font-normal text-faint">Optional</span>
        </summary>
        <div className="mt-4 grid gap-4">
          <p className="text-[13px] text-muted">
            Save a local or hosted compatible endpoint and check its tools. These connections do not run tasks; coding
            still uses the crew engine shown above.
          </p>
          {connections.isPending && <p className="text-[13px] text-muted">Loading connections…</p>}
          {connections.error && (
            <p role="alert" className="text-[13px] text-bad">
              {connections.error.message}
            </p>
          )}
          {connections.data?.length === 0 && <p className="text-[13px] text-faint">No connections saved.</p>}
          {connections.data?.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
          {adding ? (
            <ProfileEditor
              initial={initial}
              pending={create.isPending}
              error={create.error}
              onSave={(p) => create.mutate(p)}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              className={`${button} justify-self-start`}
              onClick={() => {
                create.reset();
                setAdding(true);
              }}
            >
              Add connection
            </button>
          )}
        </div>
      </details>
    </section>
  );
}

function ConnectionRow({ connection: c }: { connection: ConnectionView }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey });
  const path = `/api/connections/${encodeURIComponent(c.id)}`;
  const [editing, setEditing] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const check = useMutation({
    mutationFn: () => api.post(`${path}/check`, { revision: c.revision }),
    onSettled: refresh,
  });
  const discover = useMutation({
    mutationFn: () => api.post<{ models: string[] }>(`${path}/models`, { revision: c.revision }),
    onSuccess: (result) => {
      setModels(result.models);
      setEditing(true);
    },
    onSettled: refresh,
  });
  const stop = useMutation({ mutationFn: () => api.post(`${path}/stop`), onSettled: refresh });
  const save = useMutation({
    mutationFn: (profile: Profile) => api.patch(path, { ...profile, revision: c.revision }),
    onSuccess: () => {
      setEditing(false);
      setModels([]);
      check.reset();
      discover.reset();
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(path, { revision: c.revision }), onSuccess: refresh });
  const busy = Boolean(c.active) || check.isPending || discover.isPending;
  const status = busy
    ? c.active?.stopping
      ? "Stopping…"
      : "Checking…"
    : c.lastCheck
      ? {
          passed: "Tool check passed",
          failed: "Tool check failed",
          cancelled: "Check stopped",
        }[c.lastCheck.status]
      : "Unchecked";
  const error = check.error ?? discover.error ?? stop.error ?? remove.error;
  return (
    <article aria-label={c.name} className="min-w-0 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-medium text-[14px] break-all">{c.name}</h3>
        <span role="status" className="text-[12px] text-muted">
          {status}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-[11.5px] text-faint">
        {c.model || "Choose a model"} · {c.baseUrl}
      </p>
      {!c.credentialConfigured && (
        <p className="mt-2 text-[12px] text-warn">Set {c.apiKeyEnv} before starting NightCrew, then restart.</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {busy ? (
          <button
            type="button"
            className={button}
            disabled={!c.active || stop.isPending || c.active.stopping}
            onClick={() => stop.mutate()}
          >
            Stop check
          </button>
        ) : (
          <>
            <button
              type="button"
              className={button}
              disabled={!c.model || !c.credentialConfigured || editing}
              onClick={() => {
                stop.reset();
                check.mutate();
              }}
            >
              Check tools
            </button>
            <button
              type="button"
              className={button}
              disabled={!c.credentialConfigured || editing}
              onClick={() => {
                discover.reset();
                discover.mutate();
              }}
            >
              Discover models
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                save.reset();
                setEditing(!editing);
                setConfirmRemove(false);
              }}
            >
              {editing ? "Close editor" : "Edit"}
            </button>
          </>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-faint">
        Tool checks use provider tokens outside task budgets and send only a synthetic prompt. They stop waiting after
        30 seconds.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-bad">
          {error.message}
        </p>
      )}
      {discover.isSuccess && (
        <p className="mt-2 text-[12px] text-muted">{models.length} models found. Choose a model below and save it.</p>
      )}
      {editing && (
        <div className="mt-4">
          <ProfileEditor
            key={c.revision}
            initial={c}
            models={models}
            pending={save.isPending}
            error={save.error}
            onSave={(p) => save.mutate(p)}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
      {c.lastCheck && (
        <details className="mt-3 text-[12px] text-muted">
          <summary className="cursor-pointer">Check evidence · {new Date(c.lastCheck.at).toLocaleString()}</summary>
          <div className="mt-2 grid gap-1.5 break-words">
            <p>{c.lastCheck.summary}</p>
            <p>
              {c.lastCheck.turns} responses · {(c.lastCheck.elapsedMs / 1000).toFixed(1)}s
            </p>
            <p>
              {c.lastCheck.usage.status === "unknown"
                ? "Token usage was not reported."
                : `Observed tokens: ${c.lastCheck.usage.inputObserved ?? "unknown"} input · ${c.lastCheck.usage.outputObserved ?? "unknown"} output${c.lastCheck.usage.status === "partial" ? " (partial reporting)" : ""}.`}
            </p>
            <p className="text-faint">
              This checks one synthetic Read exchange. It does not verify coding ability. Stopping a check ends
              NightCrew's request; the provider may continue inference.
            </p>
          </div>
        </details>
      )}
      {!busy && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-faint">
          {confirmRemove ? (
            <>
              <span>Remove saved connection?</span>
              <button type="button" className={button} disabled={remove.isPending} onClick={() => remove.mutate()}>
                Remove connection
              </button>
              <button type="button" className={button} onClick={() => setConfirmRemove(false)}>
                Keep connection
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)} className="hover:text-fg">
              Remove
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function ProfileEditor({
  initial: value,
  models = [],
  pending,
  error,
  onSave,
  onCancel,
}: {
  initial: Profile;
  models?: string[];
  pending: boolean;
  error: Error | null;
  onSave: (profile: Profile) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Profile>({
    name: value.name,
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyEnv: value.apiKeyEnv,
  });
  const change = (key: keyof Profile, value: string) =>
    setDraft((p) => ({ ...p, [key]: key === "apiKeyEnv" ? value || null : value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
      className="grid gap-3 rounded-lg border border-line p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Connection name" htmlFor={`${id}-name`}>
          <TextInput
            id={`${id}-name`}
            value={draft.name}
            onChange={(e) => change("name", e.target.value)}
            required
            maxLength={80}
            autoComplete="off"
          />
        </Field>
        <Field label="API base URL" htmlFor={`${id}-url`} hint="HTTPS, or HTTP on this machine.">
          <TextInput
            id={`${id}-url`}
            value={draft.baseUrl}
            onChange={(e) => change("baseUrl", e.target.value)}
            required
            maxLength={2048}
            type="url"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Model ID" htmlFor={`${id}-model`} hint="Optional until you run a tool check.">
          {models.length ? (
            <Select id={`${id}-model`} value={draft.model} onChange={(e) => change("model", e.target.value)}>
              <option value="">Choose a model</option>
              {draft.model && !models.includes(draft.model) && <option value={draft.model}>{draft.model}</option>}
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          ) : (
            <TextInput
              id={`${id}-model`}
              value={draft.model}
              onChange={(e) => change("model", e.target.value)}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field
          label="Key environment variable"
          htmlFor={`${id}-key`}
          hint="Variable name only, e.g. MODEL_API_KEY. Leave empty if no key is needed."
        >
          <TextInput
            id={`${id}-key`}
            value={draft.apiKeyEnv ?? ""}
            onChange={(e) => change("apiKeyEnv", e.target.value)}
            maxLength={100}
            pattern="[A-Z_][A-Z0-9_]*"
            autoComplete="off"
            spellCheck={false}
            placeholder="MODEL_API_KEY"
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-bad">
          {error.message}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={`${button} bg-fg text-bg hover:bg-fg/90`}>
          {pending ? "Saving…" : "Save connection"}
        </button>
        <button type="button" disabled={pending} onClick={onCancel} className={button}>
          Cancel
        </button>
      </div>
    </form>
  );
}
