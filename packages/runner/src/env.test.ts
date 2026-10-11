import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, dashboardPort, isSecretVar } from "./env";
import { git, run } from "./git";
import { checkEnv } from "./sandbox";
import { agentEnv } from "./sdk-engine";

const SECRETS = {
  GITHUB_ENTERPRISE_TOKEN: "x",
  OPENAI_API_KEY: "x",
  DATABASE_URL: "postgres://u:p@h/db",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  NPM_CONFIG__AUTH: "x",
  npm_config__auth: "x",
  AWS_ACCESS_KEY_ID: "x",
  AWS_SECRET_ACCESS_KEY: "x",
  AWS_SESSION_TOKEN: "x",
  AZURE_CLIENT_SECRET: "x",
  SLACK_BOT_TOKEN: "x",
  STRIPE_APIKEY: "x",
  DEPLOY_PRIVATE_KEY: "x",
  PGPASSWORD: "x",
  GIT_ASKPASS: "/bin/echo",
  GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
};
const CONFIG = {
  AWS_REGION: "eu-west-1",
  AWS_PROFILE: "dev",
  AWS_ENDPOINT_URL: "http://localhost:4566",
  GIT_AUTHOR_NAME: "t",
  NC_KEEP_ME: "yes",
};
const SIGN_IN = { ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "oauth" };

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, SECRETS, CONFIG, SIGN_IN);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("one environment policy", () => {
  // Value: protects=credentials from the agent's shell and the repo's own commands, with one list for both; fails_when=the two lists drift (checks kept GITHUB_ENTERPRISE_TOKEN), a secret-shaped name gets through, config like AWS_REGION is stripped, or the agent loses its sign-in; why_new=agentEnv and checkEnv had separate lists; seam=none
  test("strips credentials from both, keeps config, and only the agent keeps its sign-in", () => {
    const agent = agentEnv(process.env);
    const check = checkEnv();
    for (const env of [agent, check]) {
      for (const k of Object.keys(SECRETS)) expect(env[k]).toBeUndefined();
      expect(env).toMatchObject(CONFIG);
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    }
    expect(agent).toMatchObject(SIGN_IN);
    expect(check.ANTHROPIC_API_KEY).toBeUndefined();
    expect(check.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // An inherited GIT_DIR would aim the child's git at another repo.
    expect(childEnv({ GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x" }, { agent: true }).GIT_DIR).toBeUndefined();
  });

  // Value: protects=DSNs, signing keys, PATs, database passwords and connection URLs from children; fails_when=a name ending _KEY, _DSN, _PAT or _PWD, a CONNECTION_STRING or a database or queue URL gets through, or PWD, PATH and config like AWS_REGION are stripped; why_new=F4, the pattern missed these; seam=none
  test("strips keys, DSNs, PATs, database passwords and connection URLs, keeps config", () => {
    for (const k of [
      "SENTRY_DSN",
      "REDIS_URL",
      "SIGNING_KEY",
      "STRIPE_KEY",
      "MYSQL_PWD",
      "GITHUB_PAT",
      "DATABASE_URL",
      "DB_URI",
      "MONGODB_URI",
      "AMQP_URL",
      "AZURE_STORAGE_CONNECTION_STRING",
    ])
      expect(isSecretVar(k)).toBe(true);
    for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION", "NODE_ENV", "PATH", "PWD", "OLDPWD", "NODE_PATH", "API_URL"])
      expect(isSecretVar(k)).toBe(false);
    const env = childEnv(
      { SENTRY_DSN: "https://k@sentry.io/1", REDIS_URL: "redis://:p@h", NODE_ENV: "test" },
      { agent: true },
    );
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.NODE_ENV).toBe("test");
  });

  // Value: protects=pushes and keychain or gh credential helpers from the agent and from checks; fails_when=either env lacks the push block or the credential.helper reset, or the reset doesn't outrank a repo's own helper; why_new=checks had no push block and neither side reset credential helpers; seam=none
  test("both block pushes and every credential helper", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nc-env-")));
    try {
      const repo = join(root, "repo");
      await git(root, "init", "-q", repo);
      await git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
      // A helper in the repo's own config would hand out a password.
      await git(repo, "config", "credential.helper", "!f() { echo username=u; echo password=LEAKED; }; f");
      const isolated = { HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
      for (const env of [agentEnv(process.env) as Record<string, string>, checkEnv()]) {
        const e = { ...env, ...isolated };
        const push = await run(["git", "remote", "get-url", "--push", "origin"], repo, { baseEnv: e });
        expect(push.stdout.trim()).toBe("nightcrew-blocked://blocked");
        const helpers = await run(["git", "config", "--get-all", "credential.helper"], repo, { baseEnv: e });
        expect(helpers.stdout.split("\n").at(-2)).toBe("");
        const fill = Bun.spawnSync(["git", "credential", "fill"], {
          cwd: repo,
          env: e,
          stdin: new TextEncoder().encode("protocol=https\nhost=github.com\n\n"),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(fill.stdout.toString()).not.toContain("LEAKED");
        expect(fill.exitCode).not.toBe(0);
      }
      // Without the block the same helper answers, so the check above means something.
      const plain = Bun.spawnSync(["git", "credential", "fill"], {
        cwd: repo,
        env: { PATH: process.env.PATH ?? "", ...isolated, GIT_TERMINAL_PROMPT: "0" },
        stdin: new TextEncoder().encode("protocol=https\nhost=github.com\n\n"),
        stdout: "pipe",
      });
      expect(plain.stdout.toString()).toContain("password=LEAKED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Value: protects=git config already in the environment and a caller's own GIT_CONFIG_* entries; fails_when=the block overwrites entries instead of appending after them; why_new=checkEnv gained the block; seam=none
  test("the block appends after existing git config entries", () => {
    const env = childEnv(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" },
      { agent: false },
    );
    expect(env.GIT_CONFIG_KEY_0).toBe("core.pager");
    expect(env.GIT_CONFIG_KEY_1).toBe("url.nightcrew-blocked://.pushInsteadOf");
    const extra = checkEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    });
    expect(extra.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    const keys = Object.entries(extra)
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .map(([, v]) => v);
    expect(keys).toContain("credential.helper");
    expect(Number(extra.GIT_CONFIG_COUNT)).toBe(keys.length);
  });
});

test("dashboardPort reads a valid port and ignores anything else", () => {
  // Value: protects=the sandboxes' API port deny gets a real port or none, never a broken rule; fails_when=dashboardPort accepts junk or drops a valid port; why_new=Y2; seam=none
  expect(dashboardPort({ NIGHTCREW_API_PORT: "4321" })).toBe(4321);
  for (const v of [undefined, "", "0", "65536", "12.5", "80; (allow default)"])
    expect(dashboardPort({ NIGHTCREW_API_PORT: v })).toBeUndefined();
});
