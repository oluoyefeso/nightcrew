import {
  AUTONOMY_LABEL,
  AUTONOMY_ORDER,
  DEFAULT_TASK_POLICY,
  POLICY_TASK_TYPES,
  type PolicyTaskType,
  policySummary,
  type Repo,
  resolvePolicy,
  TASK_TYPE_LABEL,
  type TaskPolicies,
  type TaskPolicy,
} from "@nightcrew/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { useState } from "react";
import { api, toast } from "../api";
import { Select } from "./form";
import { Button } from "./ui";

export function PolicyEditor({ repo }: { repo: Repo }) {
  const [rules, setRules] = useState<TaskPolicies>(repo.policies ?? {});
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.patch<Repo>(`/api/repos/${repo.id}`, { policies: rules }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["repos"] });
      qc.invalidateQueries({ queryKey: ["station"] });
      qc.invalidateQueries({ queryKey: ["preflight"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
      toast(`Saved task routes for ${repo.name}.`);
    },
  });
  const change = (type: PolicyTaskType, patch: Partial<TaskPolicy>) =>
    setRules((previous) => {
      const next = { ...previous, [type]: { ...DEFAULT_TASK_POLICY, ...previous[type], ...patch } };
      if (JSON.stringify(next[type]) === JSON.stringify(DEFAULT_TASK_POLICY)) delete next[type];
      return next;
    });
  const dirty = JSON.stringify(rules) !== JSON.stringify(repo.policies ?? {});
  return (
    <details className="rounded-xl bg-raised/40 p-4">
      <summary className="cursor-pointer text-[14px] font-medium">
        Routes by task type{" "}
        <span className="ml-2 font-mono text-[11px] text-muted">
          {Object.keys(repo.policies ?? {}).length} customised
        </span>
      </summary>
      <div className="mt-4 grid gap-4">
        <p className="text-[13px] text-muted leading-relaxed">
          The repo's autonomy is the ceiling. Each task type can stop earlier and require extra evidence. UI screenshots
          and bug-fix regression proof remain required. Research stays read-only.
        </p>
        <fieldset disabled={save.isPending} className="grid gap-3 disabled:opacity-60">
          {POLICY_TASK_TYPES.map((type) => {
            const rule = { ...DEFAULT_TASK_POLICY, ...rules[type] };
            const effective = resolvePolicy({ ...repo, policies: rules }, type);
            return (
              <div key={type} className="grid gap-3 rounded-xl bg-surface p-4 ring-1 ring-line">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label htmlFor={`policy-${repo.id}-${type}`} className="text-[13.5px] font-medium">
                    {TASK_TYPE_LABEL[type]}
                  </label>
                  <Select
                    id={`policy-${repo.id}-${type}`}
                    value={rule.autonomy ?? "inherit"}
                    onChange={(e) =>
                      change(type, {
                        autonomy: e.target.value === "inherit" ? null : (e.target.value as TaskPolicy["autonomy"]),
                      })
                    }
                  >
                    <option value="inherit">Use repo · {AUTONOMY_LABEL[repo.level]}</option>
                    {AUTONOMY_ORDER.map((authority) => (
                      <option key={authority} value={authority}>
                        {AUTONOMY_LABEL[authority]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-muted">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-dawn"
                      checked={effective.requireTests}
                      disabled={effective.regression}
                      onChange={(e) => change(type, { requireTests: e.target.checked })}
                    />{" "}
                    Require tests
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-dawn"
                      checked={effective.visual}
                      disabled={type === "ui"}
                      onChange={(e) => change(type, { visual: e.target.checked })}
                    />{" "}
                    Visual evidence
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-dawn"
                      checked={effective.regression}
                      disabled={type === "bugfix"}
                      onChange={(e) => change(type, { regression: e.target.checked })}
                    />{" "}
                    Regression proof
                  </label>
                </div>
                <p className="flex items-start gap-2 text-[12px] text-muted">
                  <Route className="mt-0.5 size-3.5 shrink-0 text-dawn" />
                  {policySummary(effective)}
                </p>
                {effective.authority === "propose" && (
                  <p className="text-[12px] text-faint">
                    Code verification applies when this route is allowed to build.
                  </p>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRules({})}>
              Use repo defaults
            </Button>
            <Button variant="primary" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save task routes"}
            </Button>
          </div>
        </fieldset>
        {dirty && <p className="text-[12px] text-dawn">Previewing unsaved rules. Save to apply them.</p>}
        {save.error && (
          <p role="alert" className="text-[12.5px] text-bad">
            {save.error.message}
          </p>
        )}
        <p className="text-[12px] text-faint">
          Running tasks keep the stricter of their starting and current rules. Increasing authority applies to the next
          run. If new evidence is required after collection, the current run waits for your review.
        </p>
      </div>
    </details>
  );
}
