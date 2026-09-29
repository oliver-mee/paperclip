import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverOpenCodeModels, resetOpenCodeModelsCacheForTests } from "./models.js";

// `opencode models` discovery builds its child env from `...process.env`.
// Server-only secrets loaded into the server process must not reach it.
const DUMMY = {
  PAPERCLIP_AGENT_JWT_SECRET: "dummy-agent-jwt-secret",
  DATABASE_URL: "postgres://dummy:dummy@127.0.0.1:5432/dummy",
};

describe("opencode model discovery child env", () => {
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-leak-"));
    for (const [key, value] of Object.entries(DUMMY)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetOpenCodeModelsCacheForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not pass server-only secrets to the opencode process", async () => {
    const fake = path.join(dir, "opencode");
    await fs.writeFile(
      fake,
      [
        "#!/bin/sh",
        'jwt=no; [ -n "${PAPERCLIP_AGENT_JWT_SECRET+x}" ] && jwt=yes',
        'db=no; [ -n "${DATABASE_URL+x}" ] && db=yes',
        'echo "probe/jwt-$jwt-db-$db"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const models = await discoverOpenCodeModels({ command: fake, cwd: dir, env: {} });
    expect(models.map((m) => m.id)).toEqual(["probe/jwt-no-db-no"]);
  });
});
