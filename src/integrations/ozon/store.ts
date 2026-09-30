// Единый слой доступа к данным магазина: решает мок ↔ живой Ozon.
// Используется и инструментами агента (src/agents/tools.ts), и страницами
// Товары/Продажи/Финансы (Server Components), чтобы логика была одна.

import { getProductsDetailed } from "./products";
import { getSalesSummaryLive } from "./analytics";
import {
  MOCK_PRODUCTS,
  MOCK_SALES,
  cardContent,
  type CardContent,
  type OzonProduct,
  type OzonSalesSummary,
} from "./mock";
import { dailySeries, type DailyPoint } from "./mock-timeseries";
import { supplyInputs, type SupplyInputs } from "./mock-clusters";
import { marketFor, type Competitor } from "./mock-market";
import { reviewsFor, type Review } from "./mock-reviews";

// Мок включается, если явно задан OZON_MOCK=true,
// либо если реальные ключи Ozon не заданы (например, на машине разработчика).
export function isMock(): boolean {
  const flag = process.env.OZON_MOCK?.toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return !process.env.OZON_CLIENT_ID || !process.env.OZON_API_KEY;
}

export async function getProducts(): Promise<OzonProduct[]> {
  if (isMock()) return MOCK_PRODUCTS;
  return getProductsDetailed();
}

export async function getSalesSummary(): Promise<OzonSalesSummary> {
  if (isMock()) return MOCK_SALES;
  // Живой режим: продажи из Seller API. Реклама/ДРР пока null (нужен Performance API).
  return getSalesSummaryLive();
}

// Дневной ряд по товару за период. Нужен режиму «Диагностика падения продаж»:
// без истории нельзя сказать ни насколько упало, ни с какого дня.
//
// В живом режиме собирается не из одного вызова: заказы/выручка/сессии есть в
// /v1/analytics/data с dimension ["sku","day"], а истории остатка, цены и
// позиции Seller API не отдаёт вовсе — их нужно снимать самим в свою базу.
// Поэтому здесь пока честный null: лучше «нет данных», чем ряд наполовину
// из API, наполовину из догадок.
export async function getSkuDaily(
  offerId: string,
  days = 28
): Promise<DailyPoint[] | null> {
  if (!isMock()) return null;
  const product = MOCK_PRODUCTS.find((p) => p.offer_id === offerId);
  return product ? dailySeries(product, days) : null;
}

// Контент карточки: число фото, заполненность характеристик, контент-рейтинг,
// замечания модерации. В живом режиме — отдельные вызовы Seller API, пока не
// подключены, поэтому null.
export async function getCardContent(offerId: string): Promise<CardContent | null> {
  if (!isMock()) return null;
  const product = MOCK_PRODUCTS.find((p) => p.offer_id === offerId);
  return product ? cardContent(product) : null;
}

// Входные данные для плана поставок: остаток по кластерам Ozon, доля спроса
// по кластерам, собственный склад и кратность короба.
//
// В живом режиме это три разных источника, и не все из них — Ozon:
// остаток по складам — Seller API (отчёт об остатках на складах);
// спрос по кластерам — аналитика с разбивкой по региону (нужно подтвердить
// на тарифе); собственный склад и кратность короба — учётная система
// производителя, Ozon о них не знает. Пока всё это не подключено — null,
// и план поставок честно говорит, чего ему не хватает.
export async function getSupplyInputs(offerId: string): Promise<SupplyInputs | null> {
  if (!isMock()) return null;
  const product = MOCK_PRODUCTS.find((p) => p.offer_id === offerId);
  return product ? supplyInputs(product) : null;
}

// Сопоставимые карточки конкурентов. В живом режиме это внешний источник —
// MPSTATS, Moneyplace или индекс цен Ozon — и он не подключён, поэтому null:
// сравнение с рынком честно «нет данных», а не выдуманные конкуренты.
export async function getMarket(offerId: string): Promise<Competitor[] | null> {
  if (!isMock()) return null;
  const product = MOCK_PRODUCTS.find((p) => p.offer_id === offerId);
  return product ? marketFor(product) : null;
}

// Тексты отзывов за последние 60 дней. В живом режиме — Seller API
// (/v1/review/list, нужна подписка Premium Plus); не проверено, поэтому null.
export async function getReviews(offerId: string): Promise<Review[] | null> {
  if (!isMock()) return null;
  const product = MOCK_PRODUCTS.find((p) => p.offer_id === offerId);
  return product ? reviewsFor(product) : null;
}

// Человекочитаемое сообщение по ошибке запроса к Ozon (для страниц и агента).
export function ozonErrorMessage(e: unknown): string {
  const status = (e as { response?: { status?: number } })?.response?.status;
  if (status === 429) {
    return "Ozon вернул 429 — превышен лимит запросов аналитики (≈1 запрос в минуту). Подождите минуту и обновите.";
  }
  if (status === 401 || status === 403) {
    return "Ozon отклонил запрос (нет доступа). Проверьте ключи Seller API в .env.local.";
  }
  return "Не удалось получить данные из Ozon. Попробуйте позже.";
}
