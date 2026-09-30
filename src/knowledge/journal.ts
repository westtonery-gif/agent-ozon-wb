// Журнал рекомендаций: что агент советовал и что из этого вышло.
//
// Живой аналитик помнит, что пробовали в прошлом месяце и сработало ли. Без
// журнала агент каждый раз начинает с чистого листа: пишет «перепроверить
// через 7 дней» и никогда не перепроверяет.
//
// Когда наступает срок, агент сам проверяет по данным две вещи:
//   done   — СДЕЛАЛИ ли: товар отгрузили, цену поменяли, рекламу вернули.
//            Видно не всегда: исправленную карточку в цифрах не увидишь —
//            тогда null, и так и говорится.
//   worked — СРАБОТАЛО ли: вернулись ли заказы, выросла ли маржа в день.
// «Сделали и не сработало» — тоже результат: гипотеза была неверной.
//
// Хранение — JSON-файл (.data/journal.json, путь меняется OZON_JOURNAL_PATH).
// Для одного менеджера и демо этого достаточно; для команды — база.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProducts, getSkuDaily, isMock } from "../integrations/ozon/store";
import type { DailyPoint } from "../integrations/ozon/mock-timeseries";

export type RecKind =
  | "stock"
  | "price"
  | "position"
  | "reviews"
  | "ads"
  | "content"
  | "price_test";

export interface Snapshot {
  orders_week: number;
  price: number;
  stock: number;
  ad_spend_week: number | null;
  margin_day: number | null; // маржа в день по текущей цене; null — нет себестоимости
}

export interface JournalEntry {
  id: string;
  created_at: string; // YYYY-MM-DD
  recheck_at: string;
  sku: string;
  name: string;
  kind: RecKind;
  action: string; // что советовали
  baseline: Snapshot; // как было в момент совета
  target_orders_week: number | null; // к какому уровню хотим вернуться
  test_price: number | null; // для теста цены
  seed?: boolean; // демо-запись мока, пересоздаётся каждый день
}

export interface FollowUp {
  entry: JournalEntry;
  due: boolean; // срок проверки наступил
  now: Snapshot | null; // null — нет данных для проверки
  done: boolean | null;
  worked: boolean | null;
  summary: string;
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const day = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

function journalPath(): string {
  return process.env.OZON_JOURNAL_PATH ?? join(process.cwd(), ".data", "journal.json");
}

interface JournalFile {
  seeded_on: string | null;
  entries: JournalEntry[];
}

function read(): JournalFile {
  try {
    return JSON.parse(readFileSync(journalPath(), "utf8")) as JournalFile;
  } catch {
    return { seeded_on: null, entries: [] };
  }
}

function write(f: JournalFile) {
  mkdirSync(dirname(journalPath()), { recursive: true });
  writeFileSync(journalPath(), JSON.stringify(f, null, 2));
}

// ── Снимок товара: то, по чему судим «сделали» и «сработало» ──────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function snapshotFrom(series: DailyPoint[], upto: number, marginOf: (price: number) => number | null): Snapshot {
  // upto — индекс последнего дня снимка в ряду (включительно).
  const week = series.slice(Math.max(0, upto - 6), upto + 1);
  const last = series[upto];
  const orders = sum(week.map((d) => d.orders));
  const spend = week.map((d) => d.ad_spend);
  const margin = marginOf(last.price);
  return {
    orders_week: orders,
    price: last.price,
    stock: last.stock,
    ad_spend_week: spend.some((v) => v === null) ? null : sum(spend as number[]),
    margin_day: margin === null ? null : Math.round((margin * orders) / 7),
  };
}

async function marginFn(sku: string): Promise<(price: number) => number | null> {
  const p = (await getProducts()).find((x) => x.offer_id === sku);
  if (!p || p.cost_price === null || p.commission_pct === null || p.logistics_per_unit === null) {
    return () => null;
  }
  return (price) => price - p.cost_price! - (price * p.commission_pct!) / 100 - p.logistics_per_unit!;
}

export async function snapshotNow(sku: string): Promise<Snapshot | null> {
  const series = await getSkuDaily(sku, 28);
  if (!series || !series.length) return null;
  return snapshotFrom(series, series.length - 1, await marginFn(sku));
}

// ── Оценка: сделали ли и сработало ли ────────────────────────────────────

export function evaluate(entry: JournalEntry, now: Snapshot | null, today: Date): FollowUp {
  const due = entry.recheck_at <= iso(today.getTime());
  if (!now) {
    return {
      entry,
      due,
      now,
      done: null,
      worked: null,
      summary: "Проверить нечем: нет свежих данных по товару.",
    };
  }

  const b = entry.baseline;
  let done: boolean | null = null;
  switch (entry.kind) {
    case "stock":
      done = now.stock > 0;
      break;
    case "price":
      done = now.price < b.price; // цену, поднятую перед падением, вернули
      break;
    case "ads":
      done = now.ad_spend_week === null ? null : now.ad_spend_week > 0;
      break;
    case "price_test":
      done = entry.test_price !== null && now.price >= entry.test_price * 0.95;
      break;
    default:
      done = null; // карточку, отзывы, позицию по цифрам не проверишь
  }

  let worked: boolean | null = null;
  if (entry.kind === "price_test") {
    worked = now.margin_day !== null && b.margin_day !== null ? now.margin_day >= b.margin_day : null;
  } else if (entry.target_orders_week !== null) {
    worked = now.orders_week >= entry.target_orders_week * 0.8;
  }

  const ordersLine = `заказов в неделю ${b.orders_week} → ${now.orders_week}${
    entry.target_orders_week !== null ? ` (было до проблемы ${entry.target_orders_week})` : ""
  }`;
  const marginLine =
    b.margin_day !== null && now.margin_day !== null
      ? `маржа в день ${b.margin_day} → ${now.margin_day} ₽`
      : null;

  let summary: string;
  if (!due) {
    summary = `Срок проверки ${day(entry.recheck_at)}, пока рано судить.`;
  } else if (done === false) {
    const days = Math.floor((today.getTime() - Date.parse(entry.created_at)) / DAY);
    summary = `Не сделано: ${entry.action.charAt(0).toLowerCase()}${entry.action.slice(1)} — совет висит ${days} дн. Сейчас ${ordersLine}.`;
  } else if (worked === true) {
    summary = `${done ? "Сделано и сработало" : "Похоже, сработало"}: ${
      entry.kind === "price_test" && marginLine ? marginLine : ordersLine
    }.`;
  } else if (worked === false) {
    summary = `${done ? "Сделано, но не сработало" : "Результата нет"}: ${
      entry.kind === "price_test" && marginLine ? marginLine : ordersLine
    }. ${done ? "Значит, причина была в другом — ищем дальше." : ""}`.trim();
  } else {
    summary = `Результат не определить: ${ordersLine}.`;
  }

  return { entry, due, now, done, worked, summary };
}

// ── Запись и чтение ──────────────────────────────────────────────────────

export interface NewRecommendation {
  sku: string;
  name: string;
  kind: RecKind;
  action: string;
  recheck_days: number;
  target_orders_week: number | null;
  test_price?: number | null;
}

// Записывает совет, если по этому товару нет открытого совета того же вида:
// задать один и тот же вопрос дважды — не повод дважды записывать.
export async function recordRecommendation(rec: NewRecommendation, today = new Date()): Promise<JournalEntry | null> {
  const f = await load(today);
  const open = f.entries.find(
    (e) => e.sku === rec.sku && e.kind === rec.kind && e.recheck_at >= iso(today.getTime())
  );
  if (open) return null;
  const baseline = await snapshotNow(rec.sku);
  if (!baseline) return null; // без исходной точки проверять потом будет не с чем
  const entry: JournalEntry = {
    id: `${rec.sku}:${rec.kind}:${iso(today.getTime())}`,
    created_at: iso(today.getTime()),
    recheck_at: iso(today.getTime() + rec.recheck_days * DAY),
    sku: rec.sku,
    name: rec.name,
    kind: rec.kind,
    action: rec.action,
    baseline,
    target_orders_week: rec.target_orders_week,
    test_price: rec.test_price ?? null,
  };
  f.entries.push(entry);
  write(f);
  return entry;
}

export async function followUps(today = new Date()): Promise<FollowUp[]> {
  const f = await load(today);
  const out: FollowUp[] = [];
  for (const e of f.entries) out.push(evaluate(e, await snapshotNow(e.sku), today));
  // Сначала наступившие сроки, среди них — невыполненные.
  return out.sort(
    (a, b) => Number(b.due) - Number(a.due) || Number(a.done ?? true) - Number(b.done ?? true)
  );
}

// ── Демо-записи мока ─────────────────────────────────────────────────────
// Мок живёт относительно сегодняшнего дня, поэтому демо-записи пересоздаются
// каждый день, а записи, сделанные в чате, сохраняются. Каждая демо-запись
// построена по тому же ряду, что видит агент, — числа не придуманы отдельно.

async function load(today: Date): Promise<JournalFile> {
  const f = read();
  const todayIso = iso(today.getTime());
  if (!isMock() || f.seeded_on === todayIso) return f;
  const kept = f.entries.filter((e) => !e.seed);
  const seeded: JournalFile = { seeded_on: todayIso, entries: [...(await demoSeed(today)), ...kept] };
  write(seeded);
  return seeded;
}

async function demoSeed(today: Date): Promise<JournalEntry[]> {
  const seeds: Array<{
    sku: string;
    kind: RecKind;
    createdAgo: number;
    recheckDays: number;
    action: string;
  }> = [
    // Был в нуле, совет выполнили, продажи вернулись.
    { sku: "ORT-BRW-GEL-04", kind: "stock", createdAgo: 12, recheckDays: 5, action: "Срочно отгрузить гель для бровей на склады Ozon" },
    // Кончился, совет не выполнили — товар всё ещё в нуле.
    { sku: "AVL-SER-NIAC-30", kind: "stock", createdAgo: 4, recheckDays: 3, action: "Срочно отгрузить сыворотку с ниацинамидом — готовая партия стоит на своём складе" },
    // Совет свежий, срок ещё не наступил.
    { sku: "ORT-LIP-MAT-04", kind: "price", createdAgo: 2, recheckDays: 7, action: "Сравнить маржу до и после подъёма цены и вернуть 585 ₽, если потеря заказов её съедает" },
  ];

  const out: JournalEntry[] = [];
  for (const s of seeds) {
    const series = await getSkuDaily(s.sku, 28);
    const p = (await getProducts()).find((x) => x.offer_id === s.sku);
    if (!series || !p) continue;
    const last = series.length - 1;
    const at = last - s.createdAgo; // день совета в ряду
    const margin = await marginFn(s.sku);
    // «До проблемы» — полная неделя, закончившаяся за неделю до совета: к
    // моменту совета проблема уже была, неделей раньше товар продавался нормально.
    const before = series.slice(at - 13, at - 6);
    const created = today.getTime() - s.createdAgo * DAY;
    out.push({
      id: `${s.sku}:${s.kind}:${iso(created)}`,
      created_at: iso(created),
      recheck_at: iso(created + s.recheckDays * DAY),
      sku: s.sku,
      name: p.name,
      kind: s.kind,
      action: s.action,
      baseline: snapshotFrom(series, at, margin),
      target_orders_week: sum(before.map((d) => d.orders)),
      test_price: null,
      seed: true,
    });
  }
  return out;
}
