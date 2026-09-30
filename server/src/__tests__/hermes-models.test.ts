import { beforeEach, describe, expect, it, vi } from "vitest";

const detectModel = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/hermes-paperclip-adapter/server", () => ({ detectModel }));

import { listHermesModels, refreshHermesModels, resetHermesModelsCacheForTests } from "../adapters/hermes-models.js";

describe("hermes_local model listing", () => {
  beforeEach(() => {
    resetHermesModelsCacheForTests();
    detectModel.mockReset();
    vi.restoreAllMocks();
  });

  it("returns an empty list when there is no Hermes config", async () => {
    detectModel.mockResolvedValue(null);
    expect(await listHermesModels()).toEqual([]);
  });

  it("lists the configured default model when base_url rejects unauthenticated /models", async () => {
    detectModel.mockResolvedValue({
      model: "qwen3.8-flash",
      provider: "alibaba-token-plan",
      baseUrl: "https://token-plan.example/compatible-mode/v1",
      hasApiKey: false,
      apiMode: "chat_completions",
      source: "config",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));

    expect(await listHermesModels()).toEqual([
      { id: "qwen3.8-flash", label: "qwen3.8-flash (alibaba-token-plan, Hermes default)" },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith("https://token-plan.example/compatible-mode/v1/models", expect.anything());
  });

  it("appends an unauthenticated /models catalogue after the default model", async () => {
    detectModel.mockResolvedValue({
      model: "llama-3",
      provider: "",
      baseUrl: "http://127.0.0.1:1234/v1/",
      hasApiKey: false,
      apiMode: "",
      source: "config",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ data: [{ id: "qwen-2" }, { id: "llama-3" }, { id: "" }] }),
    );

    expect(await listHermesModels()).toEqual([
      { id: "llama-3", label: "llama-3 (Hermes default)" },
      { id: "qwen-2", label: "qwen-2" },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:1234/v1/models", expect.anything());

    await listHermesModels();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await refreshHermesModels();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("skips the fetch when Hermes has no base_url", async () => {
    detectModel.mockResolvedValue({
      model: "claude-opus-5-5",
      provider: "anthropic",
      baseUrl: "",
      hasApiKey: false,
      apiMode: "",
      source: "config",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await listHermesModels()).toEqual([
      { id: "claude-opus-5-5", label: "claude-opus-5-5 (anthropic, Hermes default)" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
