import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";
import { detectOpenCodeVersion } from "./version.js";

// Discovery probes the CLI version before listing (fork, MAG-469). Stub it so the
// runChildProcess call counts below only see `opencode models` invocations.
vi.mock("./version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version.js")>()),
  detectOpenCodeVersion: vi.fn(async () => null),
}));

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe(
      "openai/gpt-5.2-codex",
    );
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("proceeds with the configured model when discovery cannot run (probe is best-effort, never fatal)", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
      },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/gateway/some-model",
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/gateway/some-model",
        label: "anthropic/gateway/some-model",
      },
    ]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a variant-qualified catalog id for a v2 run with a configured variant", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "provider/model#thinking\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "provider/model",
        variant: "thinking",
        line: "v2",
      }),
    ).resolves.toContainEqual({
      id: "provider/model#thinking",
      label: "provider/model#thinking",
    });
  });

  it("still accepts the bare model id for a v2 run with a configured variant", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "acme/thinker\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "acme/thinker",
        variant: "thinking",
        line: "v2",
      }),
    ).resolves.toContainEqual({ id: "acme/thinker", label: "acme/thinker" });
  });

  it("does not accept a variant-qualified catalog id when the line is not v2", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "provider/model#thinking\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "provider/model",
        variant: "thinking",
      }),
    ).rejects.toThrow("Configured OpenCode model is unavailable: provider/model");
  });

  it("retries a transient `opencode models` failure with backoff before succeeding", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "queued behind another opencode run",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ollama/qwen2.5-coder:7b\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    const promise = discoverOpenCodeModels();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([
      { id: "ollama/qwen2.5-coder:7b", label: "ollama/qwen2.5-coder:7b" },
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("lists models with --standalone on v2 so discovery never spawns the shared service (fork, MAG-469)", async () => {
    vi.mocked(detectOpenCodeVersion).mockResolvedValueOnce({
      raw: "opencode v2.0.16",
      major: 2,
      minor: 0,
      patch: 16,
      line: "v2",
    } as Awaited<ReturnType<typeof detectOpenCodeVersion>>);
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "alibaba/qwen3-max\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(discoverOpenCodeModels()).resolves.toEqual([
      { id: "alibaba/qwen3-max", label: "alibaba/qwen3-max" },
    ]);
    expect(spy.mock.calls[0][2]).toEqual(["models", "--standalone"]);
  });

  describe("v2 --standalone empty-output fallback (fork, MAG-483)", () => {
    const v2 = {
      raw: "opencode v2.0.20",
      major: 2,
      minor: 0,
      patch: 20,
      line: "v2",
    } as Awaited<ReturnType<typeof detectOpenCodeVersion>>;
    const ok = (stdout: string) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    let stateHome = "";

    afterEach(async () => {
      if (stateHome) await fs.rm(stateHome, { recursive: true, force: true });
      stateHome = "";
    });

    async function writeService(service: Record<string, unknown>) {
      stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-state-"));
      await fs.mkdir(path.join(stateHome, "opencode"), { recursive: true });
      await fs.writeFile(path.join(stateHome, "opencode", "service.json"), JSON.stringify(service));
    }

    it("asks the running shared service with --server when --standalone lists nothing", async () => {
      await writeService({ url: "http://127.0.0.1:49374", pid: process.pid, password: "pw" });
      vi.mocked(detectOpenCodeVersion).mockResolvedValueOnce(v2);
      const spy = vi
        .spyOn(serverUtils, "runChildProcess")
        .mockResolvedValueOnce(ok(""))
        .mockResolvedValueOnce(ok("alibaba-token-plan/qwen3.8-flash\nopenai/gpt-5.5\n"));

      await expect(
        discoverOpenCodeModels({ env: { XDG_STATE_HOME: stateHome }, serviceFallback: true }),
      ).resolves.toEqual([
        { id: "alibaba-token-plan/qwen3.8-flash", label: "alibaba-token-plan/qwen3.8-flash" },
        { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
      ]);
      expect(spy.mock.calls[0][2]).toEqual(["models", "--standalone"]);
      expect(spy.mock.calls[1][2]).toEqual(["models", "--server", "http://127.0.0.1:49374"]);
      expect(spy.mock.calls[1][3].env.OPENCODE_SERVER_PASSWORD).toBe("pw");
    });

    it("asks again when the service's first answer from a new cwd is empty", async () => {
      await writeService({ url: "http://127.0.0.1:49374", pid: process.pid, password: "pw" });
      vi.mocked(detectOpenCodeVersion).mockResolvedValueOnce(v2);
      const spy = vi
        .spyOn(serverUtils, "runChildProcess")
        .mockResolvedValueOnce(ok(""))
        .mockResolvedValueOnce(ok(""))
        .mockResolvedValueOnce(ok("alibaba-token-plan/qwen3.8-flash\n"));

      await expect(
        discoverOpenCodeModels({ env: { XDG_STATE_HOME: stateHome }, serviceFallback: true }),
      ).resolves.toEqual([
        { id: "alibaba-token-plan/qwen3.8-flash", label: "alibaba-token-plan/qwen3.8-flash" },
      ]);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy.mock.calls[2][2]).toEqual(["models", "--server", "http://127.0.0.1:49374"]);
    });

    it("returns the empty list without spawning anything when no service is running", async () => {
      await writeService({ url: "http://127.0.0.1:49374", pid: 2 ** 22 + 12345, password: "pw" });
      vi.mocked(detectOpenCodeVersion).mockResolvedValueOnce(v2);
      const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValueOnce(ok(""));

      await expect(
        discoverOpenCodeModels({ env: { XDG_STATE_HOME: stateHome }, serviceFallback: true }),
      ).resolves.toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("never consults the shared service unless the caller opts in (run pre-flight)", async () => {
      await writeService({ url: "http://127.0.0.1:49374", pid: process.pid });
      vi.mocked(detectOpenCodeVersion).mockResolvedValueOnce(v2);
      const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValueOnce(ok(""));

      await expect(discoverOpenCodeModels({ env: { XDG_STATE_HOME: stateHome } })).resolves.toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("refreshes a stale non-empty catalog before rejecting the configured model", async () => {
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout:
          "openrouter/example/current-model\nopenrouter/deepseek/deepseek-v4-flash-0731\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).resolves.toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]?.[2]).toEqual(["models"]);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects when a refreshed non-empty catalog omits the configured model", async () => {
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/current-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow(
      "Configured OpenCode model is unavailable: openrouter/deepseek/deepseek-v4-flash-0731",
    );
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects from the original catalog when post-refresh enumeration returns no models", async () => {
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow("Available models: openrouter/example/stale-model");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects from the original catalog when refresh fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockRejectedValueOnce(new Error("refresh unavailable"));

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow("Available models: openrouter/example/stale-model");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'refresh failed for "openrouter/deepseek/deepseek-v4-flash-0731"',
      ),
    );
  });

  it("surfaces the last error once retries are exhausted", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "queued behind another opencode run",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const promise = discoverOpenCodeModels();
    const assertion = expect(promise).rejects.toThrow(
      "`opencode models` failed: queued behind another opencode run",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("parses v1-shaped `opencode models` output (one provider/model per line)", () => {
    const stdout = [
      "openai/gpt-5.2-codex",
      "ollama/qwen2.5-coder:7b",
      "anthropic/claude-opus-5",
      "openrouter/example/stale-model",
    ].join("\n");

    expect(parseOpenCodeModelsOutput(stdout)).toEqual([
      { id: "openai/gpt-5.2-codex", label: "openai/gpt-5.2-codex" },
      { id: "ollama/qwen2.5-coder:7b", label: "ollama/qwen2.5-coder:7b" },
      { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
      {
        id: "openrouter/example/stale-model",
        label: "openrouter/example/stale-model",
      },
    ]);
  });

  it("parses v2-shaped output and preserves `#variant` suffixes exactly", () => {
    const stdout = [
      "",
      "opencode-go/deepseek-v4-flash",
      "",
      "opencode-go/mimo-v2.6-pro#thinking",
      "cx/gpt-5.6#reasoning",
      "",
    ].join("\n");

    expect(parseOpenCodeModelsOutput(stdout)).toEqual([
      {
        id: "opencode-go/deepseek-v4-flash",
        label: "opencode-go/deepseek-v4-flash",
      },
      {
        id: "opencode-go/mimo-v2.6-pro#thinking",
        label: "opencode-go/mimo-v2.6-pro#thinking",
      },
      { id: "cx/gpt-5.6#reasoning", label: "cx/gpt-5.6#reasoning" },
    ]);
    expect(requireOpenCodeModelId("cx/gpt-5.6#reasoning")).toBe(
      "cx/gpt-5.6#reasoning",
    );
  });

  it("ignores blank lines, stray headers, usage text, URLs, and cache paths", () => {
    const stdout = [
      "",
      "Available models:",
      "PROVIDER/MODEL",
      "Usage: opencode models [options]",
      "https://opencode.ai/docs",
      "~/.cache/opencode/models.json",
      "Run `opencode auth login` to authenticate.",
      "",
      "openai/gpt-5.2-codex",
      "openai/gpt-5.2-codex",
      "",
    ].join("\n");

    expect(parseOpenCodeModelsOutput(stdout)).toEqual([
      { id: "openai/gpt-5.2-codex", label: "openai/gpt-5.2-codex" },
    ]);
  });

  it("degrades to a plain `opencode models` listing when the CLI rejects --refresh", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 2,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr:
          "Usage: opencode models [options]\nerror: unknown option '--refresh'\n",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout:
          "opencode-go/mimo-v2.6-pro#thinking\nopencode-go/deepseek-v4-flash\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(discoverOpenCodeModels({ refresh: true })).resolves.toEqual([
      {
        id: "opencode-go/deepseek-v4-flash",
        label: "opencode-go/deepseek-v4-flash",
      },
      {
        id: "opencode-go/mimo-v2.6-pro#thinking",
        label: "opencode-go/mimo-v2.6-pro#thinking",
      },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("--refresh"),
    );
  });

  it("still serves the configured model when a v2 CLI rejects --refresh (request does not fail)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Usage: opencode models [options]\n",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "cx/gpt-5.6\ncx/other-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "cx/gpt-5.6\ncx/other-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    const models = await ensureOpenCodeModelConfiguredAndAvailable({
      model: "cx/gpt-5.6",
    });
    expect(models).toContainEqual({ id: "cx/gpt-5.6", label: "cx/gpt-5.6" });
    expect(models.some((entry) => entry.id === "cx/cx/gpt-5.6")).toBe(false);
    expect(spy.mock.calls.map((call) => call[2])).toEqual([
      ["models"],
      ["models", "--refresh"],
      ["models"],
      ["models"],
    ]);
  });

  it("keeps a manually-entered provider/model id byte-for-byte through the module (#10742)", async () => {
    expect(requireOpenCodeModelId("cx/gpt-5.6")).toBe("cx/gpt-5.6");
    expect(parseOpenCodeModelsOutput("cx/gpt-5.6\n")).toEqual([
      { id: "cx/gpt-5.6", label: "cx/gpt-5.6" },
    ]);
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "cx/gpt-5.6\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const models = await ensureOpenCodeModelConfiguredAndAvailable({
      model: "cx/gpt-5.6",
    });
    expect(models.map((entry) => entry.id)).toEqual(["cx/gpt-5.6"]);
    expect(models.some((entry) => entry.id === "cx/cx/gpt-5.6")).toBe(false);
  });
});
