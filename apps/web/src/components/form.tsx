import { clsx } from "clsx";
import { ChevronDown, Plus, X } from "lucide-react";
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useState,
} from "react";

const control =
  "w-full rounded-xl bg-bg px-3 py-2 text-[13.5px] text-fg outline-none ring-1 ring-line transition-shadow placeholder:text-faint focus:ring-[color-mix(in_srgb,var(--dawn)_60%,transparent)]";

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={htmlFor} className="font-medium text-[12.5px] text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, "h-9", props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(control, "resize-y leading-relaxed", props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select {...props} className={clsx(control, "h-9 appearance-none pr-8", props.className)}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint" />
    </div>
  );
}

/** Edit a list of short strings as chips (scope globs, protected branches). */
export function ChipsEditor({
  id,
  value,
  onChange,
  placeholder,
  mono = true,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  return (
    <div className={clsx(control, "flex min-h-9 flex-wrap items-center gap-1.5 py-1.5")}>
      {value.map((v) => (
        <span
          key={v}
          className={clsx(
            "inline-flex items-center gap-1 rounded-md bg-raised py-0.5 pr-1 pl-2 text-[12px]",
            mono && "font-mono",
          )}
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(value.filter((x) => x !== v))}
            className="rounded p-0.5 text-faint hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder={value.length ? "" : placeholder}
        className={clsx(
          "min-w-[8rem] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint",
          mono && "font-mono",
        )}
      />
    </div>
  );
}

/** Edit a checklist of sentences (acceptance criteria). */
export function ListEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (draft.trim()) onChange([...value, draft.trim()]);
    setDraft("");
  };
  return (
    <div className="grid gap-1.5">
      {value.map((v, i) => (
        // Position keys: keying on the text would remount the input on every keystroke.
        // biome-ignore lint/suspicious/noArrayIndexKey: items are edited in place, never reordered
        <div key={i} className="group flex items-start gap-2.5 rounded-lg px-1 py-1 hover:bg-raised/60">
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-dawn" />
          <input
            value={v}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
            onBlur={(e) => !e.target.value.trim() && onChange(value.filter((_, j) => j !== i))}
            aria-label={`Criterion ${i + 1}`}
            className="flex-1 bg-transparent text-[13.5px] outline-none"
          />
          <button
            type="button"
            aria-label="Remove"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="rounded p-0.5 text-faint opacity-0 hover:text-fg group-hover:opacity-100 focus:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2.5 px-1">
        <Plus className="size-3.5 shrink-0 text-faint" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={placeholder}
          className="flex-1 bg-transparent py-1 text-[13.5px] outline-none placeholder:text-faint"
        />
      </div>
    </div>
  );
}
