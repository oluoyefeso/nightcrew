import {
  AUTONOMY_LABEL,
  AUTONOMY_ORDER,
  DEFAULT_TASK_POLICY,
  POLICY_TASK_TYPES,
  type PolicyTaskType,
  type PolicyTemplate,
  policySummary,
  type Repo,
  resolvePolicy,
  TASK_TYPE_LABEL,
  type TaskPolicies,
  type TaskPolicy,
} from "@nightcrew/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { useState } from "react";
import { api, toast } from "../api";
import { Select, TextInput } from "./form";
import { Button } from "./ui";

export function PolicyEditor({ repo }: { repo: Repo }) {
  const [rules, setRules] = useState<TaskPolicies>(repo.policies ?? {});
  const qc = useQueryClient();
  const [templateName, setTemplateName] = useState("");
  const templates = useQuery({
    queryKey: ["policy-templates"],
    queryFn: () => api.get<PolicyTemplate[]>("/api/policy-templates"),
  });
  const saveTemplate = useMutation({
    mutationFn: () => api.post("/api/policy-templates", { name: templateName, policies: rules }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policy-templates"] });
      setTemplateName("");
    },
  });
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
        <div className="grid gap-2 rounded-xl bg-surface p-3">
          <label htmlFor={`template-${repo.id}`} className="text-[12px] text-muted">
            Reusable verification workflow
          </label>
          <Select
            id={`template-${repo.id}`}
            value=""
            onChange={(e) => {
              const template = templates.data?.find((t) => t.id === e.target.value);
              if (template) setRules(template.policies);
            }}
          >
            <option value="">Preview a saved template…</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <p className="text-[12px] text-muted">
            Loading a template previews its effective routes below. Save task routes to apply it within this
            repository's authority ceiling.
          </p>
          <div className="flex flex-wrap gap-2">
            <TextInput
              aria-label="New verification template name"
              value={templateName}
              maxLength={100}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Name this verification workflow"
            />
            <Button disabled={!templateName.trim() || saveTemplate.isPending} onClick={() => saveTemplate.mutate()}>
              Save as template
            </Button>
          </div>
          {saveTemplate.error && (
            <p role="alert" className="text-bad">
              {saveTemplate.error.message}
            </p>
          )}
        </div>
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
                <label htmlFor={`reviewers-${repo.id}-${type}`} className="grid gap-1 text-[12px] text-muted">
                  Independent reviews
                  <Select
                    id={`reviewers-${repo.id}-${type}`}
                    aria-label={`${TASK_TYPE_LABEL[type]} independent reviews`}
                    value={rule.reviewers ?? 1}
                    onChange={(e) => change(type, { reviewers: Number(e.target.value) })}
                  >
                    <option value={1}>One reviewer</option>
                    <option value={2}>Two reviewers</option>
                    <option value={3}>Three reviewers</option>
                  </Select>
                </label>
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
