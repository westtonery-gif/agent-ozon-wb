// План поставок: какой товар, на какой кластер Ozon и сколько везти.
//
// Считает код, а не модель. На выходе — запрос на отгрузку, который команда
// берёт в работу, и список товаров, где собственного склада не хватает и нужна
// партия в производство. Ничего в кабинете не создаётся: только рекомендация.
//
// Логика в одном предложении: в каждом кластере должно лежать столько, чтобы
// хватило на целевой запас дней ПЛЮС дорогу до этого кластера — иначе товар
// кончится раньше, чем приедет следующая поставка.

import { getProducts, getSupplyInputs, isMock } from "../integrations/ozon/store";
import { peakMonth, profileFor, seasonFactor } from "./seasonality";

export interface SupplyLine {
  cluster_id: string;
  cluster_name: string;
  offer_id: string;
  name: string;
  qty: number; // к отгрузке, шт (целыми коробами)
  boxes: number;
  daily_demand: number; // прогноз заказов в день в этом кластере, с учётом сезона
  season_factor: number; // во сколько раз прогнозный спрос отличается от последних 30 дней
  stock_now: number; // лежит в кластере сейчас
  days_left: number | null; // на сколько дней хватит; null — спроса нет
  transit_days: number;
  urgent: boolean; // кончится раньше, чем доедет поставка
}

export interface ProductionNeed {
  offer_id: string;
  name: string;
  planned: number; // сколько хотели отгрузить
  own_stock: number; // сколько есть на своём складе
  shortfall: number; // сколько не хватило
  lead_days: number | null; // цикл производства
}

// Товар, которому по темпу последних 30 дней запаса хватает, а с учётом
// сезона — нет. Партию надо запускать сейчас: к пику она иначе не успеет.
export interface SeasonalProductionNeed {
  offer_id: string;
  name: string;
  season_profile: string;
  peak_month: string;
  lead_days: number; // цикл производства и поставки
  horizon_days: number; // на сколько вперёд смотрим: цикл + 60 дней после прихода партии
  season_factor: number;
  demand_naive: number; // спрос за горизонт по темпу последних 30 дней
  demand_seasonal: number; // тот же горизонт с учётом сезона
  stock_total: number; // на Ozon + на своём складе
  shortfall: number; // сколько не хватит, округлено до коробов
}

export interface ClusterTotal {
  cluster_id: string;
  cluster_name: string;
  units: number;
  boxes: number;
  skus: number;
  urgent: number;
}

export interface SupplyPlan {
  target_days: number;
  is_mock: boolean;
  lines: SupplyLine[];
  by_cluster: ClusterTotal[];
  production: ProductionNeed[];
  seasonal_production: SeasonalProductionNeed[];
  skipped_low_demand: number;
  no_data: string[];
  totals: { units: number; boxes: number; skus: number; clusters: number; urgent: number };
}

// Кластер, куда товар покупают реже трёх раз в месяц, не стоит целого короба:
// он пролежит полгода и съест хранение. Такой спрос закрывается из соседнего.
const MIN_MONTHLY_ORDERS = 3;

// Горизонт планирования производства: цикл производства плюс два месяца
// продаж после прихода партии — партия, запущенная сегодня, должна их закрыть.
const PRODUCTION_HORIZON_AFTER_ARRIVAL = 60;
// Сезонный рост меньше 15% тонет в шуме — не повод запускать партию раньше.
const MIN_SEASON_UPLIFT = 1.15;

export async function planSupply(
  opts: { targetDays?: number; offerIds?: string[]; today?: Date } = {}
): Promise<SupplyPlan> {
  const targetDays = opts.targetDays ?? 28;
  // Дата нужна сезонности. Передаётся явно в тестах, чтобы результат не
  // зависел от того, в каком месяце их запускают.
  const today = opts.today ?? new Date();
  const products = (await getProducts()).filter(
    (p) => !opts.offerIds || opts.offerIds.includes(p.offer_id)
  );

  const lines: SupplyLine[] = [];
  const production: ProductionNeed[] = [];
  const seasonalProduction: SeasonalProductionNeed[] = [];
  const noData: string[] = [];
  let skipped = 0;

  for (const p of products) {
    const inputs = await getSupplyInputs(p.offer_id);
    // Без темпа продаж или без раскладки по складам план — это гадание.
    if (!inputs || p.orders_30d === null) {
      noData.push(p.offer_id);
      continue;
    }

    const dailyTotal = p.orders_30d / 30;
    const profile = profileFor(p.offer_id, p.category);
    const candidates: SupplyLine[] = [];

    // Производство к сезону. Смотрим не на темп сентября, а на то, что будет
    // продаваться, пока партия производится и два месяца после её прихода.
    const lead = p.supply_lead_days ?? 30;
    const horizon = lead + PRODUCTION_HORIZON_AFTER_ARRIVAL;
    const horizonFactor = seasonFactor(profile, today, 0, horizon);
    const naive = dailyTotal * horizon;
    const seasonal = naive * horizonFactor;
    const stockTotal = p.stock + inputs.own_stock;
    // Только то, что меняет решение: по темпу хватает, по сезону — нет.
    // Кто не успевает и без сезона, уже виден в дефиците и подсортировке.
    if (horizonFactor >= MIN_SEASON_UPLIFT && naive <= stockTotal && seasonal > stockTotal) {
      seasonalProduction.push({
        offer_id: p.offer_id,
        name: p.name,
        season_profile: profile.title,
        peak_month: peakMonth(profile, today, horizon),
        lead_days: lead,
        horizon_days: horizon,
        season_factor: Number(horizonFactor.toFixed(2)),
        demand_naive: Math.round(naive),
        demand_seasonal: Math.round(seasonal),
        stock_total: stockTotal,
        shortfall: Math.ceil((seasonal - stockTotal) / inputs.units_per_box) * inputs.units_per_box,
      });
    }

    for (const pos of inputs.positions) {
      // Порог «стоит ли вообще возить» — по фактическим продажам, не по прогнозу.
      if (dailyTotal * pos.demand_share * 30 < MIN_MONTHLY_ORDERS) {
        skipped++;
        continue;
      }
      // Остаток в кластере должен закрыть дорогу и целевой запас — по спросу
      // этих будущих дней, а не прошедших: перед декабрём парфюм уходит
      // вдвое быстрее, чем в сентябре, а SPF осенью — медленнее.
      const window = targetDays + pos.cluster.transit_days;
      const sf = seasonFactor(profile, today, 0, window);
      const daily = dailyTotal * pos.demand_share * sf;
      const need = daily * window - pos.stock;
      if (need <= 0) continue;

      // Целыми коробами — только когда потребность не меньше короба. Если в
      // кластер нужно 5 штук, а в коробе 48, везти целый короб значит положить
      // год запаса на хранение: такое едет сборным коробом, поштучно.
      const qty =
        need >= inputs.units_per_box
          ? Math.ceil(need / inputs.units_per_box) * inputs.units_per_box
          : Math.ceil(need);
      const daysLeft = daily > 0 ? Number((pos.stock / daily).toFixed(1)) : null;
      candidates.push({
        cluster_id: pos.cluster.id,
        cluster_name: pos.cluster.name,
        offer_id: p.offer_id,
        name: p.name,
        qty,
        boxes: Math.ceil(qty / inputs.units_per_box),
        daily_demand: Number(daily.toFixed(2)),
        season_factor: Number(sf.toFixed(2)),
        stock_now: pos.stock,
        days_left: daysLeft,
        transit_days: pos.cluster.transit_days,
        urgent: daysLeft !== null && daysLeft < pos.cluster.transit_days,
      });
    }

    const planned = candidates.reduce((s, l) => s + l.qty, 0);
    if (planned === 0) continue;

    if (planned <= inputs.own_stock) {
      lines.push(...candidates);
      continue;
    }

    // Своего склада не хватает на все кластеры. Дефицит раздаём туда, где
    // товар продаётся быстрее всего, а не туда, где «пусто раньше»: 30 штук в
    // Москве продадутся за месяц, те же 30 в Сибири — за четыре, и всё это
    // время Москва простаивает. Регионы дождутся производственной партии.
    // Поштучно: 30 штук при коробе в 48 — не повод ничего не везти.
    let left = inputs.own_stock;
    const byUrgency = [...candidates].sort(
      (a, b) =>
        b.daily_demand - a.daily_demand || (a.days_left ?? Infinity) - (b.days_left ?? Infinity)
    );
    for (const line of byUrgency) {
      const give = Math.min(line.qty, left);
      if (give <= 0) break;
      left -= give;
      lines.push({ ...line, qty: give, boxes: Math.ceil(give / inputs.units_per_box) });
    }
    const shipped = inputs.own_stock - left;
    production.push({
      offer_id: p.offer_id,
      name: p.name,
      planned,
      own_stock: inputs.own_stock,
      shortfall: planned - shipped,
      lead_days: p.supply_lead_days,
    });
  }

  // Сводка по кластерам: поставка на Ozon оформляется на склад, поэтому
  // команде удобнее видеть «что везём в Сибирь», а не «что везём по SKU».
  const clusterMap = new Map<string, ClusterTotal>();
  for (const l of lines) {
    const t = clusterMap.get(l.cluster_id) ?? {
      cluster_id: l.cluster_id,
      cluster_name: l.cluster_name,
      units: 0,
      boxes: 0,
      skus: 0,
      urgent: 0,
    };
    t.units += l.qty;
    t.boxes += l.boxes;
    t.skus += 1;
    if (l.urgent) t.urgent += 1;
    clusterMap.set(l.cluster_id, t);
  }
  const by_cluster = [...clusterMap.values()].sort((a, b) => b.urgent - a.urgent || b.units - a.units);

  // Внутри плана: сначала срочное, потом по кластерам.
  lines.sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      a.cluster_id.localeCompare(b.cluster_id) ||
      a.offer_id.localeCompare(b.offer_id)
  );

  return {
    target_days: targetDays,
    is_mock: isMock(),
    lines,
    by_cluster,
    production: production.sort((a, b) => b.shortfall - a.shortfall),
    seasonal_production: seasonalProduction.sort((a, b) => b.shortfall - a.shortfall),
    skipped_low_demand: skipped,
    no_data: noData,
    totals: {
      units: lines.reduce((s, l) => s + l.qty, 0),
      boxes: lines.reduce((s, l) => s + l.boxes, 0),
      skus: new Set(lines.map((l) => l.offer_id)).size,
      clusters: by_cluster.length,
      urgent: lines.filter((l) => l.urgent).length,
    },
  };
}

// Запрос на отгрузку в CSV — то, что передаётся команде для формирования
// поставок. Разделитель «;» и BOM: Excel с русской локалью открывает такой
// файл без мастера импорта.
export function supplyPlanCsv(plan: SupplyPlan): string {
  const head = [
    "Кластер",
    "Артикул",
    "Товар",
    "К отгрузке, шт",
    "Коробов",
    "Сейчас в кластере, шт",
    "Хватит на, дней",
    "Доставка, дней",
    "Срочно",
  ];
  const esc = (v: string | number) => {
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = plan.lines.map((l) =>
    [
      l.cluster_name,
      l.offer_id,
      l.name,
      l.qty,
      l.boxes,
      l.stock_now,
      l.days_left === null ? "" : String(l.days_left).replace(".", ","),
      l.transit_days,
      l.urgent ? "да" : "",
    ]
      .map(esc)
      .join(";")
  );
  return "﻿" + [head.join(";"), ...rows].join("\r\n") + "\r\n";
}
