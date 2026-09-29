// Diagnostic Runtime: вопрос → юнит(ы) → метрики → формулы → диагноз.
// Оркестрация ДЕТЕРМИНИРОВАННА (не LLM). LLM подключается только на synthesis.
import { listUnits, loadUnit, severityRank, type KnowledgeUnit } from "./load";
import { resolveMetrics } from "./resolver";
import { diagnose } from "./diagnose";
import { memoizeTools, realToolRunner } from "./tools";
import { detectPatterns, type Pattern } from "./patterns";
import type {
  DiagnosticSession,
  ProductRef,
  ScanFinding,
  ScannedProduct,
  StoreScan,
  ToolRunner,
} from "./types";

// Сопоставление вопроса с юнитами по их собственным keywords (frontmatter).
// Балл = число попавших ключей; юнит без попаданий не берём.
// «ё» и «е» в вопросе пользователя равнозначны: «плохо продается» и
// «плохо продаётся» — один и тот же вопрос, и юнит не должен зависеть от раскладки.
const normalize = (s: string) => s.toLowerCase().replace(/ё/g, "е");

export function matchUnits(question: string): Array<{ path: string; unit: KnowledgeUnit }> {
  const q = normalize(question);
  return listUnits()
    .map((entry) => ({
      ...entry,
      score: (entry.unit.keywords ?? []).filter((k) => q.includes(normalize(k))).length,
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.unit.id.localeCompare(b.unit.id))
    .map(({ path, unit }) => ({ path, unit }));
}

interface RunOpts {
  question: string;
  productRef?: ProductRef; // { offer_id?, sku? }; если нет — resolver берёт первый товар
  tools?: ToolRunner; // eval подменяет на mock
  unitPath?: string; // явный юнит; иначе выбирает роутер
}

// Один товар, один юнит. Используется точечными вопросами и офлайн-эвалом.
export async function runDiagnosis(opts: RunOpts): Promise<DiagnosticSession> {
  const { question, productRef, tools } = opts;

  const unitPath = opts.unitPath ?? matchUnits(question)[0]?.path;
  if (!unitPath) {
    return {
      question,
      product_ref: productRef,
      intent: { scenario: "none", unit_id: null },
      metrics: [],
      formulas: [],
      diagnosis: null,
      status: "no_match",
      missing_metrics: [],
      confidence: "low",
    };
  }

  const unit = loadUnit(unitPath);

  // Резолв required_metrics (+ их inputs) и формулы.
  const { bundle, formulas } = await resolveMetrics(unit.required_metrics, {
    productRef,
    tools,
  });

  const metrics = unit.required_metrics.map((id) => bundle[id]).filter(Boolean);
  const missing_metrics = unit.required_metrics.filter((id) => bundle[id]?.status !== "known");
  const unavailable = unit.required_metrics.filter((id) => bundle[id]?.status === "unavailable");

  const diagnosis = diagnose(unit, bundle);

  // Статус сессии: если диагноз неопределённый — различаем «нет данных» и «нужны данные».
  let status: DiagnosticSession["status"] = "complete";
  if (!diagnosis.primary_unit) {
    status = unavailable.length ? "data_unavailable" : "needs_metrics";
  }

  return {
    question,
    product_ref: productRef,
    intent: { scenario: unit.category, unit_id: unit.id },
    metrics,
    formulas,
    diagnosis,
    status,
    missing_metrics,
    confidence: diagnosis.confidence,
  };
}

// Какие отделы относятся к вопросу. На «что со стоком?» закономерность про
// рекламу в акциях — не ответ; на «проанализируй магазин» — все.
const OWNERS_BY_CATEGORY: Record<string, string[]> = {
  inventory: ["производство", "логистика", "коммерция"],
  pricing: ["маркетинг", "коммерция"],
  traffic: ["маркетинг", "логистика"],
  competition: ["маркетинг"],
  diagnostics: ["производство", "логистика", "коммерция", "маркетинг"],
};

interface ScanOpts {
  question: string;
  tools?: ToolRunner;
  limit?: number; // сколько находок вернуть
}

// Обход ассортимента: каждый подходящий юнит применяется к каждому товару.
// Возвращает только находки (правило со своим primary_unit), отсортированные
// по severity — то есть список «что горит», а не отчёт по всем SKU.
export async function runStoreScan(opts: ScanOpts): Promise<StoreScan> {
  const { question, limit = 8 } = opts;
  const runTool = memoizeTools(opts.tools ?? realToolRunner);

  // Если вопрос не попал ни в один юнит — это «проанализируй магазин», обходим
  // всеми предметными юнитами. Кросс-диагностические (category: diagnostics)
  // из общего обхода исключены: они повторяют выводы предметных и дали бы
  // по два одинаковых findings на один SKU. По прямому вопросу они работают.
  const matched = matchUnits(question);
  const units = matched.length
    ? matched.map((e) => e.unit)
    : listUnits()
        .map((e) => e.unit)
        .filter((u) => u.category !== "diagnostics");

  const listing = await runTool("get_products");
  const rows =
    ((listing.data as { products?: Array<Record<string, unknown>> })?.products ?? []);

  if (listing.state !== "ok" || rows.length === 0) {
    return {
      question,
      scope: "store",
      units: units.map((u) => u.id),
      products_scanned: 0,
      products: [],
      findings: [],
      unavailable_metrics: [],
      patterns: [],
      status: listing.state === "ok" ? "needs_metrics" : "data_unavailable",
    };
  }

  const products: ScannedProduct[] = rows.map((r) => ({
    offer_id: String(r.offer_id ?? ""),
    name: typeof r.name === "string" ? r.name : String(r.offer_id ?? ""),
    brand: typeof r.brand === "string" ? r.brand : null,
  }));

  const findings: ScanFinding[] = [];
  const unavailable = new Set<string>();

  for (const product of products) {
    const ref: ProductRef = { offer_id: product.offer_id };
    for (const unit of units) {
      const { bundle } = await resolveMetrics(unit.required_metrics, {
        productRef: ref,
        tools: runTool,
      });
      for (const id of unit.required_metrics) {
        if (bundle[id]?.status === "unavailable") unavailable.add(id);
      }
      const diagnosis = diagnose(unit, bundle);
      // primary_unit = null — правило «всё в норме»; в список находок не попадает.
      if (!diagnosis.primary_unit) continue;
      findings.push({
        product,
        unit_id: unit.id,
        diagnosis,
        // В ответ уходят только метрики, на которых сработало правило: модель
        // не должна видеть лишние числа, чтобы не строить на них выводы.
        evidence: diagnosis.used_metrics
          .map((id) => bundle[id])
          .filter((m) => m && m.status === "known"),
      });
    }
  }

  findings.sort(
    (a, b) =>
      severityRank(b.diagnosis.severity) - severityRank(a.diagnosis.severity) ||
      a.product.offer_id.localeCompare(b.product.offer_id)
  );

  // Закономерности считаются по тем же инструментам (runTool мемоизирован —
  // Ozon второй раз не дёргаем) и фильтруются по отделам, к которым относится вопрос.
  const owners = new Set(
    matched.length
      ? units.flatMap((u) => OWNERS_BY_CATEGORY[u.category] ?? [])
      : Object.values(OWNERS_BY_CATEGORY).flat()
  );
  const patterns: Pattern[] = (await detectPatterns({ tools: runTool })).filter((p) =>
    owners.has(p.owner)
  );

  return {
    question,
    scope: "store",
    units: units.map((u) => u.id),
    products_scanned: products.length,
    products,
    findings: findings.slice(0, limit),
    unavailable_metrics: [...unavailable],
    patterns,
    status: findings.length || patterns.length ? "complete" : "no_findings",
  };
}
