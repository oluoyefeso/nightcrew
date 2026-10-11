import {
  AUTONOMY_LABEL,
  AUTONOMY_ORDER,
  DEFAULT_TASK_POLICY,
  POLICY_TASK_TYPES,
  type PolicyTaskType,
  type PolicyTemplate,
  type PortablePolicyTemplate,
  policySummary,
  portableTemplate,
  type Repo,
  resolvePolicy,
  TASK_TYPE_LABEL,
  type TaskPolicies,
  type TaskPolicy,
  validatePortableTemplate,
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
  const [selectedTemplate, setSelectedTemplate] = useState<PolicyTemplate | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ["policy-templates"],
    queryFn: () => api.get<PolicyTemplate[]>("/api/policy-templates"),
  });
  const saveTemplate = useMutation({
    mutationFn: () => api.post<PolicyTemplate>("/api/policy-templates", { name: templateName, policies: rules }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["policy-templates"] });
      setSelectedTemplate(row);
      setTemplateName(row.name);
      toast("Saved verification template.");
    },
  });
  const updateTemplate = useMutation({
    mutationFn: () =>
      api.patch<PolicyTemplate>(`/api/policy-templates/${selectedTemplate!.id}`, {
        name: templateName,
        policies: rules,
        expectedUpdatedAt: selectedTemplate!.updatedAt,
      }),
    onSuccess: (row) => {
      setSelectedTemplate(row);
      toast("Updated template. Repository routes remain unchanged until you save them.");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["policy-templates"] });
    },
  });
  const deleteTemplate = useMutation({
    mutationFn: () =>
      api.del(`/api/policy-templates/${selectedTemplate!.id}`, { expectedUpdatedAt: selectedTemplate!.updatedAt }),
    onSuccess: () => {
      setSelectedTemplate(null);
      setDeleteArmed(false);
      toast("Deleted template. Existing repository routes are unchanged.");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["policy-templates"] });
    },
  });
  const previewTemplate = (template: PolicyTemplate) => {
    setSelectedTemplate(template);
    setTemplateName(template.name);
    setRules(template.policies);
    setDeleteArmed(false);
    setImportError(null);
    updateTemplate.reset();
    deleteTemplate.reset();
    saveTemplate.reset();
  };
  const importTemplate = async (file: File) => {
    try {
      if (file.size > 65536) throw new Error("Choose a template smaller than 64 KB.");
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw new Error("The template file is not valid JSON.");
      }
      const error = validatePortableTemplate(value);
      if (error) throw new Error(error);
      const template = value as PortablePolicyTemplate;
      setSelectedTemplate(null);
      setDeleteArmed(false);
      setTemplateName(template.name.trim());
      setRules(template.policies);
      setImportError(null);
      updateTemplate.reset();
      deleteTemplate.reset();
      saveTemplate.reset();
      toast("Imported for preview. Save a template or repository routes to keep it.");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read the template.");
    }
  };
  const exportTemplate = () => {
    const value = portableTemplate(templateName.trim() || "Verification workflow", rules);
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "nightcrew-verification.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
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
  const templateBusy = saveTemplate.isPending || updateTemplate.isPending || deleteTemplate.isPending;
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
        <fieldset disabled={templateBusy || save.isPending} className="grid gap-2 rounded-xl bg-surface p-3">
          <label htmlFor={`template-${repo.id}`} className="text-[12px] text-muted">
            Reusable verification workflow
          </label>
          <Select
            id={`template-${repo.id}`}
            value={selectedTemplate?.id ?? ""}
            onChange={(e) => {
              const template = templates.data?.find((t) => t.id === e.target.value);
              if (template) previewTemplate(template);
              else setSelectedTemplate(null);
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
              aria-label="Verification template name"
              value={templateName}
              maxLength={100}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Name this verification workflow"
            />
            <Button disabled={!templateName.trim() || saveTemplate.isPending} onClick={() => saveTemplate.mutate()}>
              Save as template
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedTemplate && (
              <>
                <Button
                  disabled={!templateName.trim() || updateTemplate.isPending}
                  onClick={() => updateTemplate.mutate()}
                >
                  Update saved template
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const current = templates.data?.find((t) => t.id === selectedTemplate.id);
                    if (current) previewTemplate(current);
                  }}
                >
                  Reload saved version
                </Button>
                <Button variant="ghost" onClick={() => setDeleteArmed(!deleteArmed)}>
                  Delete template
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={exportTemplate}>
              Export preview
            </Button>
          </div>
          {deleteArmed && selectedTemplate && (
            <div className="grid gap-2 rounded-lg bg-bg p-3">
              <p className="text-[12px] text-muted">
                Delete “{selectedTemplate.name}” from the library? Repositories keep their copied routes.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" disabled={deleteTemplate.isPending} onClick={() => deleteTemplate.mutate()}>
                  Delete saved template
                </Button>
                <Button variant="ghost" onClick={() => setDeleteArmed(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <label className="grid gap-2 text-[12px] text-muted">
            Import verification template
            <input
              type="file"
              accept="application/json,.json"
              className="w-full min-w-0 text-[12px]"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importTemplate(file);
              }}
            />
          </label>
          <p className="text-[12px] text-muted">
            Exports contain a name and verification rules. Repository paths, commands, credentials and authority
            ceilings are excluded. Import previews rules; it does not dispatch work or change a repository.
          </p>
          {(saveTemplate.error || updateTemplate.error || deleteTemplate.error || templates.error || importError) && (
            <p role="alert" className="text-bad">
              {importError ??
                (updateTemplate.error ?? deleteTemplate.error ?? saveTemplate.error ?? templates.error)?.message}
            </p>
          )}
        </fieldset>
        <fieldset disabled={save.isPending || templateBusy} className="grid gap-3 disabled:opacity-60">
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
