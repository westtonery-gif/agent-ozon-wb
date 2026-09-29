// Закономерности: одна проблема у одного товара — это вопрос, та же проблема
// у нескольких — ответ про процесс.
//
// Правила юнитов смотрят на каждый SKU по отдельности и называют симптомы.
// Этот слой смотрит на ассортимент целиком и ищет, что у симптомов общего:
// одна линейка, одна акция, один склад. Находка здесь — не «у SKU X плохо»,
// а «вот процесс, вот сколько он стоит, вот кто его чинит».
//
// Два уровня уверенности, и их нельзя смешивать:
//   finding    — ЧТО совпало. Находит код, это факт из данных.
//   hypothesis — КАКОЙ ПРОЦЕСС мог к этому привести. Это вывод, а не измерение:
//                данные показывают, что акция и убыточная реклама совпали на
//                трёх товарах, но не показывают, как их согласовывают в компании.
//
// Масштаб: всё здесь — группировки и суммы, поэтому работает одинаково на
// 24 SKU и на 3000. В модель уходят только найденные закономерности.

import { getSupplyInputs } from "../integrations/ozon/store";
import { resolveMetrics } from "./resolver";
import { plural } from "./ru";
import { memoizeTools, realToolRunner } from "./tools";
import type { MetricBundle, ToolRunner } from "./types";

export type PatternId =
  | "line_imbalance"
  | "promo_ads_stacking"
  | "regional_gap"
  | "overstock_capital";

export interface Pattern {
  id: PatternId;
  title: string;
  owner: string; // кто в компании это чинит
  skus: string[];
  facts: Array<Record<string, string | number | boolean | null>>;
  money: {
    frozen_rub: number | null; // заморожено в стоке сверх 3 месяцев продаж, по себестоимости
    lost_margin_rub: number | null; // маржа, которую не заработаем, пока товара нет
    monthly_loss_rub: number | null; // уходит в минус каждый месяц
  };
  headline: string; // одна фраза: что происходит и сколько стоит — для короткого ответа
  finding: string; // факт целиком, с цифрами по каждому SKU — «подробнее»
  hypothesis: string; // процесс — предположение
  action: string;
}

// Метрики, нужные детекторам. Все считает Formula Engine; здесь только
// группировка и суммирование.
const METRICS = [
  "stock",
  "orders_30d",
  "stock_days",
  "cover_gap_days",
  "cost_price",
  "unit_margin",
  "cpo",
  "ad_margin_gap",
  "ad_orders_30d",
  "shelf_life_left_pct",
];

// Больше девяти месяцев запаса — замороженные деньги (как в юните стока).
const OVERSTOCK_DAYS = 270;
// «Заморожено» — всё, что сверх трёх месяцев продаж: столько разумно держать.
const HEALTHY_COVER_DAYS = 90;

interface Row {
  offer_id: string;
  name: string;
  brand: string | null;
  model_id: string;
  in_promo: boolean | null;
  m: MetricBundle;
}

const val = (r: Row, id: string): number | null => {
  const x = r.m[id];
  return x && x.status === "known" && typeof x.value === "number" ? x.value : null;
};

const rub = (n: number) => Math.round(n);

// «ORTIKA Помада матовая устойчивая, тон 04 Berry» → линейка и вариант.
const lineName = (name: string) => name.split(",")[0].trim();
const variant = (name: string) => {
  const parts = name.split(",");
  return parts.length > 1 ? parts[parts.length - 1].trim() : name;
};
const thousands = (n: number) =>
  n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(".", ",")} тыс. ₽` : `${n} ₽`;

// Сумма, которая становится неизвестной, если неизвестно хоть одно слагаемое:
// «заморожено 74 тыс.», посчитанное без половины товаров, — это враньё.
function sumOrNull(xs: Array<number | null>): number | null {
  if (!xs.length || xs.some((x) => x === null)) return null;
  return rub(xs.reduce<number>((a, b) => a + (b as number), 0));
}

function daily(r: Row): number | null {
  const o = val(r, "orders_30d");
  return o === null ? null : o / 30;
}

// Стоимость запаса сверх трёх месяцев продаж, по себестоимости.
function frozenOf(r: Row): number | null {
  const stock = val(r, "stock");
  const d = daily(r);
  const cost = val(r, "cost_price");
  if (stock === null || d === null || cost === null) return null;
  return Math.max(0, stock - d * HEALTHY_COVER_DAYS) * cost;
}

// Маржа, которую товар не заработает, пока его нет: дни без товара до прихода
// партии × продажи в день × маржа с единицы. Это оценка, а не факт.
function lostMarginOf(r: Row): number | null {
  const gap = val(r, "cover_gap_days");
  const d = daily(r);
  const margin = val(r, "unit_margin");
  if (gap === null || d === null || margin === null) return null;
  return Math.max(0, -gap) * d * Math.max(0, margin);
}

// ── 1. Перекос в линейке ─────────────────────────────────────────────────
// В одной модели одни варианты кончаются, другие лежат годами. По отдельности
// это «подсортировка опоздала» и «залежался»; вместе — план производства,
// который делит партию поровну, а продаётся она не поровну.
function lineImbalance(rows: Row[]): Pattern[] {
  const byModel = new Map<string, Row[]>();
  for (const r of rows) byModel.set(r.model_id, [...(byModel.get(r.model_id) ?? []), r]);

  const out: Pattern[] = [];
  for (const [model, items] of byModel) {
    if (items.length < 2) continue;
    const over = items.filter((r) => (val(r, "stock_days") ?? 0) > OVERSTOCK_DAYS);
    const short = items.filter(
      (r) => val(r, "stock") === 0 || (val(r, "cover_gap_days") ?? Infinity) < 0
    );
    if (!over.length || !short.length) continue;

    const describe = (r: Row) => `${r.name} — ${val(r, "orders_30d")} шт/мес, остаток ${val(r, "stock")}`;
    out.push({
      id: "line_imbalance",
      title: "Перекос в линейке",
      owner: "производство",
      skus: items.map((r) => r.offer_id),
      facts: items.map((r) => ({
        sku: r.offer_id,
        name: r.name,
        orders_30d: val(r, "orders_30d"),
        stock: val(r, "stock"),
        stock_days: val(r, "stock_days"),
        cover_gap_days: val(r, "cover_gap_days"),
      })),
      money: {
        frozen_rub: sumOrNull(over.map(frozenOf)),
        lost_margin_rub: sumOrNull(short.map(lostMarginOf)),
        monthly_loss_rub: null,
      },
      headline:
        `${lineName(items[0].name)}: ${short.map((r) => variant(r.name)).join(", ")} кончается, ` +
        `а ${over.map((r) => `${variant(r.name)} лежит ${val(r, "stock")} шт`).join(", ")}.`,
      finding:
        `В одной линейке (${model}) одновременно дефицит и затоваривание. ` +
        `Кончается: ${short.map(describe).join("; ")}. ` +
        `Лежит больше 9 месяцев: ${over.map(describe).join("; ")}.`,
      hypothesis:
        "Похоже, партии линейки планируются без учёта продаж по вариантам: производят поровну, а покупают неравномерно.",
      action:
        `Производству: следующую партию линейки делить по продажам вариантов за 30 дней. ` +
        `${over.map((r) => r.offer_id).join(", ")} не производить, пока запас не станет меньше трёх месяцев продаж; ` +
        `${short.map((r) => r.offer_id).join(", ")} — в ближайшую партию.`,
    });
  }
  return out;
}

// ── 2. Акция и продвижение на одном товаре ───────────────────────────────
// Если почти все товары, где реклама уходит в минус, стоят в акциях — это не
// три неудачные кампании, а одна практика: скидку и продвижение согласуют
// раздельно, и на одном SKU они вместе съедают маржу.
function promoAdsStacking(rows: Row[]): Pattern[] {
  const lossAds = rows.filter((r) => (val(r, "ad_margin_gap") ?? 0) < 0);
  const stacked = lossAds.filter((r) => r.in_promo === true);
  // Закономерность — это повторение: один товар ещё не практика.
  if (stacked.length < 2 || stacked.length / lossAds.length < 0.6) return [];

  const lossOf = (r: Row): number | null => {
    const gap = val(r, "ad_margin_gap");
    const adOrders = val(r, "ad_orders_30d");
    const orders = val(r, "orders_30d");
    const margin = val(r, "unit_margin");
    if (gap === null || adOrders === null || orders === null || margin === null) return null;
    // Убыток рекламы на рекламных заказах + отрицательная маржа на остальных.
    return -gap * adOrders + (margin < 0 ? -margin * Math.max(0, orders - adOrders) : 0);
  };

  return [
    {
      id: "promo_ads_stacking",
      title: "Акция и продвижение на одном товаре",
      owner: "маркетинг",
      skus: stacked.map((r) => r.offer_id),
      facts: stacked.map((r) => ({
        sku: r.offer_id,
        name: r.name,
        unit_margin: val(r, "unit_margin"),
        cpo: val(r, "cpo"),
        ad_margin_gap: val(r, "ad_margin_gap"),
        in_promo: r.in_promo,
      })),
      money: {
        frozen_rub: null,
        lost_margin_rub: null,
        monthly_loss_rub: sumOrNull(stacked.map(lossOf)),
      },
      headline: (() => {
        const loss = sumOrNull(stacked.map(lossOf));
        const all = stacked.length === lossAds.length ? "Все" : `${stacked.length} из`;
        return (
          `${all} ${plural(lossAds.length, "товар", "товара", "товаров")}, где реклама уходит в минус, стоят в акциях` +
          (loss !== null ? ` — ${thousands(loss)} в месяц.` : ".")
        );
      })(),
      finding:
        `Продвижение уходит в минус на ${lossAds.length} товарах, и ${stacked.length} из них стоят в акциях: ` +
        stacked
          .map((r) => `${r.name} (маржа ${val(r, "unit_margin")} ₽, заказ с рекламы ${val(r, "cpo")} ₽)`)
          .join("; ") +
        ".",
      hypothesis:
        "Похоже, акции и продвижение согласуют раздельно: каждое по отдельности окупается, вместе на одном товаре — съедают маржу.",
      action:
        "Маркетингу: на время акции снижать ставку продвижения до маржи после скидки или выключать. " +
        "Правило на будущее — акция и продвижение на один SKU согласуются вместе.",
    },
  ];
}

// ── 3. Остаток не там, где покупают ──────────────────────────────────────
// Товара в целом хватает, но почти весь лежит в Москве, а покупают его по всей
// стране. Покупатели регионов ждут доставку из Москвы: дольше (срок видно в
// карточке) и дороже по логистике.
//
// Дефицитный товар сюда не попадает намеренно: когда его мало, держать его в
// Москве — правильное решение (там он уходит быстрее всего, так же решает
// планировщик поставок). Перекос — это когда распределять есть что.
const MIN_COVER_TO_DISTRIBUTE = 30; // дней запаса в целом
const MOSCOW_SKEW = 0.35; // доля остатка в Москве минус доля спроса там
const THIN_COVER = 14; // регион «без товара», если там меньше чем на 2 недели

async function regionalGap(rows: Row[]): Promise<Pattern[]> {
  const affected: Array<{
    r: Row;
    moscowStock: number;
    moscowDemand: number;
    thinOrders: number;
  }> = [];

  for (const r of rows) {
    const stock = val(r, "stock");
    const orders = val(r, "orders_30d");
    const cover = val(r, "stock_days");
    if (!stock || !orders || cover === null || cover < MIN_COVER_TO_DISTRIBUTE) continue;
    const inputs = await getSupplyInputs(r.offer_id);
    if (!inputs) continue;

    const msk = inputs.positions.find((p) => p.cluster.id === "msk");
    if (!msk) continue;
    const moscowStock = msk.stock / stock;
    if (moscowStock - msk.demand_share < MOSCOW_SKEW) continue;

    // Заказы в месяц, которые приходятся на регионы с запасом меньше двух недель.
    const thinOrders = inputs.positions
      .filter((p) => p.cluster.id !== "msk")
      .filter((p) => {
        const d = (orders / 30) * p.demand_share;
        return d > 0 && p.stock / d < THIN_COVER;
      })
      .reduce((s, p) => s + orders * p.demand_share, 0);

    affected.push({ r, moscowStock, moscowDemand: msk.demand_share, thinOrders });
  }
  if (affected.length < 2) return [];

  const thinTotal = rub(affected.reduce((s, a) => s + a.thinOrders, 0));
  return [
    {
      id: "regional_gap",
      title: "Остаток не там, где покупают",
      owner: "логистика",
      skus: affected.map((a) => a.r.offer_id),
      facts: affected.map((a) => ({
        sku: a.r.offer_id,
        name: a.r.name,
        stock_in_moscow_pct: rub(a.moscowStock * 100),
        demand_in_moscow_pct: rub(a.moscowDemand * 100),
        stock_days_total: val(a.r, "stock_days"),
        regional_orders_on_thin_stock: rub(a.thinOrders),
      })),
      // Тарифа локализации в данных нет — рубли здесь не выдумываем.
      money: { frozen_rub: null, lost_margin_rub: null, monthly_loss_rub: null },
      headline:
        `${plural(affected.length, "ходовой товар лежит", "ходовых товара лежат", "ходовых товаров лежат")} ` +
        `почти целиком в Москве, а ${plural(thinTotal, "заказ", "заказа", "заказов")} в месяц — в регионах, где их почти нет.`,
      finding:
        `${plural(affected.length, "товар", "товара", "товаров")} в целом в достатке, но лежат в Москве: ` +
        affected
          .map(
            (a) =>
              `${a.r.name} — ${rub(a.moscowStock * 100)}% остатка в Москве при ${rub(
                a.moscowDemand * 100
              )}% спроса там`
          )
          .join("; ") +
        `. ${plural(thinTotal, "заказ в месяц приходится", "заказа в месяц приходятся", "заказов в месяц приходятся")} на регионы, где этих товаров меньше чем на две недели.`,
      hypothesis:
        "Похоже, поставки по привычке идут в Москву: ближе и проще, а продаётся по всей стране.",
      action:
        "Логистике: следующую поставку распределять по кластерам пропорционально спросу — план уже посчитан, спросите «что отгружать».",
    },
  ];
}

// ── 4. Замороженные деньги ───────────────────────────────────────────────
// Товары, которые лежат больше девяти месяцев, — вне перекосов линеек (там
// причина другая). Если большинство из них уже в акциях и всё равно лежат,
// это отдельный вывод: акция этот товар не разгружает, нужен другой инструмент.
function overstockCapital(rows: Row[], covered: Set<string>): Pattern[] {
  const over = rows.filter(
    (r) => !covered.has(r.offer_id) && (val(r, "stock_days") ?? 0) > OVERSTOCK_DAYS
  );
  if (over.length < 2) return [];

  const inPromo = over.filter((r) => r.in_promo === true);
  const promoFails = inPromo.length / over.length >= 0.5;
  const shelfRisk = over.filter((r) => (val(r, "shelf_life_left_pct") ?? 100) < 60);

  return [
    {
      id: "overstock_capital",
      title: "Замороженные деньги",
      owner: "коммерция",
      skus: over.map((r) => r.offer_id),
      facts: over.map((r) => ({
        sku: r.offer_id,
        name: r.name,
        stock: val(r, "stock"),
        orders_30d: val(r, "orders_30d"),
        stock_days: val(r, "stock_days"),
        in_promo: r.in_promo,
        shelf_life_left_pct: val(r, "shelf_life_left_pct"),
      })),
      money: {
        frozen_rub: sumOrNull(over.map(frozenOf)),
        lost_margin_rub: null,
        monthly_loss_rub: null,
      },
      headline: (() => {
        const frozen = sumOrNull(over.map(frozenOf));
        return (
          (frozen !== null ? `${thousands(frozen)} по себестоимости лежат` : "Лежат") +
          ` в ${plural(over.length, "позиции", "позициях", "позициях")} больше чем на 9 месяцев вперёд` +
          (promoFails ? `, ${inPromo.length} из них уже в акциях и всё равно не уходят.` : ".")
        );
      })(),
      finding:
        `${plural(over.length, "товар лежит", "товара лежат", "товаров лежат")} больше чем на 9 месяцев вперёд.` +
        (promoFails ? ` ${inPromo.length} из них уже в акциях — и всё равно не уходят.` : "") +
        (shelfRisk.length
          ? ` У ${shelfRisk.map((r) => r.offer_id).join(", ")} осталось меньше 60% срока годности.`
          : ""),
      hypothesis: promoFails
        ? "Похоже, скидка — единственный инструмент разгрузки, и для этих товаров он не работает: проблема не в цене."
        : "Похоже, эти позиции производятся по плану, а не по продажам.",
      action:
        "Коммерции: по каждой позиции решить — набор с ходовым товаром, уценка по сроку или вывод из матрицы. Не допроизводить.",
    },
  ];
}

// ── Оркестрация ──────────────────────────────────────────────────────────

// Деньги разной природы: заморожено — один раз, теряется в месяц — каждый месяц.
// Чтобы сравнивать их на одной шкале, ежемесячный убыток приводим к году.
const total = (p: Pattern) =>
  (p.money.frozen_rub ?? 0) + (p.money.lost_margin_rub ?? 0) + (p.money.monthly_loss_rub ?? 0) * 12;

export async function detectPatterns(opts: { tools?: ToolRunner } = {}): Promise<Pattern[]> {
  const runTool = memoizeTools(opts.tools ?? realToolRunner);
  const listing = await runTool("get_products");
  const raw = ((listing.data as { products?: Array<Record<string, unknown>> })?.products ?? []);
  if (listing.state !== "ok" || !raw.length) return [];

  const rows: Row[] = [];
  for (const p of raw) {
    const offer_id = String(p.offer_id ?? "");
    const { bundle } = await resolveMetrics(METRICS, { productRef: { offer_id }, tools: runTool });
    rows.push({
      offer_id,
      name: typeof p.name === "string" ? p.name : offer_id,
      brand: typeof p.brand === "string" ? p.brand : null,
      model_id: typeof p.model_id === "string" ? p.model_id : offer_id,
      in_promo: typeof p.in_promo === "boolean" ? p.in_promo : null,
      m: bundle,
    });
  }

  const lines = lineImbalance(rows);
  const covered = new Set(lines.flatMap((p) => p.skus));
  const patterns = [
    ...lines,
    ...promoAdsStacking(rows),
    ...(await regionalGap(rows)),
    ...overstockCapital(rows, covered),
  ];

  // Сначала то, что стоит больше денег; без рублей — по числу затронутых SKU.
  return patterns.sort((a, b) => total(b) - total(a) || b.skus.length - a.skus.length);
}
