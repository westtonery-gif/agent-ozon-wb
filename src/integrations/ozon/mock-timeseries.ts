// Дневные ряды по товару для режима «Диагностика падения продаж».
// Генерируются детерминированно (сид от артикула), поэтому один и тот же SKU
// всегда даёт одну и ту же историю — иначе диагноз «плавал» бы между запусками.
//
// Что из этого реально отдаёт живой Ozon — см. SOURCES в src/knowledge/sales-drop.ts.
// Здесь ряд полный, чтобы было видно, как режим работает при наличии данных.

import { seedOf, type OzonProduct } from "./mock";

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  orders: number;
  revenue: number;
  sessions: number;
  stock: number; // остаток на конец дня
  price: number;
  position: number | null; // позиция в категории
  ad_spend: number | null;
  ad_orders: number | null;
  rating: number | null;
  reviews_total: number | null;
  reviews_negative_new: number | null; // новых отзывов с оценкой ≤ 3 за день
}

// Сценарий, который «сломал» продажи конкретного SKU. Дни отрицательные:
// -5 = пять дней назад. Так проверки находят не просто спад, а его причину.
type Anomaly =
  | { kind: "stockout"; fromDay: number }
  | { kind: "price_up"; fromDay: number; pct: number }
  | { kind: "position_drop"; fromDay: number; to: number }
  | { kind: "rating_drop"; fromDay: number; negativePerDay: number }
  | { kind: "ad_cut"; fromDay: number }
  // Спрос упал, а у нас ничего не менялось: цена, остаток, выдача, отзывы,
  // реклама — всё прежнее. В жизни это чаще всего конкурент с акцией или
  // сезон, и без внешних данных (MPSTATS) этого не видно.
  | { kind: "market"; fromDay: number };

const ANOMALIES: Record<string, Anomaly> = {
  // Товар кончился — продажи обнулились вместе с остатком.
  "AVL-SER-NIAC-30": { kind: "stockout", fromDay: -5 },
  // Подняли цену на 18% — спрос просел.
  "ORT-LIP-MAT-04": { kind: "price_up", fromDay: -6, pct: 18 },
  // Уехали с 12-й на 47-ю позицию в категории.
  "NOI-EDP-CIT-50": { kind: "position_drop", fromDay: -8, to: 47 },
  // Пошли негативные отзывы, рейтинг поехал вниз.
  "ORT-BLS-PWD-05": { kind: "rating_drop", fromDay: -9, negativePerDay: 2 },
  // Срезали бюджет продвижения — ушёл платный трафик.
  "AVL-CRM-DAY-50": { kind: "ad_cut", fromDay: -7 },
  // Падение без видимой причины: у нас не менялось ничего. Ходовой товар,
  // чтобы падение было заметно больше шума (на 10 заказах в неделю минус
  // три заказа — это колебание, а не сигнал).
  "ORT-LIP-MAT-01": { kind: "market", fromDay: -6 },
};

// mulberry32: короткий детерминированный PRNG. Нужен именно воспроизводимый
// шум — со случайным диагностика давала бы разные ответы на один вопрос.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const isoDay = (offset: number) =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

export function dailySeries(p: OzonProduct, days = 28): DailyPoint[] {
  const next = rng(seedOf(p.offer_id));
  const anomaly = ANOMALIES[p.offer_id];

  const baseOrders = (p.orders_30d ?? 0) / 30;
  const baseSessions = (p.sessions_30d ?? 0) / 30;
  const baseAdSpend = (p.ad_spend_30d ?? 0) / 30;
  const baseAdOrders = (p.ad_orders_30d ?? 0) / 30;
  const basePosition = 8 + Math.floor(next() * 14); // 8-21 в категории

  // Остаток восстанавливаем назад во времени от текущего: чем дальше в прошлое,
  // тем больше было на складе (плюс приходы мы не моделируем).
  let stockCursor = p.stock;
  const backwards: DailyPoint[] = [];

  for (let d = 0; d > -days; d--) {
    const active = anomaly && d <= anomaly.fromDay ? false : true;
    // «active» = день ДО поломки. Дни после fromDay (ближе к сегодня) — сломанные.
    const broken = anomaly ? d > anomaly.fromDay : false;
    void active;

    let price = p.price;
    let position: number | null = basePosition + Math.floor(next() * 3) - 1;
    let adSpend: number | null = baseAdSpend;
    let adOrders: number | null = baseAdOrders;
    let rating: number | null = p.rating ?? null;
    let negativeNew = 0;
    let ordersFactor = 1;

    if (anomaly && broken) {
      switch (anomaly.kind) {
        case "stockout":
          ordersFactor = 0;
          break;
        case "price_up":
          // Цену подняли: до поломки была ниже текущей.
          ordersFactor = 0.45;
          break;
        case "position_drop":
          position = anomaly.to + Math.floor(next() * 4) - 2;
          ordersFactor = 0.4;
          break;
        case "rating_drop":
          rating = rating === null ? null : Number((rating - 0.4).toFixed(1));
          negativeNew = anomaly.negativePerDay;
          ordersFactor = 0.55;
          break;
        case "ad_cut":
          adSpend = 0;
          adOrders = 0;
          ordersFactor = 0.5;
          break;
        case "market":
          ordersFactor = 0.5;
          break;
      }
    }
    if (anomaly?.kind === "price_up" && !broken) {
      price = Math.round(p.price / (1 + anomaly.pct / 100));
    }

    // ±20% воспроизводимого шума, чтобы ряд не выглядел синтетически ровным.
    const noise = 0.8 + next() * 0.4;
    const orders = Math.max(0, Math.round(baseOrders * ordersFactor * noise));
    const sessions = Math.max(0, Math.round(baseSessions * (ordersFactor || 0.3) * noise));

    backwards.push({
      date: isoDay(d),
      orders,
      revenue: orders * price,
      sessions,
      stock: Math.max(0, Math.round(stockCursor)),
      price,
      position,
      ad_spend: adSpend === null ? null : Math.round(adSpend),
      ad_orders: adOrders === null ? null : Math.round(adOrders),
      rating,
      reviews_total: p.reviews_count ?? null,
      reviews_negative_new: negativeNew,
    });

    // Идём назад: вчера на складе было столько же плюс то, что сегодня продали.
    stockCursor += orders;
  }

  // Для stockout остаток в «сломанные» дни должен быть нулём, а не восстановленным.
  if (anomaly?.kind === "stockout") {
    for (const point of backwards) {
      const offset = Math.round((Date.parse(point.date) - Date.now()) / DAY);
      if (offset > anomaly.fromDay) point.stock = 0;
    }
  }

  return backwards.reverse(); // от старых дней к сегодняшнему
}
