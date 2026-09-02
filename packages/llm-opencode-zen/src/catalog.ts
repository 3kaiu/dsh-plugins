import { assertSafeBaseURL } from "./config.ts";
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_PROVIDER = "opencode";
const DEFAULT_CATALOG_REFRESH_MS = 3600000;
const CATALOG_ERROR_TTL_MS = 60000;

async function fetchJson(url: string, headers: any) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function toCatalogEntry(id: string, meta: any) {
  return {
    id,
    name: meta.name ?? id,
    ...(meta.description === void 0 ? {} : { description: meta.description }),
    ...(meta.limit?.context === void 0 ? {} : { contextWindow: meta.limit.context }),
    ...(meta.limit?.output === void 0 ? {} : { maxTokens: meta.limit.output }),
    reasoning: meta.reasoning !== false,
    deprecated: meta.status === "deprecated" || void 0,
  };
}

function orderCatalog(models: any[], preferredModel: any) {
  const indexed = models.map((model: any, index: number) => ({ model, index }));
  indexed.sort((a: any, b: any) => {
    if (a.model.id === preferredModel && b.model.id !== preferredModel) return -1;
    if (b.model.id === preferredModel && a.model.id !== preferredModel) return 1;
    if ((a.model.deprecated ?? false) !== (b.model.deprecated ?? false))
      return a.model.deprecated ? 1 : -1;
    return a.index - b.index;
  });
  return indexed.map((entry: any) => entry.model);
}

async function fetchFreeModels(baseURL: string, apiKey: string) {
  assertSafeBaseURL(baseURL); // 目录请求同样携带 Bearer key，使用点处校验
  const [live, meta] = await Promise.all([
    fetchJson(`${baseURL}/models`, { Authorization: `Bearer ${apiKey}` }),
    fetchJson(MODELS_DEV_URL, {}),
  ]);
  const servedIds = new Set((live?.data ?? []).map((entry: any) => entry?.id).filter(Boolean));
  const metas: Record<string, any> = meta?.[MODELS_DEV_PROVIDER]?.models ?? {};
  const models = Object.entries(metas)
    .filter(([id, m]) => servedIds.has(id) && Number(m?.cost?.input) === 0 && Number(m?.cost?.output) === 0)
    .map(([id, m]) => toCatalogEntry(id, m));
  if (models.length === 0) throw new Error(`no free models found for ${baseURL}`);
  return models;
}

const catalogCache = new Map();

function resetCatalogCache() {
  catalogCache.clear();
}

async function freeModelCatalog(baseURL: string, apiKey: string, refreshMs: number) {
  const now = Date.now();
  const hit = catalogCache.get(baseURL);
  if (hit !== void 0) {
    if (hit.pending !== void 0) return hit.pending;
    if (hit.expiresAt > now) {
      if (hit.error !== void 0) throw hit.error;
      return hit.models;
    }
  }
  const pending = (async () => {
    try {
      const models = await fetchFreeModels(baseURL, apiKey);
      catalogCache.set(baseURL, { expiresAt: Date.now() + refreshMs, models });
      return models;
    } catch (error) {
      catalogCache.set(baseURL, { expiresAt: Date.now() + CATALOG_ERROR_TTL_MS, error });
      throw error;
    }
  })();
  catalogCache.set(baseURL, { ...hit, pending });
  try {
    return await pending;
  } finally {
    const entry = catalogCache.get(baseURL);
    if (entry?.pending === pending) delete entry.pending;
  }
}

export {
  MODELS_DEV_URL,
  MODELS_DEV_PROVIDER,
  DEFAULT_CATALOG_REFRESH_MS,
  CATALOG_ERROR_TTL_MS,
  fetchJson,
  toCatalogEntry,
  orderCatalog,
  fetchFreeModels,
  catalogCache,
  resetCatalogCache,
  freeModelCatalog,
};
