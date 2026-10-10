import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-b-2 border-line-strong bg-bg px-1 font-mono text-[10.5px] font-medium text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  kbd?: string;
};

export function Button({ variant = "secondary", size = "md", kbd, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={clsx(
        "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[background-color,color,transform,box-shadow] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
        size === "md" ? "h-8 px-3.5 text-[13px]" : "h-7 px-3 text-[12.5px]",
        variant === "primary" && "bg-dawn text-on-dawn hover:brightness-105",
        variant === "secondary" &&
          "bg-raised text-fg ring-1 ring-line ring-inset hover:bg-[color-mix(in_srgb,var(--raised)_80%,var(--fg)_6%)]",
        variant === "ghost" && "text-muted hover:bg-raised hover:text-fg",
        variant === "danger" &&
          "bg-raised text-bad ring-1 ring-line ring-inset hover:bg-[color-mix(in_srgb,var(--bad)_12%,var(--raised))]",
        className,
      )}
      {...rest}
    >
      {children}
      {kbd && (
        <Kbd
          className={clsx(
            variant === "primary" &&
              "border-[color-mix(in_srgb,var(--on-dawn)_25%,transparent)] bg-transparent text-on-dawn/70",
          )}
        >
          {kbd}
        </Kbd>
      )}
    </button>
  );
}

export function Pill({ color, children, className }: { color: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px] font-medium",
        className,
      )}
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex max-w-full items-center gap-1 truncate rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-fg",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <clipPath id="nc-mark">
          <circle cx="16" cy="16" r="15" />
        </clipPath>
      </defs>
      <g clipPath="url(#nc-mark)">
        <rect width="32" height="32" fill="var(--horizon-from)" />
        <rect y="17" width="32" height="15" fill="var(--dawn)" />
      </g>
      <circle cx="16" cy="16" r="15" fill="none" stroke="var(--line-strong)" />
    </svg>
  );
}
