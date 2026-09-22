import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" },
  { id: "us.anthropic.claude-opus-5-5", label: "Bedrock Opus 5.5" },
  { id: "us.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
  { id: "us.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
  // Fable 5.1's documented geo inference ID carries no -v1 suffix, unlike earlier entries.
  { id: "us.anthropic.claude-fable-5-1", label: "Bedrock Fable 5.1" },
  { id: "us.anthropic.claude-fable-5", label: "Bedrock Fable 5" },
  { id: "us.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
  { id: "us.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

let cached: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

function fingerprint(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
  return `${apiKey.length}:${digest}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...DIRECT_MODELS,
  ]);
}

type AnthropicCredential = { value: string; kind: "api_key" | "bearer" };

// Subscription auth never sets ANTHROPIC_API_KEY, so discovery used to fall back to the static list.
// /v1/models accepts a Claude OAuth token as a Bearer credential (read-only metadata, no billing), so
// fall back to the subscription token: env first, then the server host's Claude CLI login. Nothing is
// copied into process.env, so run billing is untouched.
function readClaudeCliOauthToken(): string | null {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
    const raw = JSON.parse(readFileSync(path.join(configDir, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = raw?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
  } catch {
    return null;
  }
}

function resolveAnthropicApiKey(): AnthropicCredential | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey && apiKey.length > 0) return { value: apiKey, kind: "api_key" };
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
    const token = process.env[name]?.trim();
    if (token && token.length > 0) return { value: token, kind: "bearer" };
  }
  const cliToken = readClaudeCliOauthToken();
  return cliToken ? { value: cliToken, kind: "bearer" } : null;
}

function resolveAnthropicBaseUrl(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : "https://api.anthropic.com";
}

async function fetchAnthropicModels(apiKey: AnthropicCredential, baseUrl: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${ANTHROPIC_MODELS_ENDPOINT}`, {
      headers: {
        "anthropic-version": ANTHROPIC_API_VERSION,
        ...(apiKey.kind === "bearer"
          ? { Authorization: `Bearer ${apiKey.value}` }
          : { "x-api-key": apiKey.value }),
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; display_name?: unknown };
      if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
      const displayName =
        typeof record.display_name === "string" && record.display_name.trim().length > 0
          ? record.display_name
          : record.id;
      models.push({
        id: record.id,
        label: displayName,
      });
    }
    return dedupeModels(models);
  } catch (error) {
    console.warn("[paperclip] Claude model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadClaudeModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  if (isBedrockEnv()) return dedupeModels(BEDROCK_MODELS);

  const fallback = dedupeModels(DIRECT_MODELS);
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return fallback;

  const now = Date.now();
  const baseUrl = resolveAnthropicBaseUrl();
  const keyFingerprint = fingerprint(apiKey.value);
  if (
    options?.forceRefresh !== true &&
    cached &&
    cached.keyFingerprint === keyFingerprint &&
    cached.baseUrl === baseUrl &&
    cached.expiresAt > now
  ) {
    return cached.models;
  }

  const fetched = await fetchAnthropicModels(apiKey, baseUrl);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      baseUrl,
      expiresAt: now + ANTHROPIC_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.baseUrl === baseUrl && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels();
}

export async function refreshClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels({ forceRefresh: true });
}

export function resetClaudeModelsCacheForTests() {
  cached = null;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
