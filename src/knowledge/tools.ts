// Tool Registry — ЕДИНСТВЕННАЯ граница с Ozon. Возвращает нормализованные данные
// и состояние (ToolErrorState). Никто выше в стек Ozon-клиент не импортирует.
import { getProducts, getSalesSummary } from "../integrations/ozon/store";
import { shelfLifeLeftDays, shelfLifeLeftPct } from "../integrations/ozon/mock";
import type { ToolResult, ToolErrorState, ToolContext, ToolRunner } from "./types";

// Заглушка внешнего рынка. Реальный источник (MPStat / Moneyplace / парсер выдачи)
// подключается здесь и больше нигде — остальной стек о нём не знает.
// Пока источника нет, эти цифры честно помечены как external_market и v1-заглушка.
const MOCK_COMPETITORS = [
  {
    title: "Сыворотка с ниацинамидом 10%, 30 мл",
    price: 1_090,
    rating: 4.6,
    reviews_count: 2_140,
    url: "https://www.ozon.ru/mock/competitor-1",
  },
  {
    title: "Сыворотка для лица ниацинамид + цинк, 30 мл",
    price: 1_290,
    rating: 4.7,
    reviews_count: 1_780,
    url: "https://www.ozon.ru/mock/competitor-2",
  },
  {
    title: "Сыворотка-концентрат для сужения пор, 30 мл",
    price: 940,
    rating: 4.5,
    reviews_count: 3_260,
    url: "https://www.ozon.ru/mock/competitor-3",
  },
];

function classify(e: unknown): ToolErrorState {
  const status = (e as { response?: { status?: number } })?.response?.status;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden_no_subscription";
  if (status === 429) return "rate_limited";
  return "upstream_unavailable";
}

async function get_products(): Promise<ToolResult> {
  try {
    const products = await getProducts();
    const norm = products.map((p) => ({
      offer_id: p.offer_id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      category: p.category,

      price: p.price,
      old_price: p.old_price,
      cost_price: p.cost_price,
      commission_pct: p.commission_pct,
      logistics_per_unit: p.logistics_per_unit,
      in_promo: p.in_promo,

      stock: p.stock,
      supply_lead_days: p.supply_lead_days,
      // Срок годности — производная от даты партии; считаем здесь, на границе,
      // чтобы выше по стеку метрика была обычным числом (или null = unknown).
      shelf_life_left_days: shelfLifeLeftDays(p),
      shelf_life_left_pct: shelfLifeLeftPct(p),

      impressions_30d: p.impressions_30d,
      sessions_30d: p.sessions_30d,
      to_cart_30d: p.to_cart_30d,
      orders_30d: p.orders_30d,

      ad_spend_30d: p.ad_spend_30d,
      ad_orders_30d: p.ad_orders_30d,

      reviews_count: p.reviews_count,
      rating: p.rating,
    }));
    return {
      tool: "get_products",
      state: norm.length ? "ok" : "empty",
      data: { products: norm },
    };
  } catch (e) {
    return { tool: "get_products", state: classify(e), data: null };
  }
}

// Принимает контекст товара (title/category/price) — реальный источник будет
// искать по нему. Пока возвращает mock (реальный поиск НЕ подключаем на этом шаге).
async function search_competitors(context?: ToolContext): Promise<ToolResult> {
  void context; // TODO: сюда подключится реальный источник конкурентов
  return {
    tool: "search_competitors",
    state: "ok",
    data: MOCK_COMPETITORS,
  };
}

async function get_sales_analytics(): Promise<ToolResult> {
  try {
    const s = await getSalesSummary();
    return {
      tool: "get_sales_analytics",
      state: "ok",
      data: {
        revenue: s.revenue,
        orders: s.orders,
        sessions: s.sessions,
        ad_spend: s.ad_spend, // null в живом режиме: нужен Performance API
        drr: s.drr,
      },
    };
  } catch (e) {
    return { tool: "get_sales_analytics", state: classify(e), data: null };
  }
}

// Реальный исполнитель инструментов. Eval подменяет его на mock.
export const realToolRunner: ToolRunner = async (tool, context) => {
  switch (tool) {
    case "get_products":
      return get_products();
    case "get_sales_analytics":
      return get_sales_analytics();
    case "search_competitors":
      return search_competitors(context);
    default:
      return { tool, state: "upstream_unavailable", data: null };
  }
};
