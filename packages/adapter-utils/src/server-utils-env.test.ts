import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
  stripServerOnlyEnv,
} from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("stripServerOnlyEnv", () => {
  it("drops keys carrying the server's value and keeps operator-configured ones", () => {
    const server = {
      PAPERCLIP_AGENT_JWT_SECRET: "server-secret",
      DATABASE_URL: "postgres://server",
      PAPERCLIP_HOME: "/srv/paperclip",
    };
    expect(stripServerOnlyEnv({
      PAPERCLIP_AGENT_JWT_SECRET: "server-secret",
      DATABASE_URL: "postgres://agent-project",
      PAPERCLIP_HOME: "/srv/paperclip",
      PAPERCLIP_API_KEY: "run-token",
    }, server)).toEqual({
      DATABASE_URL: "postgres://agent-project",
      PAPERCLIP_API_KEY: "run-token",
    });
  });
});

describe("runChildProcess child env", () => {
  const DUMMY = {
    PAPERCLIP_AGENT_JWT_SECRET: "dummy-agent-jwt-secret",
    DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:5432/dummy",
  };
  const saved: Record<string, string | undefined> = {};
  const reportKeys = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(
    [...Object.keys(DUMMY), "PAPERCLIP_API_KEY"],
  )}.map((k) => [k, k in process.env]))))`;

  beforeEach(() => {
    for (const [key, value] of Object.entries(DUMMY)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function childKeys(env: Record<string, string>) {
    const result = await runChildProcess("env-test", process.execPath, ["-e", reportKeys], {
      cwd: process.cwd(),
      env,
      timeoutSec: 30,
      graceSec: 1,
      onLog: async () => undefined,
    });
    return JSON.parse(result.stdout);
  }

  it("keeps server secrets inherited through process.env out of the child", async () => {
    expect(await childKeys({ PAPERCLIP_API_KEY: "run-token" })).toEqual({
      PAPERCLIP_AGENT_JWT_SECRET: false,
      DATABASE_URL: false,
      PAPERCLIP_API_KEY: true,
    });
  });

  it("keeps server secrets out when an adapter re-spreads process.env into opts.env", async () => {
    const env = { ...(process.env as Record<string, string>), PAPERCLIP_API_KEY: "run-token" };
    expect(await childKeys(env)).toEqual({
      PAPERCLIP_AGENT_JWT_SECRET: false,
      DATABASE_URL: false,
      PAPERCLIP_API_KEY: true,
    });
  });
});
