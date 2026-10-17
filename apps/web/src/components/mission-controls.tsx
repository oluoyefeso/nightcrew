import type { Mission } from "@nightcrew/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, settingsQuery, useInvalidateTasks } from "../api";
import { Field, Select, TextArea, TextInput } from "./form";
import { Button } from "./ui";

export interface MissionControlValues {
  criteria: string;
  budget: string;
  priority: number;
  deadline: string;
  stopAt: string;
}

export function GoalLimitsEditor({
  mission,
  onSaved,
  onCancel,
  continueInProject,
  showCrewBudget = false,
}: {
  mission: Mission;
  onSaved: () => void;
  onCancel: () => void;
  continueInProject?: string;
  showCrewBudget?: boolean;
}) {
  const [values, setValues] = useState(() => missionControlValues(mission));
  const settings = useQuery(settingsQuery);
  const [dailyBudget, setDailyBudget] = useState<string | null>(null);
  const invalidate = useInvalidateTasks();
  const save = useMutation({
    mutationFn: async () => {
      const { criteria: _criteria, ...limits } = missionControlPatch(values);
      await api.patch(`/api/missions/${mission.id}`, limits);
      if (showCrewBudget && dailyBudget !== null)
        await api.patch("/api/settings", { dailyTokenBudget: Number(dailyBudget) });
      if (continueInProject) await api.post(`/api/missions/${mission.id}/conductor`, { repoId: continueInProject });
    },
    onSuccess: () => {
      invalidate();
      void settings.refetch();
      onSaved();
    },
  });
  return (
    <form
      aria-label="Goal limits"
      className="grid gap-4 rounded-xl border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <MissionControls values={values} onChange={setValues} includeCriteria={false} simple />
      {showCrewBudget && settings.data && (
        <Field
          label="Daily crew token limit"
          htmlFor="goal-daily-budget"
          hint="Shared by every goal. Raising this allows more total spending across the crew."
        >
          <TextInput
            id="goal-daily-budget"
            type="number"
            min={100000}
            step={1000}
            value={dailyBudget ?? settings.data.dailyTokenBudget}
            onChange={(event) => setDailyBudget(event.target.value)}
          />
        </Field>
      )}
      {(values.deadline || values.priority > 0) && (
        <details>
          <summary className="cursor-pointer text-[12px] text-muted">Existing scheduling overrides</summary>
          <div className="mt-3 grid gap-3">
            {values.deadline && (
              <Field label="Latest task start" htmlFor="legacy-start-deadline">
                <TextInput
                  id="legacy-start-deadline"
                  type="datetime-local"
                  value={values.deadline}
                  onChange={(event) => setValues({ ...values, deadline: event.target.value })}
                />
              </Field>
            )}
            {values.priority > 0 && <p className="text-[12px] text-muted">Priority {values.priority} is preserved.</p>}
          </div>
        </details>
      )}
      <p className="text-[12px] text-muted">
        Limits count tokens, not dollars. Daily and task limits still apply when a goal limit is blank.
      </p>
      {save.error && (
        <p role="alert" className="text-[13px] text-bad">
          {save.error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : continueInProject ? "Save & continue" : "Save limits"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
export function missionControlValues(mission?: Mission): MissionControlValues {
  const stopAt = mission?.stopAt ? new Date(mission.stopAt) : null;
  const deadline = mission?.deadline ? new Date(mission.deadline) : null;
  return {
    criteria: mission?.criteria.join("\n") ?? "",
    budget: mission?.tokenBudget?.toString() ?? "",
    priority: mission?.priority ?? 0,
    stopAt: stopAt ? new Date(stopAt.getTime() - stopAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "",
    deadline: deadline
      ? new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "",
  };
}
export function missionControlPatch(values: MissionControlValues) {
  return {
    criteria: values.criteria
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean),
    tokenBudget: values.budget ? Number(values.budget) : null,
    priority: values.priority,
    stopAt: values.stopAt ? new Date(values.stopAt).toISOString() : null,
    deadline: values.deadline ? new Date(values.deadline).toISOString() : null,
  };
}
export function MissionControls({
  values,
  onChange,
  includeCriteria = true,
  simple = false,
}: {
  values: MissionControlValues;
  includeCriteria?: boolean;
  simple?: boolean;
  onChange: (values: MissionControlValues) => void;
}) {
  return (
    <>
      {includeCriteria && (
        <Field
          label="Success criteria (one per line)"
          htmlFor="mission-criteria"
          hint="Checkable outcomes that define success for the whole goal."
        >
          <TextArea
            id="mission-criteria"
            rows={4}
            value={values.criteria}
            maxLength={30030}
            onChange={(e) => onChange({ ...values, criteria: e.target.value })}
          />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Goal token limit"
          htmlFor="mission-budget"
          hint="Blank means no separate goal limit. Daily and per-task limits still apply. Includes all attempts charged to this goal."
        >
          <TextInput
            id="mission-budget"
            type="number"
            min={50000}
            step={1000}
            value={values.budget}
            onChange={(e) => onChange({ ...values, budget: e.target.value })}
          />
        </Field>
        {!simple && (
          <Field label="Dispatch priority" htmlFor="mission-priority">
            <Select
              id="mission-priority"
              value={values.priority}
              onChange={(e) => onChange({ ...values, priority: Number(e.target.value) })}
            >
              <option value={0}>Normal</option>
              <option value={1}>Raised</option>
              <option value={2}>High</option>
              <option value={3}>Urgent</option>
            </Select>
          </Field>
        )}
      </div>
      {!simple && (
        <Field
          label="Start deadline"
          htmlFor="mission-deadline"
          hint={`Optional, in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. New starts stop at this time; active work may finish.`}
        >
          <TextInput
            id="mission-deadline"
            type="datetime-local"
            value={values.deadline}
            onChange={(e) => onChange({ ...values, deadline: e.target.value })}
          />
        </Field>
      )}
      <Field
        label={simple ? "Deadline" : "Stop work at"}
        htmlFor="mission-stop-at"
        hint={`Optional, in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Stops work at this time. Cleanup may continue; extending it does not extend an already running attempt.`}
      >
        <TextInput
          id="mission-stop-at"
          type="datetime-local"
          value={values.stopAt}
          onChange={(e) => onChange({ ...values, stopAt: e.target.value })}
        />
      </Field>
    </>
  );
}
