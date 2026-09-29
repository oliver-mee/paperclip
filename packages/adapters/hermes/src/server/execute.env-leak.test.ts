/**
 * Regression test: the hermes adapter builds its child env from
 * `...process.env`, so server-only secrets loaded into the server process
 * (agent JWT signing secret, DATABASE_URL) must still be absent from the
 * spawned child. Captures the adapter's real opts.env, then runs it through
 * the real runChildProcess into a child that reports which keys it received.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const DUMMY = {
  PAPERCLIP_AGENT_JWT_SECRET: "dummy-agent-jwt-secret",
  DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:5432/dummy",
};
const REPORT_KEYS = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(
  [...Object.keys(DUMMY), "PAPERCLIP_RUN_ID"],
)}.map((k) => [k, k in process.env]))))`;

describe("hermes-local child env", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("does not pass server-only secrets to the spawned hermes process", async () => {
    await execute({
      runId: "env-leak-run",
      agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5 },
      context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
    } as any);

    const opts = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![3];
    // The adapter itself still re-spreads process.env; the guard must hold anyway.
    expect(opts.env.PAPERCLIP_AGENT_JWT_SECRET).toBe(DUMMY.PAPERCLIP_AGENT_JWT_SECRET);

    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
      "@paperclipai/adapter-utils/server-utils",
    );
    const result = await actual.runChildProcess("env-leak-run", process.execPath, ["-e", REPORT_KEYS], {
      ...opts,
      cwd: process.cwd(),
      onLog: async () => undefined,
      onSpawn: undefined,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      PAPERCLIP_AGENT_JWT_SECRET: false,
      DATABASE_URL: false,
      PAPERCLIP_RUN_ID: true,
    });
  });
});
