// Offline eval: инструменты Ozon и рынка замоканы, LLM-синтез не вызывается.
// Проверяем детерминированный слой — роутер, резолвер, формулы, правила.
import { matchUnits, runDiagnosis, runStoreScan } from "./knowledge/runtime";
import { diagnoseSalesDrop } from "./knowledge/sales-drop";
import { planSupply, supplyPlanCsv } from "./knowledge/supply-plan";
import { detectPatterns } from "./knowledge/patterns";
import ozon from "./integrations/ozon/client";
import { getProductsDetailed } from "./integrations/ozon/products";
import type { ToolResult, ToolRunner } from "./knowledge/types";

// Строка товара в форме, которую отдаёт get_products (Tool Registry).
type Row = Record<string, unknown>;

function product(over: Row = {}): Row {
  return {
    offer_id: "TEST-SKU",
    sku: 1,
    name: "Test product",
    brand: "TEST",
    category: "Уход за лицом",
    price: 1000,
    old_price: 1200,
    cost_price: 250,
    commission_pct: 16,
    logistics_per_unit: 70,
    in_promo: false,
    stock: 100,
    supply_lead_days: 20,
    shelf_life_left_days: 600,
    shelf_life_left_pct: 82,
    impressions_30d: 20_000,
    sessions_30d: 1_400,
    to_cart_30d: 196,
    orders_30d: 60,
    ad_spend_30d: 3_000,
    ad_orders_30d: 15,
    reviews_count: 300,
    rating: 4.6,
    ...over,
  };
}

// Инструменты, отдающие заданный набор товаров.
function toolsFor(rows: Row[]): ToolRunner {
  return async (tool): Promise<ToolResult> => {
    if (tool === "get_products") return { tool, state: "ok", data: { products: rows } };
    if (tool === "get_sales_analytics")
      return {
        tool,
        state: "ok",
        data: { revenue: 500_000, orders: 400, sessions: 20_000, ad_spend: 60_000, drr: 12 },
      };
    if (tool === "search_competitors")
      return {
        tool,
        state: "ok",
        data: [{ title: "Competitor", price: 700, rating: 4.8, reviews_count: 1000 }],
      };
    return { tool, state: "upstream_unavailable", data: null };
  };
}

// Инструмент недоступен по правам — метрика должна стать unavailable, не 0.
const forbiddenTools: ToolRunner = async (tool) => ({
  tool,
  state: "forbidden_no_subscription",
  data: null,
});

function assert(name: string, cond: boolean, got: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  (got: ${JSON.stringify(got)})`}`);
  return cond;
}

const INVENTORY = "inventory/stock-replenishment.md";
const PRICING = "pricing/promo-efficiency.md";
const TRAFFIC = "traffic/funnel-drop.md";

async function main() {
  const results: boolean[] = [];

  // ── Роутер: вопрос → юнит по keywords самого юнита ──
  results.push(
    assert(
      "router: вопрос про остатки → inventory.stock-replenishment",
      matchUnits("на сколько хватит остатка?")[0]?.unit.id === "inventory.stock-replenishment",
      matchUnits("на сколько хватит остатка?")[0]?.unit.id
    ),
    assert(
      "router: вопрос про акцию → pricing.promo-efficiency",
      matchUnits("выгодна ли акция?")[0]?.unit.id === "pricing.promo-efficiency",
      matchUnits("выгодна ли акция?")[0]?.unit.id
    ),
    assert(
      "router: вопрос про ДРР → traffic.funnel-drop",
      matchUnits("какой у меня ДРР?")[0]?.unit.id === "traffic.funnel-drop",
      matchUnits("какой у меня ДРР?")[0]?.unit.id
    ),
    assert(
      "router: «продается» без ё матчится как «продаётся»",
      matchUnits("почему товар плохо продается?").length > 0,
      matchUnits("почему товар плохо продается?").map((m) => m.unit.id)
    ),
    assert(
      "router: вопрос вне компетенции → ни одного юнита",
      matchUnits("какая завтра погода в москве?").length === 0,
      matchUnits("какая завтра погода в москве?").map((m) => m.unit.id)
    )
  );

  // ── Сток ──
  const stockout = await runDiagnosis({
    question: "сток",
    unitPath: INVENTORY,
    tools: toolsFor([product({ stock: 0 })]),
  });
  results.push(
    assert(
      "stockout: правило stockout, severity critical",
      stockout.diagnosis?.matched_rule === "stockout" &&
        stockout.diagnosis?.severity === "critical",
      stockout.diagnosis
    )
  );

  // Остатка на 9 дней (30/(100/30)) при сроке поставки 20 → подсортировка опоздала.
  const overdue = await runDiagnosis({
    question: "сток",
    unitPath: INVENTORY,
    tools: toolsFor([product({ stock: 30, orders_30d: 100, supply_lead_days: 20 })]),
  });
  results.push(
    assert(
      "replenishment_overdue: cover_gap_days < 0",
      overdue.diagnosis?.matched_rule === "replenishment_overdue",
      overdue.diagnosis?.matched_rule
    ),
    assert(
      "cover_gap_days посчитан формулой поверх stock_days",
      overdue.formulas.some(
        (f) => f.formula_id === "cover_gap_days" && f.status === "known" && f.value === -11
      ),
      overdue.formulas.filter((f) => f.formula_id === "cover_gap_days")
    )
  );

  const expiry = await runDiagnosis({
    question: "сток",
    unitPath: INVENTORY,
    tools: toolsFor([product({ shelf_life_left_pct: 22, shelf_life_left_days: 160 })]),
  });
  results.push(
    assert(
      "expiry_risk: остаточный срок ниже 40% важнее подсортировки",
      expiry.diagnosis?.matched_rule === "expiry_risk",
      expiry.diagnosis?.matched_rule
    )
  );

  const dead = await runDiagnosis({
    question: "сток",
    unitPath: INVENTORY,
    tools: toolsFor([product({ stock: 500, orders_30d: 5 })]),
  });
  results.push(
    assert(
      "dead_stock: запас больше 180 дней",
      dead.diagnosis?.matched_rule === "dead_stock",
      dead.diagnosis?.matched_rule
    )
  );

  // ── Цена и промо ──
  // 1610 − 1420 − 17% − 108 = −192: акция продаёт в минус.
  const loss = await runDiagnosis({
    question: "акция",
    unitPath: PRICING,
    tools: toolsFor([
      product({
        price: 1610,
        old_price: 2690,
        cost_price: 1420,
        commission_pct: 17,
        logistics_per_unit: 108,
        in_promo: true,
      }),
    ]),
  });
  results.push(
    assert(
      "margin_negative: продажа в минус — critical",
      loss.diagnosis?.matched_rule === "margin_negative" &&
        loss.diagnosis?.severity === "critical",
      loss.diagnosis
    ),
    assert(
      "unit_margin = −192 (считает Formula Engine, не модель)",
      loss.formulas.some((f) => f.formula_id === "unit_margin" && f.value === -192),
      loss.formulas.filter((f) => f.formula_id === "unit_margin")
    ),
    assert(
      "margin_pct посчитан поверх unit_margin (вложенная формула)",
      loss.formulas.some((f) => f.formula_id === "margin_pct" && f.status === "known"),
      loss.formulas.filter((f) => f.formula_id === "margin_pct")
    )
  );

  // Себестоимости нет → маржа неизвестна, а не ноль.
  const noCost = await runDiagnosis({
    question: "акция",
    unitPath: PRICING,
    tools: toolsFor([product({ cost_price: null })]),
  });
  results.push(
    assert(
      "нет себестоимости → unit_margin unknown, а не 0",
      noCost.formulas.some((f) => f.formula_id === "unit_margin" && f.value === null),
      noCost.formulas.filter((f) => f.formula_id === "unit_margin")
    ),
    assert(
      "нет себестоимости → правило margin_negative не срабатывает",
      noCost.diagnosis?.matched_rule !== "margin_negative",
      noCost.diagnosis?.matched_rule
    )
  );

  // ── Воронка и продвижение ──
  // Маржа 520 (1000 − 250 − 16% − 70), привлечение заказа 1000 → продвижение в минус.
  const adLoss = await runDiagnosis({
    question: "продвижение",
    unitPath: TRAFFIC,
    tools: toolsFor([product({ ad_spend_30d: 10_000, ad_orders_30d: 10 })]),
  });
  results.push(
    assert(
      "ad_unprofitable: CPO выше маржи с единицы",
      adLoss.diagnosis?.matched_rule === "ad_unprofitable",
      adLoss.diagnosis?.matched_rule
    ),
    assert(
      "ad_margin_gap = 520 − 1000 = −480",
      adLoss.formulas.some((f) => f.formula_id === "ad_margin_gap" && f.value === -480),
      adLoss.formulas.filter((f) => f.formula_id === "ad_margin_gap")
    )
  );

  const ctrLow = await runDiagnosis({
    question: "воронка",
    unitPath: TRAFFIC,
    tools: toolsFor([
      product({ impressions_30d: 100_000, sessions_30d: 1_500, ad_spend_30d: 0, ad_orders_30d: 0 }),
    ]),
  });
  results.push(
    assert(
      "ctr_low: показы есть, в карточку не заходят",
      ctrLow.diagnosis?.matched_rule === "ctr_low",
      ctrLow.diagnosis?.matched_rule
    ),
    assert(
      "продвижения не было → cpo unknown, а не 0",
      ctrLow.formulas.some((f) => f.formula_id === "cpo" && f.value === null),
      ctrLow.formulas.filter((f) => f.formula_id === "cpo")
    )
  );

  // ── Нет доступа к данным ──
  const forbidden = await runDiagnosis({
    question: "сток",
    unitPath: INVENTORY,
    tools: forbiddenTools,
  });
  results.push(
    assert(
      "нет доступа → status data_unavailable, диагноза нет",
      forbidden.status === "data_unavailable" && forbidden.diagnosis?.primary_unit === null,
      { status: forbidden.status, diagnosis: forbidden.diagnosis?.primary_unit }
    )
  );

  // ── Обход ассортимента ──
  const scan = await runStoreScan({
    question: "проанализируй магазин",
    tools: toolsFor([
      product({ offer_id: "OK-1", name: "Здоровый SKU" }),
      product({ offer_id: "OUT-1", name: "Нет в наличии", stock: 0 }),
      product({ offer_id: "DEAD-1", name: "Залежался", stock: 500, orders_30d: 5 }),
    ]),
  });
  results.push(
    assert(
      "scan: обошёл все 3 товара",
      scan.products_scanned === 3,
      scan.products_scanned
    ),
    assert(
      "scan: здоровый SKU не попал в находки",
      !scan.findings.some((f) => f.product.offer_id === "OK-1"),
      scan.findings.map((f) => f.product.offer_id)
    ),
    assert(
      "scan: critical идёт первым",
      scan.findings[0]?.product.offer_id === "OUT-1" &&
        scan.findings[0]?.diagnosis.severity === "critical",
      scan.findings[0]
    ),
    assert(
      "scan: у находки есть доказательная база из метрик правила",
      (scan.findings[0]?.evidence.length ?? 0) > 0 &&
        scan.findings[0].evidence.every((m) => m.status === "known"),
      scan.findings[0]?.evidence
    ),
    assert(
      "scan: кросс-диагностические юниты не дублируют находки",
      new Set(scan.findings.map((f) => `${f.product.offer_id}:${f.diagnosis.matched_rule}`)).size ===
        scan.findings.length,
      scan.findings.map((f) => `${f.product.offer_id}:${f.diagnosis.matched_rule}`)
    )
  );

  // ── Режим «Диагностика падения продаж» ──
  // Идёт по реальному моку (офлайн, без LLM): каждый SKU со сценарием должен
  // дать именно свою причину, иначе проверки ловят шум, а не сигнал.
  const expected: Array<[string, string]> = [
    ["AVL-SER-NIAC-30", "stock"],
    ["ORT-LIP-MAT-04", "price"],
    ["NOI-EDP-CIT-50", "position"],
    ["ORT-BLS-PWD-05", "reviews"],
    ["AVL-CRM-DAY-50", "ads"],
  ];
  for (const [sku, cause] of expected) {
    const r = await diagnoseSalesDrop(sku, 7);
    results.push(
      assert(
        `drop ${sku}: падение найдено, главная причина — ${cause}`,
        r.is_drop && r.primary?.id === cause,
        { is_drop: r.is_drop, primary: r.primary?.id }
      )
    );
  }

  // Цена сравнивается «до изменения → сейчас», а не средними за периоды:
  // средняя за неделю со сменой цены даёт число, по которому товар не продавался.
  const priceCheck = (await diagnoseSalesDrop("ORT-LIP-MAT-04", 7)).checks.find((c) => c.id === "price");
  results.push(
    assert(
      "drop: рост цены назван реальными ценами (585 → 690), а не средней за неделю",
      !!priceCheck?.conclusion.includes("с 585 до 690"),
      priceCheck?.conclusion
    )
  );

  // Падение без видимой причины: всё своё в порядке, не проверены конкуренты.
  // Агент не должен назначать причину, но должен назвать непроверенное.
  const unexplained = await diagnoseSalesDrop("ORT-LIP-MAT-01", 7);
  results.push(
    assert(
      "drop: падение без причины в данных — причина не назначается",
      unexplained.is_drop && unexplained.primary === null && unexplained.others.length === 0,
      { is_drop: unexplained.is_drop, primary: unexplained.primary?.id }
    ),
    assert(
      "drop: непроверенное (конкуренты) названо, а не спрятано",
      unexplained.no_data.some((c) => c.id === "competitors"),
      unexplained.no_data.map((c) => c.id)
    )
  );

  const control = await diagnoseSalesDrop("ORT-MAS-VOL-10", 7);
  results.push(
    assert(
      "drop: товар без падения — is_drop false и причина не назначается",
      !control.is_drop && control.primary === null,
      { is_drop: control.is_drop, primary: control.primary?.id }
    )
  );

  const anySku = await diagnoseSalesDrop("AVL-SER-NIAC-30", 7);
  results.push(
    assert(
      "drop: все 8 проверок выполнены в заданном порядке",
      anySku.checks.length === 8 && anySku.checks.every((c, i) => c.order === i + 1),
      anySku.checks.map((c) => `${c.order}.${c.id}`)
    ),
    assert(
      "drop: у каждой проверки есть данные, вывод и источник",
      anySku.checks.every((c) => c.data && c.conclusion && c.source),
      anySku.checks.filter((c) => !c.data || !c.conclusion || !c.source).map((c) => c.id)
    ),
    assert(
      "drop: конкуренты без MPSTATS — no_data, а не вывод",
      anySku.checks.find((c) => c.id === "competitors")?.status === "no_data",
      anySku.checks.find((c) => c.id === "competitors")?.status
    ),
    assert(
      "drop: проверка без данных не попадает в причины",
      anySku.no_data.every((c) => c.weight === 0) &&
        ![anySku.primary, ...anySku.others].some((c) => c?.status === "no_data"),
      anySku.no_data.map((c) => `${c.id}:${c.weight}`)
    ),
    assert(
      "drop: неизвестный артикул не выдумывает диагноз",
      (await diagnoseSalesDrop("НЕТ-ТАКОГО", 7)).status === "unknown_sku",
      (await diagnoseSalesDrop("НЕТ-ТАКОГО", 7)).status
    ),
    assert(
      "drop: ряд детерминирован — повторный запуск даёт тот же диагноз",
      JSON.stringify((await diagnoseSalesDrop("ORT-LIP-MAT-04", 7)).drop) ===
        JSON.stringify((await diagnoseSalesDrop("ORT-LIP-MAT-04", 7)).drop),
      null
    )
  );

  // ── План поставок ──
  // Проверяем не арифметику, а бизнес-решения: именно в них планировщик
  // ошибался при разработке, и ошибка выглядела правдоподобно.
  const plan = await planSupply();

  const scarce = plan.lines.filter((l) => l.offer_id === "ORT-LIP-MAT-04");
  const mat04Moscow = scarce.find((l) => l.cluster_id === "msk")?.qty ?? 0;
  const mat04Siberia = scarce.find((l) => l.cluster_id === "siberia")?.qty ?? 0;
  results.push(
    assert(
      "supply: дефицит идёт туда, где продаётся быстрее (Москва), а не туда, где пусто",
      mat04Moscow > 0 && mat04Siberia === 0,
      scarce.map((l) => `${l.cluster_id}:${l.qty}`)
    ),
    assert(
      "supply: при нехватке своего склада — потребность в производстве",
      plan.production.some((n) => n.offer_id === "ORT-LIP-MAT-04" && n.shortfall > 0),
      plan.production
    ),
    assert(
      "supply: остаток меньше короба всё равно отгружается, а не лежит",
      scarce.reduce((s, l) => s + l.qty, 0) === 30,
      scarce.reduce((s, l) => s + l.qty, 0)
    ),
    assert(
      "supply: в кластер с малым спросом не едет целый короб (год хранения)",
      plan.lines
        .filter((l) => l.daily_demand * 30 < 10)
        .every((l) => l.qty <= Math.ceil(l.daily_demand * (plan.target_days + l.transit_days)) + 1),
      plan.lines.filter((l) => l.daily_demand * 30 < 10).map((l) => `${l.offer_id}@${l.cluster_id}:${l.qty}`)
    ),
    assert(
      "supply: отгрузка не превышает собственный склад",
      [...new Set(plan.lines.map((l) => l.offer_id))].every((id) => {
        const shipped = plan.lines.filter((l) => l.offer_id === id).reduce((s, l) => s + l.qty, 0);
        const need = plan.production.find((n) => n.offer_id === id);
        return !need || shipped === need.own_stock;
      }),
      null
    ),
    assert(
      "supply: товар на нуле с готовой партией на своём складе — едет срочно",
      plan.lines.some((l) => l.offer_id === "AVL-SER-NIAC-30" && l.urgent),
      plan.lines.filter((l) => l.offer_id === "AVL-SER-NIAC-30").map((l) => `${l.cluster_id}:${l.urgent}`)
    ),
    assert(
      "supply: CSV открывается в Excel — BOM, «;», строка на каждую позицию",
      (() => {
        const csv = supplyPlanCsv(plan);
        return csv.startsWith("﻿") && csv.split("\r\n").filter(Boolean).length === plan.lines.length + 1;
      })(),
      null
    )
  );

  // ── Закономерности ──
  // Главное здесь — отрицательные случаи: закономерность, найденная там,
  // где её нет, хуже, чем никакой. Она уводит команду чинить не тот процесс.
  const patterns = await detectPatterns();
  const byId = (id: string) => patterns.find((p) => p.id === id);

  results.push(
    assert(
      "patterns: перекос в линейке помад — дефицит Berry и затоваривание Coral",
      !!byId("line_imbalance")?.skus.includes("ORT-LIP-MAT-04") &&
        !!byId("line_imbalance")?.skus.includes("ORT-LIP-MAT-07"),
      byId("line_imbalance")?.skus
    ),
    assert(
      "patterns: сбалансированная линейка (Vetiver 50/100) перекосом не считается",
      !patterns.some((p) => p.id === "line_imbalance" && p.skus.includes("NOI-EDP-VET-50")),
      patterns.filter((p) => p.id === "line_imbalance").map((p) => p.skus)
    ),
    assert(
      "patterns: все убыточные рекламы в акциях — одна закономерность, 17 642 ₽/мес",
      byId("promo_ads_stacking")?.skus.length === 3 &&
        byId("promo_ads_stacking")?.money.monthly_loss_rub === 17642,
      byId("promo_ads_stacking")?.money
    ),
    assert(
      "patterns: дефицитный товар в Москве — не «перекос», а правильное решение",
      !byId("regional_gap")?.skus.includes("ORT-LIP-MAT-04") &&
        !byId("regional_gap")?.skus.includes("AVL-SER-NIAC-30"),
      byId("regional_gap")?.skus
    ),
    assert(
      "patterns: заморожено 636 920 ₽ сверх трёх месяцев продаж",
      byId("overstock_capital")?.money.frozen_rub === 636920,
      byId("overstock_capital")?.money
    ),
    assert(
      "patterns: товар из перекоса линейки не дублируется в «замороженных деньгах»",
      !byId("overstock_capital")?.skus.includes("ORT-LIP-MAT-07"),
      byId("overstock_capital")?.skus
    ),
    assert(
      "patterns: у каждой — факт, гипотеза, действие и адресат",
      patterns.every((p) => p.headline && p.finding && p.hypothesis && p.action && p.owner),
      patterns.filter((p) => !p.headline || !p.owner).map((p) => p.id)
    ),
    assert(
      "patterns: процесс подан как гипотеза («похоже»), а не как факт",
      patterns.every((p) => /^Похоже/.test(p.hypothesis)),
      patterns.map((p) => p.hypothesis.slice(0, 20))
    ),
    assert(
      "patterns: сначала дороже — ранжирование по деньгам (месяц приведён к году)",
      patterns[0]?.id === "overstock_capital",
      patterns.map((p) => p.id)
    )
  );

  // Один товар в акции с убыточной рекламой — ещё не практика компании.
  const single = await detectPatterns({
    tools: toolsFor([
      product({ offer_id: "A", ad_spend_30d: 10_000, ad_orders_30d: 10, in_promo: true }),
      product({ offer_id: "B" }),
    ]),
  });
  results.push(
    assert(
      "patterns: одно совпадение — не закономерность",
      !single.some((p) => p.id === "promo_ads_stacking"),
      single.map((p) => p.id)
    )
  );

  // Нет себестоимости — рубли неизвестны, а не ноль.
  const noCostPatterns = await detectPatterns({
    tools: toolsFor([
      product({ offer_id: "X1", stock: 900, orders_30d: 3, cost_price: null }),
      product({ offer_id: "X2", stock: 800, orders_30d: 2, cost_price: null }),
    ]),
  });
  results.push(
    assert(
      "patterns: без себестоимости «заморожено» — неизвестно, а не 0 ₽",
      noCostPatterns.find((p) => p.id === "overstock_capital")?.money.frozen_rub === null,
      noCostPatterns.map((p) => ({ id: p.id, money: p.money }))
    )
  );

  // Вопрос про сток не должен тащить в ответ закономерность про рекламу.
  const stockScan = await runStoreScan({ question: "что со стоком?" });
  results.push(
    assert(
      "patterns: в ответе на вопрос про сток нет закономерности маркетинга",
      stockScan.patterns.length > 0 && !stockScan.patterns.some((p) => p.owner === "маркетинг"),
      stockScan.patterns.map((p) => p.owner)
    )
  );

  // ── Большой кабинет: живой слой собирает весь ассортимент ──
  // Регрессия: список товаров шёл одной страницей на 100, заказы — одной на
  // 1000 строк. На 3000 SKU агент молча видел бы 100 товаров, а у остальных
  // заказы стали бы нулём. Ozon подменён: ключей нет, проверяем постраничность.
  {
    const N = 2500;
    const client = ozon as unknown as { post: unknown };
    const original = client.post;
    client.post = async (url: string, body: { last_id?: string; limit: number; offset: number; offer_id: string[] }) => {
      if (url === "/v3/product/list") {
        const start = body.last_id ? Number(body.last_id) : 0;
        const items = Array.from({ length: Math.min(body.limit, N - start) }, (_, i) => ({
          product_id: start + i,
          offer_id: `SKU-${start + i}`,
        }));
        return { data: { result: { items, total: N, last_id: String(start + items.length) } } };
      }
      if (url === "/v3/product/info/list") {
        if (body.offer_id.length > 1000) throw new Error("больше 1000 артикулов в одном запросе");
        return {
          data: {
            items: body.offer_id.map((id) => ({ offer_id: id, sku: Number(id.slice(4)), price: "100" })),
          },
        };
      }
      const rows = Array.from({ length: Math.min(body.limit, N - body.offset) }, (_, i) => ({
        dimensions: [{ id: String(body.offset + i) }],
        metrics: [7],
      }));
      return { data: { result: { data: rows } } };
    };
    const live = await getProductsDetailed();
    client.post = original;
    results.push(
      assert(
        "scale: живой слой забирает весь ассортимент постранично (2500 из 2500)",
        live.length === N,
        live.length
      ),
      assert(
        "scale: заказы из аналитики есть у всех SKU, а не у первой тысячи",
        live.every((p) => p.orders_30d === 7),
        live.filter((p) => p.orders_30d !== 7).length
      )
    );
  }

  // ── Цена слишком низкая ──
  // Случай из практики: БАД за 700 ₽ продавался плохо, за 2000 ₽ — пошёл.
  // В моке его аналог — сыворотка с ретинолом за 690 ₽ при нише ~1700 ₽.
  const PRICE_LOW = "pricing/price-too-low.md";
  results.push(
    assert(
      "price-low: «стоит ли поднять цену?» → юнит заниженной цены",
      matchUnits("стоит ли поднять цену?")[0]?.unit.id === "pricing.price-too-low",
      matchUnits("стоит ли поднять цену?").map((m) => m.unit.id)
    )
  );
  const reti = await runDiagnosis({
    question: "цена",
    unitPath: PRICE_LOW,
    productRef: { offer_id: "AVL-SER-RETI-30" },
  });
  results.push(
    assert(
      "price-low: ретинол — дешевле ниши и реклама в минус → нельзя растить при такой цене",
      reti.diagnosis?.matched_rule === "underpriced_cant_promote",
      reti.diagnosis?.matched_rule
    ),
    assert(
      "price-low: при цене нижней границы ниши достаточно сохранить 28% заказов",
      reti.formulas.some((f) => f.formula_id === "price_test_breakeven" && f.value === 28),
      reti.formulas.filter((f) => f.formula_id === "price_test_breakeven")
    ),
    assert(
      "price-low: в доказательной базе есть сами цены — наша и нижняя граница ниши",
      ["price", "market_low_price", "price_test_breakeven"].every((id) =>
        reti.diagnosis?.used_metrics.includes(id)
      ),
      reti.diagnosis?.used_metrics
    )
  );

  // Ложное «поднимите цену» опаснее, чем никакого: из 25 SKU срабатывает
  // только тот, где это заложено.
  const priceScan = await runStoreScan({ question: "где мы продаём слишком дёшево?", limit: 50 });
  results.push(
    assert(
      "price-low: по всему ассортименту — только ретинол, без ложных срабатываний",
      priceScan.findings.length === 1 && priceScan.findings[0].product.offer_id === "AVL-SER-RETI-30",
      priceScan.findings.map((f) => `${f.product.offer_id}:${f.diagnosis.matched_rule}`)
    )
  );

  // У каждого товара — своя ниша: палетку больше не сравнивают с сыворотками.
  const palette = await runDiagnosis({
    question: "цена",
    unitPath: PRICE_LOW,
    productRef: { offer_id: "ORT-EYE-PAL-12" },
  });
  const pvm = palette.metrics.find((m) => m.metric_id === "price_vs_market")?.value;
  results.push(
    assert(
      "market: палетка сравнивается со своей нишей (±25%), а не с сыворотками",
      typeof pvm === "number" && Math.abs(pvm) <= 25,
      pvm
    )
  );

  // Без внешнего рынка (живой режим, MPSTATS нет) рекомендовать подъём
  // цены нельзя — но и молчать нельзя: сказать, что выбрать не из чего.
  const noMarket: ToolRunner = async (tool, context) =>
    tool === "search_competitors"
      ? { tool, state: "forbidden_no_subscription", data: null }
      : toolsFor([product({ ad_spend_30d: 10_000, ad_orders_30d: 10 })])(tool, context);
  const blind = await runDiagnosis({ question: "цена", unitPath: PRICE_LOW, tools: noMarket });
  results.push(
    assert(
      "price-low: без цен ниши — не «поднимите цену», а «выбрать не из чего»",
      blind.diagnosis?.matched_rule === "margin_cant_fund_ads",
      blind.diagnosis?.matched_rule
    )
  );

  // ── Сезонность ──
  // Дата фиксирована: иначе результат менялся бы в зависимости от месяца запуска.
  const autumn = await planSupply({ today: new Date("2026-09-30") });
  const spring = await planSupply({ today: new Date("2026-04-15") });
  const vet = autumn.seasonal_production.find((n) => n.offer_id === "NOI-EDP-VET-50");
  results.push(
    assert(
      "season: парфюм в сентябре — по темпу хватает, с учётом декабря нет; запускать сейчас",
      !!vet && vet.demand_naive <= vet.stock_total && vet.demand_seasonal > vet.stock_total && vet.peak_month === "декабрь",
      vet
    ),
    assert(
      "season: весной парфюм к производству не рвётся — пика впереди нет",
      !spring.seasonal_production.some((n) => n.offer_id.startsWith("NOI-")),
      spring.seasonal_production.map((n) => n.offer_id)
    ),
    assert(
      "season: SPF-крем осенью везём меньше обычного, весной — больше",
      autumn.lines.filter((l) => l.offer_id === "AVL-CRM-DAY-50").every((l) => l.season_factor < 1) &&
        spring.lines.filter((l) => l.offer_id === "AVL-CRM-DAY-50").every((l) => l.season_factor > 1) &&
        spring.lines.some((l) => l.offer_id === "AVL-CRM-DAY-50"),
      {
        autumn: autumn.lines.filter((l) => l.offer_id === "AVL-CRM-DAY-50").map((l) => l.season_factor),
        spring: spring.lines.filter((l) => l.offer_id === "AVL-CRM-DAY-50").map((l) => l.season_factor),
      }
    ),
    assert(
      "season: к производству только то, что меняет сезон (дефицитные без сезона — в других находках)",
      autumn.seasonal_production.every((n) => n.demand_naive <= n.stock_total),
      autumn.seasonal_production.map((n) => `${n.offer_id}:${n.demand_naive}/${n.stock_total}`)
    )
  );

  const passed = results.every(Boolean);
  console.log(
    `\n${passed ? "EVAL PASSED" : "EVAL FAILED"} (${results.filter(Boolean).length}/${results.length})`
  );
  process.exit(passed ? 0 : 1);
}

main();
