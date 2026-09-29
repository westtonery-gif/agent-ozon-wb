// Режим «Диагностика падения продаж» по одному SKU.
//
// Восемь проверок в заданном порядке, каждую делает КОД, а не модель.
// Каждая возвращает «данные / формула / вывод / источник» и один из статусов:
//   found          — причина найдена;
//   not_confirmed  — данные есть, причина не подтверждается;
//   no_data        — данных нет, вывод не делаем.
//
// Правило номер один: нет данных — пишем «нет данных». Не «вероятно», не
// «скорее всего»: проверка без данных не имеет права на вывод.

import { getCardContent, getProducts, getSkuDaily, isMock } from "../integrations/ozon/store";
import type { DailyPoint } from "../integrations/ozon/mock-timeseries";

export type CheckStatus = "found" | "not_confirmed" | "no_data";

export interface CheckResult {
  id: string;
  order: number; // 1..8, порядок из постановки задачи
  title: string;
  status: CheckStatus;
  data: string; // что измерено
  formula: string | null; // как посчитано (null, если считать было нечего)
  conclusion: string; // вывод по этой проверке
  source: string; // откуда цифра в живом режиме
  weight: number; // для ранжирования причин; 0 у not_confirmed / no_data
  action: string | null; // рекомендация (никаких изменений в кабинете)
  recheck_days: number | null; // когда перепроверить, чтобы понять, сработало ли
}

export interface DropSummary {
  orders_before: number;
  orders_now: number;
  orders_delta_pct: number;
  revenue_before: number;
  revenue_now: number;
  revenue_delta_pct: number;
  started_on: string | null;
}

export interface SalesDropReport {
  offer_id: string;
  name: string;
  is_mock: boolean;
  period_days: number;
  current_range: [string, string];
  previous_range: [string, string];
  drop: DropSummary | null;
  is_drop: boolean;
  checks: CheckResult[]; // все восемь, в порядке постановки
  primary: CheckResult | null; // главная вероятная причина
  others: CheckResult[]; // остальные найденные, по убыванию веса
  no_data: CheckResult[]; // что проверить не удалось
  status: "ok" | "unknown_sku" | "no_series";
}

// Откуда каждая цифра берётся в ЖИВОМ режиме. Часть источников честно
// отсутствует: это и есть ответ на «какие поля реально отдают API».
const SOURCES = {
  sales: "Ozon Seller API, /v1/analytics/data (dimension: sku + day)",
  stock: "Снимки остатков в своей базе — Seller API истории остатка не отдаёт",
  price: "Снимки цены в своей базе — Seller API истории цены не отдаёт",
  market: "MPSTATS — не подключён",
  position: "Отчёт по позициям в поиске — в API текущего тарифа не подтверждён",
  reviews: "Ozon Seller API, /v1/review/list — требует подписку Premium Plus",
  ads: "Ozon Performance API — не подключён (отдельные ключи и OAuth)",
  content: "Ozon Seller API: контент-рейтинг и статус модерации карточки",
} as const;

const pct = (now: number, before: number): number | null =>
  before === 0 ? null : Number((((now - before) / before) * 100).toFixed(1));

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

function noData(
  order: number,
  id: string,
  title: string,
  source: string,
  why: string
): CheckResult {
  return {
    id,
    order,
    title,
    status: "no_data",
    data: why,
    formula: null,
    conclusion: "Нет данных — проверку выполнить нельзя, вывод не делаем.",
    source,
    weight: 0,
    action: null,
    recheck_days: null,
  };
}

// ── Проверка 1. Продажи ──────────────────────────────────────────────────
function checkSales(cur: DailyPoint[], prev: DailyPoint[]): {
  check: CheckResult;
  drop: DropSummary;
} {
  const ordersNow = sum(cur.map((d) => d.orders));
  const ordersBefore = sum(prev.map((d) => d.orders));
  const revenueNow = sum(cur.map((d) => d.revenue));
  const revenueBefore = sum(prev.map((d) => d.revenue));
  const ordersDelta = pct(ordersNow, ordersBefore);
  const revenueDelta = pct(revenueNow, revenueBefore);

  // День, с которого пошло падение: первый день текущего периода, когда заказы
  // опустились ниже 60% среднего за предыдущий период и больше не вернулись.
  const baseline = avg(prev.map((d) => d.orders));
  let startedOn: string | null = null;
  for (let i = 0; i < cur.length; i++) {
    if (cur[i].orders < baseline * 0.6) {
      const staysDown = cur.slice(i).every((d) => d.orders < baseline * 0.8);
      if (staysDown) {
        startedOn = cur[i].date;
        break;
      }
    }
  }

  const drop: DropSummary = {
    orders_before: ordersBefore,
    orders_now: ordersNow,
    orders_delta_pct: ordersDelta ?? 0,
    revenue_before: revenueBefore,
    revenue_now: revenueNow,
    revenue_delta_pct: revenueDelta ?? 0,
    started_on: startedOn,
  };

  const fell = (ordersDelta ?? 0) <= -20;
  return {
    drop,
    check: {
      id: "sales",
      order: 1,
      title: "Продажи",
      status: fell ? "found" : "not_confirmed",
      data: `Заказы ${ordersBefore} → ${ordersNow} шт, выручка ${Math.round(
        revenueBefore
      )} → ${Math.round(revenueNow)} ₽${startedOn ? `, падение с ${startedOn}` : ""}`,
      formula: "(текущий период − предыдущий) / предыдущий × 100",
      conclusion: fell
        ? `Заказы ${ordersDelta}%, выручка ${revenueDelta}%.${
            startedOn ? ` Падение началось ${startedOn}.` : ""
          }`
        : `Заказы ${ordersDelta}% — значимого падения нет.`,
      source: SOURCES.sales,
      weight: 0, // это констатация факта, а не причина
      action: null,
      recheck_days: null,
    },
  };
}

// ── Проверка 2. Остаток ──────────────────────────────────────────────────
function checkStock(cur: DailyPoint[]): CheckResult {
  const zeroDays = cur.filter((d) => d.stock === 0);
  const found = zeroDays.length > 0;
  return {
    id: "stock",
    order: 2,
    title: "Остаток",
    status: found ? "found" : "not_confirmed",
    data: found
      ? `Остаток 0 в ${zeroDays.length} из ${cur.length} дней, впервые ${zeroDays[0].date}`
      : `Минимальный остаток за период — ${Math.min(...cur.map((d) => d.stock))} шт`,
    formula: "дни с stock = 0 внутри периода",
    conclusion: found
      ? `Товар выпал из продажи с ${zeroDays[0].date}. Это перебивает остальные причины: без остатка карточка не продаёт и теряет позиции.`
      : "Товар был в наличии весь период — дефицит падение не объясняет.",
    source: SOURCES.stock,
    weight: found ? 100 + (zeroDays.length / cur.length) * 10 : 0,
    action: found
      ? "Срочная отгрузка на склад. После возврата в сток проверить, восстановилась ли позиция в выдаче — она возвращается не сразу."
      : null,
    recheck_days: found ? 3 : null,
  };
}

// ── Проверка 3. Цена ─────────────────────────────────────────────────────
function checkPrice(cur: DailyPoint[], prev: DailyPoint[]): CheckResult {
  const priceNow = avg(cur.map((d) => d.price));
  const priceBefore = avg(prev.map((d) => d.price));
  const delta = pct(priceNow, priceBefore);
  const raised = (delta ?? 0) >= 5;

  return {
    id: "price",
    order: 3,
    title: "Цена",
    status: raised ? "found" : "not_confirmed",
    data: `Наша цена ${Math.round(priceBefore)} → ${Math.round(priceNow)} ₽ (${delta}%). Цены конкурентов: нет данных.`,
    formula: "(средняя цена текущего периода − предыдущего) / предыдущего × 100",
    conclusion: raised
      ? `Цену подняли на ${delta}% — это совпадает с падением спроса. Сравнить с рынком нельзя: MPSTATS не подключён, поэтому насколько цена выбилась из ниши — неизвестно.`
      : `Наша цена практически не менялась (${delta}%). Сравнение с конкурентами недоступно — MPSTATS не подключён, поэтому эту половину проверки закрыть нечем.`,
    source: `${SOURCES.price}; ${SOURCES.market}`,
    weight: raised ? 80 + Math.min(20, Math.abs(delta ?? 0)) : 0,
    action: raised
      ? `Проверить, окупается ли рост цены: сравнить маржу на единицу до и после. Если заказы упали сильнее, чем выросла маржа, вернуть цену к ${Math.round(priceBefore)} ₽.`
      : null,
    recheck_days: raised ? 7 : null,
  };
}

// ── Проверка 4. Позиция в выдаче ─────────────────────────────────────────
function checkPosition(cur: DailyPoint[], prev: DailyPoint[]): CheckResult {
  const now = cur.map((d) => d.position).filter((p): p is number => p !== null);
  const before = prev.map((d) => d.position).filter((p): p is number => p !== null);
  if (!now.length || !before.length) {
    return noData(
      4,
      "position",
      "Позиция в выдаче",
      SOURCES.position,
      "История позиций не собирается"
    );
  }
  const posNow = avg(now);
  const posBefore = avg(before);
  // Позиция — чем меньше, тем лучше: рост числа = ухудшение.
  const worsened = posNow > posBefore * 1.5;
  const firstBad = cur.find((d) => d.position !== null && d.position > posBefore * 1.5);

  return {
    id: "position",
    order: 4,
    title: "Позиция в выдаче",
    status: worsened ? "found" : "not_confirmed",
    data: `Средняя позиция ${posBefore.toFixed(0)} → ${posNow.toFixed(0)}${
      firstBad ? `, просадка с ${firstBad.date}` : ""
    }`,
    formula: "средняя позиция за период; рост числа = ухудшение",
    conclusion: worsened
      ? `Карточка уехала с ${posBefore.toFixed(0)}-й на ${posNow.toFixed(
          0
        )}-ю позицию${firstBad ? ` с ${firstBad.date}` : ""} — трафик упал вместе с ней.`
      : `Позиция стабильна (${posBefore.toFixed(0)} → ${posNow.toFixed(0)}).`,
    source: SOURCES.position,
    weight: worsened ? 70 + Math.min(20, posNow - posBefore) : 0,
    action: worsened
      ? "Проверить, что изменилось раньше просадки: цена, остаток, рейтинг или ставка продвижения. Позиция — следствие, а не причина."
      : null,
    recheck_days: worsened ? 7 : null,
  };
}

// ── Проверка 5. Рейтинг и отзывы ─────────────────────────────────────────
function checkReviews(cur: DailyPoint[], prev: DailyPoint[]): CheckResult {
  const ratingsNow = cur.map((d) => d.rating).filter((r): r is number => r !== null);
  const ratingsBefore = prev.map((d) => d.rating).filter((r): r is number => r !== null);
  if (!ratingsNow.length || !ratingsBefore.length) {
    return noData(
      5,
      "reviews",
      "Рейтинг и отзывы",
      SOURCES.reviews,
      "Рейтинг и отзывы недоступны"
    );
  }
  const rNow = avg(ratingsNow);
  const rBefore = avg(ratingsBefore);
  const negatives = sum(cur.map((d) => d.reviews_negative_new ?? 0));
  const dropped = rBefore - rNow >= 0.2 || negatives >= 3;

  return {
    id: "reviews",
    order: 5,
    title: "Рейтинг и отзывы",
    status: dropped ? "found" : "not_confirmed",
    data: `Рейтинг ${rBefore.toFixed(1)} → ${rNow.toFixed(1)}, новых отзывов с оценкой ≤ 3: ${negatives}`,
    formula: "средний рейтинг за период; сумма новых отзывов с оценкой ≤ 3",
    conclusion: dropped
      ? `Рейтинг просел на ${(rBefore - rNow).toFixed(
          1
        )} и пришло ${negatives} негативных отзывов — в косметике это бьёт по конверсии сразу.`
      : `Рейтинг стабилен (${rBefore.toFixed(1)} → ${rNow.toFixed(1)}), негатива нет.`,
    source: SOURCES.reviews,
    weight: dropped ? 60 + negatives * 2 : 0,
    action: dropped
      ? "Прочитать негативные отзывы и найти общий мотив: брак партии, несоответствие описанию, повреждение при доставке. Ответить на каждый."
      : null,
    recheck_days: dropped ? 14 : null,
  };
}

// ── Проверка 6. Конкуренты ───────────────────────────────────────────────
function checkCompetitors(): CheckResult {
  return noData(
    6,
    "competitors",
    "Конкуренты",
    SOURCES.market,
    "Акции и цены конкурентов требуют внешнего источника"
  );
}

// ── Проверка 7. Реклама и продвижение ────────────────────────────────────
function checkAds(cur: DailyPoint[], prev: DailyPoint[]): CheckResult {
  const spendNow = cur.map((d) => d.ad_spend).filter((v): v is number => v !== null);
  const spendBefore = prev.map((d) => d.ad_spend).filter((v): v is number => v !== null);
  if (!spendNow.length || !spendBefore.length) {
    return noData(7, "ads", "Реклама и продвижение", SOURCES.ads, "Данных по продвижению нет");
  }
  const now = sum(spendNow);
  const before = sum(spendBefore);
  const delta = pct(now, before);
  const cut = (delta ?? 0) <= -40;

  return {
    id: "ads",
    order: 7,
    title: "Реклама и продвижение",
    status: cut ? "found" : "not_confirmed",
    data: `Расход на продвижение ${Math.round(before)} → ${Math.round(now)} ₽ (${delta}%)`,
    formula: "(расход текущего периода − предыдущего) / предыдущего × 100",
    conclusion: cut
      ? `Бюджет продвижения срезан на ${Math.abs(
          delta ?? 0
        )}% — платный трафик ушёл, и заказы ушли вместе с ним.`
      : `Бюджет продвижения существенно не менялся (${delta}%).`,
    source: SOURCES.ads,
    weight: cut ? 50 + Math.min(20, Math.abs(delta ?? 0) / 5) : 0,
    action: cut
      ? "Решить осознанно: вернуть бюджет или принять новый уровень продаж. Предельная ставка считается от маржи с единицы, а не от прежнего бюджета."
      : null,
    recheck_days: cut ? 7 : null,
  };
}

// ── Проверка 8. Карточка ─────────────────────────────────────────────────
function checkContent(
  content: Awaited<ReturnType<typeof getCardContent>>
): CheckResult {
  if (!content) {
    return noData(8, "content", "Карточка", SOURCES.content, "Контент карточки недоступен");
  }
  const weak =
    content.attributes_filled_pct < 80 ||
    content.photos_count < 4 ||
    content.moderation_note !== null;

  return {
    id: "content",
    order: 8,
    title: "Карточка",
    status: weak ? "found" : "not_confirmed",
    data: `Фото ${content.photos_count}, характеристики ${content.attributes_filled_pct}%, контент-рейтинг ${content.content_rating}${
      content.moderation_note ? `, модерация: ${content.moderation_note}` : ""
    }`,
    formula: "порог: фото ≥ 4, характеристики ≥ 80%, замечаний модерации нет",
    conclusion: weak
      ? `Карточка заполнена не полностью.${
          content.moderation_note ? ` Замечание модерации: ${content.moderation_note}.` : ""
        } Это снижает и показы, и конверсию, но редко даёт резкое падение — скорее держит потолок.`
      : `Карточка заполнена (контент-рейтинг ${content.content_rating}).`,
    source: SOURCES.content,
    weight: weak ? 30 + (100 - content.content_rating) / 10 : 0,
    action: weak
      ? "Дозаполнить характеристики и состав, добавить фото. Для косметики состав обязателен — без него карточка теряет и выдачу, и доверие."
      : null,
    recheck_days: weak ? 14 : null,
  };
}

// ── Оркестрация ──────────────────────────────────────────────────────────

export async function diagnoseSalesDrop(
  offerId: string,
  periodDays = 7
): Promise<SalesDropReport> {
  const products = await getProducts();
  const product = products.find(
    (p) => p.offer_id.toLowerCase() === offerId.toLowerCase()
  );

  const empty = (status: SalesDropReport["status"]): SalesDropReport => ({
    offer_id: offerId,
    name: product?.name ?? offerId,
    is_mock: isMock(),
    period_days: periodDays,
    current_range: ["", ""],
    previous_range: ["", ""],
    drop: null,
    is_drop: false,
    checks: [],
    primary: null,
    others: [],
    no_data: [],
    status,
  });

  if (!product) return empty("unknown_sku");

  const series = await getSkuDaily(product.offer_id, periodDays * 2);
  if (!series || series.length < periodDays * 2) return empty("no_series");

  const cur = series.slice(-periodDays);
  const prev = series.slice(-periodDays * 2, -periodDays);
  const content = await getCardContent(product.offer_id);

  const { check: salesCheck, drop } = checkSales(cur, prev);
  const checks: CheckResult[] = [
    salesCheck,
    checkStock(cur),
    checkPrice(cur, prev),
    checkPosition(cur, prev),
    checkReviews(cur, prev),
    checkCompetitors(),
    checkAds(cur, prev),
    checkContent(content),
  ];

  // Ранжируем только найденные причины. Вес — это сила сигнала и приоритет
  // по деньгам, а не доказанный вклад в падение: атрибуции у нас нет,
  // и делать вид, что есть, было бы враньём.
  const found = checks
    .filter((c) => c.status === "found" && c.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  return {
    offer_id: product.offer_id,
    name: product.name,
    is_mock: isMock(),
    period_days: periodDays,
    current_range: [cur[0].date, cur[cur.length - 1].date],
    previous_range: [prev[0].date, prev[prev.length - 1].date],
    drop,
    is_drop: salesCheck.status === "found",
    checks,
    primary: found[0] ?? null,
    others: found.slice(1),
    no_data: checks.filter((c) => c.status === "no_data"),
    status: "ok",
  };
}
