import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "@nightcrew/core";
import { git, resolveSha, withRepoLock } from "./git";
import type { OperationContext } from "./operation-progress";
import { runCheck } from "./sandbox";

export function redactOperationLog(text: string, secrets: string[] = []): string {
  let clean = text;
  for (const secret of [...secrets, homedir()].filter(Boolean).sort((a, b) => b.length - a.length))
    clean = clean.split(secret).join("[redacted]");
  return clean
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})/g, "[redacted]")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .slice(-8000);
}

/** Commands run against an isolated, pinned checkout, never the user's working directory. */
export async function checkedCommand(
  repo: Repo,
  sha: string,
  command: string,
  dataDir: string,
  env: Record<string, string> = {},
  guard?: () => Promise<boolean>,
  op?: OperationContext,
) {
  const signal = op?.signal;
  op?.progress("waiting", repo.id);
  return withRepoLock(
    repo.path,
    async () => {
      if (signal?.aborted) return { ok: false, detail: "Stopped before the action." };
      if (guard && !(await guard()))
        return {
          ok: false,
          detail: "Repository settings or branch changed before the action. Run verification again.",
        };
      op?.progress("preparing", repo.id);
      const dir = join(dataDir, "operations", crypto.randomUUID());
      mkdirSync(join(dataDir, "operations"), { recursive: true });
      const add = await git(repo.path, "worktree", "add", "--detach", dir, sha);
      if (!add.ok) return { ok: false, detail: "Could not prepare the verification checkout." };
      try {
        if (repo.setupCommand) {
          op?.progress("setup", repo.id);
          const setup = await runCheck(repo.setupCommand, dir, {
            timeoutMs: 10 * 60_000,
            signal,
            env: Object.fromEntries(Object.keys(env).map((name) => [name, ""])),
          });
          if (!setup.ok)
            return {
              ok: false,
              detail: redactOperationLog(
                `Repository setup failed.\n${setup.stdout}\n${setup.stderr}\nExit ${setup.code}.`,
                Object.values(env),
              ),
            };
        }
        if ((await resolveSha(dir, "HEAD")) !== sha || !(await git(dir, "diff", "--quiet", "HEAD", "--")).ok)
          return { ok: false, detail: "Setup changed tracked files; configure setup to preserve the pinned commit." };
        if (guard && !(await guard()))
          return { ok: false, detail: "Repository settings or branch changed during setup. Run verification again." };
        if (signal?.aborted) return { ok: false, detail: "Stopped before the command." };
        op?.progress("command", repo.id);
        const result = await runCheck(command, dir, {
          timeoutMs: 15 * 60_000,
          signal,
          env: { ...env, NC_COMMIT: sha },
        });
        const intact = (await resolveSha(dir, "HEAD")) === sha && (await git(dir, "diff", "--quiet", "HEAD", "--")).ok;
        return {
          ok: result.ok && intact,
          detail: redactOperationLog(
            `${result.stdout}\n${result.stderr}\nExit ${result.code}.${intact ? "" : " Tracked source changed during verification."}`,
            Object.values(env),
          ),
        };
      } finally {
        op?.progress("finalizing", repo.id);
        await git(repo.path, "worktree", "remove", "--force", dir);
      }
    },
    signal,
  );
}
