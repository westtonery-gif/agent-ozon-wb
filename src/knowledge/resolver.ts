// Metric Resolver: metric_id → metrics.yaml → tool → MetricResult.
// Knowledge Layer НИКОГДА не трогает Ozon напрямую — только через этот слой.
import { metricsCatalog, formulasCatalog, type MetricDef } from "./load";
import { realToolRunner } from "./tools";
import { compute } from "./formulas";
import type {
  MetricBundle,
  MetricResult,
  MetricStatus,
  MetricSource,
  ProductRef,
  ToolContext,
  ToolResult,
  ToolRunner,
} from "./types";

const now = () => new Date().toISOString();

// Ошибка инструмента → статус метрики. Права/подписка = unavailable (нет данных
// и не будет), сеть/лимит/пусто = unknown (данные могли бы быть).
function toolStateToStatus(state: ToolResult["state"]): MetricStatus {
  if (state === "unauthorized" || state === "forbidden_no_subscription") return "unavailable";
  if (state === "ok") return "known";
  return "unknown";
}

interface ResolveOpts {
  productRef?: ProductRef;
  tools?: ToolRunner;
}

// Найти строку товара по offer_id/sku, иначе первый.
function pickProduct(
  list: Array<Record<string, unknown>>,
  ref?: ProductRef
): Record<string, unknown> | undefined {
  return (
    list.find(
      (p) =>
        (ref?.offer_id && p.offer_id === ref.offer_id) ||
        (ref?.sku !== undefined && p.sku === ref.sku)
    ) ?? list[0]
  );
}

// Собрать контекст товара из результата get_products (title/category/price).
function buildContext(tr: ToolResult | undefined, ref?: ProductRef): ToolContext | undefined {
  if (!tr || tr.state !== "ok") return undefined;
  const list = ((tr.data as { products?: Array<Record<string, unknown>> })?.products) ?? [];
  const row = pickProduct(list, ref);
  if (!row) return undefined;
  return {
    title: typeof row.name === "string" ? row.name : undefined,
    category: typeof row.category === "string" ? row.category : null,
    price: typeof row.price === "number" ? row.price : undefined,
    offer_id: typeof row.offer_id === "string" ? row.offer_id : undefined,
    sku: typeof row.sku === "number" ? row.sku : undefined,
  };
}

export async function resolveMetrics(
  metricIds: string[],
  opts: ResolveOpts = {}
): Promise<{ bundle: MetricBundle; formulas: ReturnType<typeof compute>[] }> {
  const catalog = metricsCatalog();
  const formulas = formulasCatalog();
  const runTool = opts.tools ?? realToolRunner;

  // 1. Развернуть: для calculated-метрик нужны их базовые inputs.
  const needed = new Set<string>();
  const addNeeded = (id: string) => {
    needed.add(id);
    const def = catalog[id];
    if (def?.source === "calculated") def.inputs?.forEach(addNeeded);
  };
  metricIds.forEach(addNeeded);

  // 2. Батч: какие инструменты вызвать (по одному разу).
  const toolIds = new Set<string>();
  for (const id of needed) {
    const def = catalog[id];
    if (
      (def?.source === "seller_api" || def?.source === "external_market") &&
      def.tool
    )
      toolIds.add(def.tool);
  }
  // get_products вызываем ПЕРВЫМ — из него строим ToolContext (title/category/price)
  // для контекстных инструментов (search_competitors).
  const ordered = [...toolIds].sort((a, b) =>
    a === "get_products" ? -1 : b === "get_products" ? 1 : 0
  );
  const toolResults = new Map<string, ToolResult>();
  let context: ToolContext | undefined;
  for (const t of ordered) {
    toolResults.set(t, await runTool(t, context));
    if (t === "get_products") context = buildContext(toolResults.get(t), opts.productRef);
  }

  const bundle: MetricBundle = {};

  // 3. Базовые (seller_api / external_market).
  const resolveBase = (id: string, def: MetricDef): MetricResult => {
    const tr = def.tool ? toolResults.get(def.tool) : undefined;
    const base: MetricResult = {
      metric_id: id,
      value: null,
      status: "unknown",
      source: def.source as MetricSource,
      tool: def.tool,
      timestamp: now(),
    };
    if (!tr) return base;
    const status = toolStateToStatus(tr.state);
    if (status !== "known") return { ...base, status };

    const data = tr.data as Record<string, unknown> | Array<Record<string, unknown>> | null;
    let raw: unknown;
    if (Array.isArray(data) && def.aggregation === "avg") {
      const nums = data
        .map((row) => row[def.field ?? ""])
        .filter((v): v is number => typeof v === "number");
      raw =
        nums.length > 0
          ? Number((nums.reduce((sum, v) => sum + v, 0) / nums.length).toFixed(2))
          : null;
    } else if (def.scope === "product" && !Array.isArray(data)) {
      const list = (data?.products as Array<Record<string, unknown>>) ?? [];
      const row = pickProduct(list, opts.productRef);
      raw = row?.[def.field ?? ""];
    } else if (!Array.isArray(data)) {
      raw = data?.[def.field ?? ""];
    }
    if (typeof raw === "number") return { ...base, value: raw, status: "known" };
    return { ...base, value: null, status: "unknown" }; // поле пусто → неизвестно (не 0)
  };

  const formulaResults: ReturnType<typeof compute>[] = [];

  // 4. Резолв: сначала базовые, затем calculated (их inputs уже готовы).
  for (const id of needed) {
    const def = catalog[id];
    if (!def) {
      bundle[id] = { metric_id: id, value: null, status: "unknown", source: "seller_api", timestamp: now() };
      continue;
    }
    if (def.source === "seller_api" || def.source === "external_market") {
      bundle[id] = resolveBase(id, def);
    }
  }
  // Глубина зависимости calculated-метрики. Формула может опираться на выход
  // другой формулы (unit_margin → margin_pct, cpo → ad_margin_gap), поэтому
  // считаем в порядке возрастания глубины: иначе вход ещё не посчитан и
  // метрика ложно становится unavailable.
  const depth = (id: string, seen: Set<string> = new Set()): number => {
    const def = catalog[id];
    if (!def || def.source !== "calculated" || seen.has(id)) return 0;
    const inputs = def.inputs ?? [];
    return 1 + Math.max(0, ...inputs.map((i) => depth(i, new Set([...seen, id]))));
  };

  const calculatedIds = [...needed]
    .filter((id) => catalog[id]?.source === "calculated" && catalog[id]?.formula)
    .sort((a, b) => depth(a) - depth(b));

  for (const id of calculatedIds) {
    const def = catalog[id];
    const fdef = formulas[def.formula!];
    // Выравниваем: имена входов формулы ↔ metric_id из def.inputs по индексу.
    const inputMap: Record<string, MetricResult> = {};
    fdef.inputs.forEach((name, i) => {
      const srcId = def.inputs?.[i];
      if (srcId) inputMap[name] = bundle[srcId];
    });
    const fr = compute(def.formula!, inputMap);
    formulaResults.push(fr);
    bundle[id] = {
      metric_id: id,
      value: fr.value,
      status: fr.status,
      source: "calculated",
      timestamp: now(),
    };
  }

  return { bundle, formulas: formulaResults };
}
