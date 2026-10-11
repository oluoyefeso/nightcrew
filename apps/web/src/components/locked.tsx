import { BrandMark } from "./ui";

/** What a tab without this launch's key sees: NightCrew's look, and how to get back in. */
export function LockedPage() {
  const code =
    "inline-block max-w-full rounded-md bg-raised px-1.5 py-0.5 align-baseline font-mono text-[0.86em] text-fg leading-[1.4] tracking-normal [overflow-wrap:anywhere]";
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-8 text-fg">
      <main className="w-full max-w-[34rem]">
        <div className="mb-12 flex items-center gap-2.5 font-medium text-[15px] tracking-[-0.02em]">
          <BrandMark className="size-[22px] flex-none" />
          NightCrew
        </div>
        <h1 className="mb-4 text-balance font-medium text-[clamp(30px,6vw,40px)] leading-[1.12] tracking-[-0.03em]">
          This dashboard needs its launch link.
        </h1>
        <p className="mb-3 text-[16px] text-muted leading-[1.6]">
          Each time <code className={code}>nightcrew</code> starts it prints a link like{" "}
          <code className={code}>http://{location.host}/?t=…</code>; open that one.
        </p>
        <p className="mb-3 text-[16px] text-muted leading-[1.6]">
          Lost it, or restarted? Run <code className={code}>nightcrew</code> again and use the new link.
        </p>
      </main>
    </div>
  );
}
