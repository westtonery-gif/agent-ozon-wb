import ozon from "./client";
import type { OzonSalesSummary } from "./mock";

// Реальная аналитика продаж через Ozon Seller API (/v1/analytics/data).
//
// ⚠️ НЕ ПРОТЕСТИРОВАНО на живых ключах (у разработчика мок-режим). Написано по
// документации; при первом живом запуске сверить названия метрик и структуру
// ответа — как и getProductsDetailed в products.ts.
//
// Реклама и ДРР здесь НЕ считаются: они в отдельном Performance API
// (api-performance.ozon.ru, свои client_id/client_secret + OAuth). Возвращаем null.

// Порядок метрик важен: totals[] в ответе идут в этом же порядке.
const METRICS = ["revenue", "ordered_units", "session_view"] as const;

interface AnalyticsResponse {
  result?: {
    data?: Array<{ dimensions?: unknown[]; metrics?: number[] }>;
    totals?: number[];
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Эндпоинт /v1/analytics/data у Ozon жёстко лимитирован (≈1 запрос в минуту,
// иначе 429). Кэшируем результат в памяти, чтобы повторные заходы на страницы
// и вызовы инструмента не спамили API.
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 минут
let cache: { at: number; periodDays: number; data: OzonSalesSummary } | null =
  null;

export async function getSalesSummaryLive(
  periodDays = 30
): Promise<OzonSalesSummary> {
  if (
    cache &&
    cache.periodDays === periodDays &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    return cache.data;
  }

  const dateTo = new Date();
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - periodDays);

  const response = await ozon.post("/v1/analytics/data", {
    date_from: isoDate(dateFrom),
    date_to: isoDate(dateTo),
    metrics: [...METRICS],
    dimension: ["day"],
    filters: [],
    sort: [],
    limit: 1000,
    offset: 0,
  });

  const data = response.data as AnalyticsResponse;
  // totals — агрегат по всем дням в порядке METRICS.
  const totals = data.result?.totals ?? [];
  const revenue = Number(totals[0] ?? 0);
  const orders = Number(totals[1] ?? 0);
  const sessions = Number(totals[2] ?? 0);

  const result: OzonSalesSummary = {
    period_days: periodDays,
    orders,
    revenue,
    avg_check: orders > 0 ? Math.round(revenue / orders) : 0,
    conversion:
      sessions > 0 ? Number(((orders / sessions) * 100).toFixed(1)) : 0,
    // 0 сессий — это не «ноль посетителей», а «аналитика их не вернула»: unknown.
    sessions: sessions > 0 ? sessions : null,
    ad_spend: null, // требует Performance API
    drr: null,
  };

  cache = { at: Date.now(), periodDays, data: result };
  return result;
}

// Заказы (ordered_units) по каждому SKU за период — чтобы заполнить orders_30d
// по товарам. /v1/analytics/data с разбивкой dimension: ["sku"].
interface SkuRow {
  dimensions?: Array<{ id?: string; name?: string }>;
  metrics?: number[];
}
interface SkuAnalyticsResponse {
  result?: { data?: SkuRow[] };
}

let ordersCache: {
  at: number;
  periodDays: number;
  data: Record<string, number>;
} | null = null;

export async function getOrdersBySku(
  periodDays = 30
): Promise<Record<string, number>> {
  if (
    ordersCache &&
    ordersCache.periodDays === periodDays &&
    Date.now() - ordersCache.at < CACHE_TTL_MS
  ) {
    return ordersCache.data;
  }

  const dateTo = new Date();
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - periodDays);

  // По страницам: одна страница — 1000 строк, то есть 1000 SKU. Раньше запрос
  // был один, и на кабинете в 3000 SKU у двух третей товаров заказы стали бы
  // нулём (их просто нет в ответе) — агент сказал бы «не продаётся» про товар,
  // который продаётся. Ложный вывод хуже пропуска.
  // Лимит аналитики — около запроса в минуту, поэтому большой кабинет
  // собирается несколько минут; результат кэшируется (CACHE_TTL_MS).
  const LIMIT = 1000;
  const map: Record<string, number> = {};
  for (let offset = 0; offset < LIMIT * 50; offset += LIMIT) {
    const response = await ozon.post("/v1/analytics/data", {
      date_from: isoDate(dateFrom),
      date_to: isoDate(dateTo),
      metrics: ["ordered_units"],
      dimension: ["sku"],
      filters: [],
      sort: [],
      limit: LIMIT,
      offset,
    });
    const data = response.data as SkuAnalyticsResponse;
    const rows = data.result?.data ?? [];
    for (const row of rows) {
      // dimensions[0].id — это SKU товара, metrics[0] — заказано штук.
      const sku = String(row.dimensions?.[0]?.id ?? "");
      const units = Number(row.metrics?.[0] ?? 0);
      if (sku) map[sku] = units;
    }
    if (rows.length < LIMIT) break;
  }

  ordersCache = { at: Date.now(), periodDays, data: map };
  return map;
}
