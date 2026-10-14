import type { Mission } from "@nightcrew/core";
import { Field, Select, TextArea, TextInput } from "./form";

export interface MissionControlValues {
  criteria: string;
  budget: string;
  priority: number;
  deadline: string;
  stopAt: string;
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
}: {
  values: MissionControlValues;
  includeCriteria?: boolean;
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
          hint="Blank means no separate limit. Includes all attempts charged to this goal."
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
      </div>
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
      <Field
        label="Stop work at"
        htmlFor="mission-stop-at"
        hint={`Optional, in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Stops active agents and holds new tasks. Cleanup may continue. Pausing does not extend this time; active attempts keep their earliest stop time.`}
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
