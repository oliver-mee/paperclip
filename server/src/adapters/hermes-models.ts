import type { AdapterModel } from "./types.js";
import { detectModel } from "@paperclipai/hermes-paperclip-adapter/server";

const MODELS_TIMEOUT_MS = 5000;
const MODELS_CACHE_TTL_MS = 60_000;

let cached: { key: string; expiresAt: number; models: AdapterModel[] } | null = null;

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

/**
 * List an OpenAI-compatible `/models` endpoint without credentials (from
 * upstream PR #3035). This works for local servers such as LM Studio or
 * Ollama; hosted providers answer 401 and return null.
 */
async function fetchModels(baseUrl: string): Promise<AdapterModel[] | null> {
  const endpoint = baseUrl.replace(/\/+$/, "") + "/models";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return null;

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      models.push({ id, label: id });
    }
    return dedupeModels(models).sort((a, b) =>
      a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Models for hermes_local: the default model from `~/.hermes/config.yaml`
 * first (the one runs resolve a provider for without extra config), then
 * whatever the configured base_url lists when it answers unauthenticated.
 */
async function loadHermesModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const detected = await detectModel().catch(() => null);
  if (!detected) return [];

  const configured: AdapterModel[] = [{
    id: detected.model,
    label: detected.provider ? `${detected.model} (${detected.provider}, Hermes default)` : `${detected.model} (Hermes default)`,
  }];
  if (!detected.baseUrl) return configured;

  const key = `${detected.model}|${detected.baseUrl}`;
  const now = Date.now();
  if (!options?.forceRefresh && cached && cached.key === key && cached.expiresAt > now) {
    return cached.models;
  }

  const fetched = await fetchModels(detected.baseUrl);
  if (fetched === null && cached && cached.key === key) return cached.models;

  const models = dedupeModels([...configured, ...(fetched ?? [])]);
  cached = { key, expiresAt: now + MODELS_CACHE_TTL_MS, models };
  return models;
}

export async function listHermesModels(): Promise<AdapterModel[]> {
  return loadHermesModels();
}

export async function refreshHermesModels(): Promise<AdapterModel[]> {
  return loadHermesModels({ forceRefresh: true });
}

export function resetHermesModelsCacheForTests(): void {
  cached = null;
}
