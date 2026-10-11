import { Button } from "./ui";

export function MissionCriteriaLinks({
  criteria,
  selected,
  onChange,
}: {
  criteria: string[] | undefined;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  if (!criteria) return <p className="text-[12px] text-muted">Loading mission criteria…</p>;
  const stale = selected.filter((c) => !criteria.includes(c));
  return (
    <fieldset className="grid gap-2 rounded-xl bg-raised/40 p-3">
      <legend className="text-[12px] font-medium">Supports mission criteria</legend>
      <p className="text-[12px] text-muted">
        Link the outcomes this task is intended to support. These links plan the work; they do not prove acceptance.
      </p>
      {!criteria.length && (
        <p className="text-[12px] text-dawn">Set acceptance criteria on the mission to link this work.</p>
      )}
      {criteria.map((criterion) => (
        <label key={criterion} className="flex items-start gap-2 text-[12px]">
          <input
            type="checkbox"
            className="mt-1 accent-dawn"
            checked={selected.includes(criterion)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, criterion] : selected.filter((c) => c !== criterion))
            }
          />
          <span className="min-w-0 break-words">{criterion}</span>
        </label>
      ))}
      {!!stale.length && (
        <div className="grid gap-2 text-[12px] text-dawn">
          <p>These links no longer match the mission: {stale.join("; ")}</p>
          <div>
            <Button variant="ghost" onClick={() => onChange(selected.filter((c) => criteria.includes(c)))}>
              Remove outdated links
            </Button>
          </div>
        </div>
      )}
    </fieldset>
  );
}
