import ozon from "./client";
import { getOrdersBySku } from "./analytics";
import type { OzonProduct } from "./mock";

// Сырой список товаров: только product_id и offer_id.
export async function getProducts() {
  const response = await ozon.post("/v3/product/list", {
    filter: {},
    last_id: "",
    limit: 100,
  });

  return response.data;
}

interface ProductListItem {
  product_id: number;
  offer_id: string;
}

interface ProductInfoStock {
  present?: number;
  reserved?: number;
}

interface ProductInfoItem {
  offer_id: string;
  name?: string;
  price?: string;
  old_price?: string;
  sku?: number; // нужен, чтобы сопоставить товар с заказами из аналитики
  reviews_count?: number; // если Ozon вернёт — берём; иначе останется unknown
  rating?: number;
  // Объединение вариантов в одну карточку (оттенки, объёмы).
  model_info?: { model_id?: number; count?: number };
  // Ozon отдаёт остатки массивом по складам/источникам: stocks.stocks[].present
  stocks?: { stocks?: ProductInfoStock[] };
}

// Реальные товары с деталями, приведённые к формату OzonProduct.
// Ozon отдаёт список и подробности разными эндпоинтами, поэтому делаем два запроса.
export async function getProductsDetailed(): Promise<OzonProduct[]> {
  const list = await getProducts();
  const items: ProductListItem[] = list?.result?.items ?? [];

  if (items.length === 0) return [];

  const offerIds = items.map((i) => i.offer_id).filter(Boolean);

  const info = await ozon.post("/v3/product/info/list", {
    offer_id: offerIds,
    product_id: [],
    sku: [],
  });

  // Детали приходят в data.items (без обёртки result).
  const infoItems: ProductInfoItem[] = info?.data?.items ?? [];

  // Заказы за 30 дней по каждому SKU из аналитики. Если аналитика недоступна
  // (лимит/нет подписки) — не роняем товары, но помечаем заказы как неизвестные.
  let ordersBySku: Record<string, number> | null = {};
  try {
    ordersBySku = await getOrdersBySku(30);
  } catch {
    ordersBySku = null;
  }

  return infoItems.map((p) => {
    const price = Number(p.price ?? 0);
    const oldPrice = Number(p.old_price ?? 0);
    // Остаток — сумма present по всем складам/источникам.
    const stock = (p.stocks?.stocks ?? []).reduce(
      (sum, s) => sum + (s.present ?? 0),
      0
    );
    return {
      offer_id: p.offer_id,
      sku: p.sku,
      name: p.name ?? p.offer_id,
      // Бренд и категорию Seller API в этом ответе не отдаёт — оставляем unknown.
      brand: null,
      category: null,
      // Модель Seller API отдаёт: варианты одной карточки получают общий id.
      model_id: p.model_info?.model_id ? String(p.model_info.model_id) : null,
      price,
      old_price: oldPrice || price,
      // Себестоимость и условия живут в ERP продавца, а не в Ozon: null = нет данных.
      // Юнит-экономика без них не считается, и движок честно скажет «нет данных»,
      // вместо того чтобы подставить ноль и выдать ложную маржу.
      cost_price: null,
      commission_pct: null,
      logistics_per_unit: null,
      in_promo: null,
      stock,
      // Лид-тайм производства и дата партии — тоже данные продавца, не Ozon.
      supply_lead_days: null,
      produced_at: null,
      shelf_life_days: null,
      // Воронка по товару требует отдельного запроса в аналитику с нужными
      // измерениями; текущий слой отдаёт только заказы. Остальное — unknown.
      impressions_30d: null,
      sessions_30d: null,
      to_cart_30d: null,
      orders_30d: ordersBySku ? ordersBySku[String(p.sku ?? "")] ?? 0 : null,
      // Продвижение живёт в Performance API (свои ключи, свой OAuth) — не подключён.
      ad_spend_30d: null,
      ad_orders_30d: null,
      // Если Ozon не отдаёт отзывы/рейтинг в info — оставляем null (unknown), не 0.
      reviews_count: p.reviews_count ?? null,
      rating: p.rating ?? null,
    };
  });
}
