import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, getRun, getTask, listRepos, listTasks, openDb } from "@nightcrew/db";

let root: string;
let data: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nc-cli-"));
  data = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A git repo with one commit, at root/<name>. */
function gitRepo(name: string) {
  const path = join(root, name);
  mkdirSync(path);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: path });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return path;
}

/** The real CLI, with the pretend crew and a temp data folder. */
async function nightcrew(cwd: string, ...args: string[]) {
  return invoke(cwd, [...args, "--data", data]);
}

async function invoke(cwd: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args, "--demo"], {
    cwd,
    env: { ...process.env, NIGHTCREW_DEMO_STEP_MS: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("relative data directories", () => {
  test.each(["flag", "environment"])("runs a task using a relative %s path", async (source) => {
    const repo = gitRepo("project");
    const relativeData = "nested data/crew";
    const args = source === "flag" ? ["--data", relativeData] : [];
    const env: Record<string, string> = source === "environment" ? { NIGHTCREW_HOME: relativeData } : {};
    expect((await invoke(root, ["repo", "add", repo, ...args], env)).code).toBe(0);
    const db = openDb(join(root, relativeData, "nightcrew.db"));
    try {
      const registered = listRepos(db)[0]!;
      const task = createTask(db, {
        repoId: registered.id,
        title: "Inspect the example repository",
        type: "research",
        status: "queued",
      });
      const result = await invoke(root, ["run", ...args], env);
      expect(result.code).toBe(0);
      const runId = getTask(db, task.id)?.lastRunId;
      expect(runId).toBeTruthy();
      const resultRun = getRun(db, runId!);
      expect(resultRun?.run.status).toBe("complete");
      expect(resultRun?.artifacts.find((artifact) => artifact.kind === "report")?.content).toContain("Demo report");
      expect(existsSync(join(root, relativeData, "work", registered.id, task.id, ".git"))).toBe(true);
      expect(existsSync(join(root, relativeData, "runs", runId!, "REPORT.md"))).toBe(true);
    } finally {
      db.$client.close();
    }
  });
});

test("the real CLI loads private credentials and startup defaults without exposing key values", async () => {
  const secret = "synthetic-credential-for-cli-test";
  const file = join(root, "private.env");
  writeFileSync(
    file,
    `OPENROUTER_API_KEY=${secret}\nNIGHTCREW_HOME=private-data\nNIGHTCREW_PORT=0\nNIGHTCREW_DEMO=1\n`,
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_API_KEY: "" };
  for (const name of ["OPENROUTER_API_KEY", "NIGHTCREW_HOME", "NIGHTCREW_PORT", "NIGHTCREW_DEMO", "NIGHTCREW_DEV"])
    delete env[name];
  const proc = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "main.ts"),
      "serve",
      "--env-file",
      file,
      "--offline",
      "--no-open",
      "--no-publish",
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const stderr = new Response(proc.stderr).text();
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const launch = await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("The fixture server exited before startup.");
          output += decoder.decode(chunk.value, { stream: true });
          const match = output.match(/http:\/\/localhost:(\d+)\/\?t=([a-f0-9]{64})/);
          if (match) return { base: `http://localhost:${match[1]}`, token: match[2]! };
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The fixture server did not start.")), 10_000);
      }),
    ]);
    expect(existsSync(join(root, "private-data", "nightcrew.db"))).toBe(true);
    expect((await fetch(`${launch.base}/api/connections`)).status).toBe(401);
    const headers = { "x-nightcrew-token": launch.token, "content-type": "application/json" };
    const created = await fetch(`${launch.base}/api/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "",
        apiKeyEnv: "OPENROUTER_API_KEY",
      }),
    });
    expect(created.status).toBe(201);
    const profile = await created.text();
    expect(JSON.parse(profile)).toMatchObject({ credentialConfigured: true, apiKeyEnv: "OPENROUTER_API_KEY" });
    expect(profile).not.toContain(secret);
    const listed = await fetch(`${launch.base}/api/connections`, { headers }).then((r) => r.text());
    expect(listed).not.toContain(secret);
    expect(JSON.parse(listed)).toHaveLength(1);
    expect(output).not.toContain(secret);
  } finally {
    clearTimeout(timer);
    proc.kill();
    await proc.exited;
    await reader.cancel();
    expect(await stderr).not.toContain(secret);
  }
}, 15_000);

describe("nightcrew add", () => {
  test("managed mode is coming soon and exits before creating local data", async () => {
    const result = await nightcrew(root, "--engine", "managed");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Managed mode is coming soon");
    expect(existsSync(data)).toBe(false);
  });

  // Value: protects=`nightcrew add` never registers the folder it runs in, refuses with which repos to pick when it can't tell, and queues the drafted task otherwise;
  // fails_when=add falls back to registering cwd as a repo, or picks the first repo when two are known and cwd is neither; why_new=main.ts had no test;
  // seam=none; no_claim=drafting quality (the --demo crew drafts one task offline; spawned CLI against a temp --data folder)
  test("never registers a repo, and refuses when it can't tell which one", async () => {
    const plain = gitRepo("plain");
    const one = gitRepo("one");
    const two = gitRepo("two");
    const ask = "fix the flaky login test";

    const none = await nightcrew(plain, "add", ask);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("Add a repo first: nightcrew repo add <path>");

    expect((await nightcrew(one, "repo", "add")).code).toBe(0);
    // The only repo there is takes the task, even from a folder it doesn't know.
    const only = await nightcrew(plain, "add", ask);
    expect(only.code).toBe(0);

    expect((await nightcrew(two, "repo", "add")).code).toBe(0);
    const which = await nightcrew(plain, "add", ask);
    expect(which.code).toBe(1);
    expect(which.stderr).toContain("Which repo? Run this inside one of: one, two, or pass --repo <path>.");
    const unknown = await nightcrew(one, "add", ask, "--repo", plain);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(`${plain} isn't a repo the crew knows. Add it with: nightcrew repo add ${plain}`);

    const inTwo = await nightcrew(two, "add", ask);
    expect(inTwo.code).toBe(0);

    const db = openDb(join(data, "nightcrew.db"));
    expect(
      listRepos(db)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["one", "two"]);
    // Which repo a draft lands in is the composer's call (the demo crew always names the first repo listed).
    expect(listTasks(db).map((t) => [t.status, t.source])).toEqual([
      ["queued", "cli"],
      ["queued", "cli"],
    ]);
  }, 30_000);
});
