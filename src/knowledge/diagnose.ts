// Diagnosis runner: применяет diagnosis_rules юнита к метрикам.
// Правила по убыванию priority, первое совпавшее = primary.
import type { KnowledgeUnit, DiagnosisRule } from "./load";
import type { MetricBundle, Diagnosis } from "./types";

type Cond = DiagnosisRule["conditions"][number];

function condOk(cond: Cond, bundle: MetricBundle): boolean {
  const m = bundle[cond.metric];
  const known = m && m.status === "known" && typeof m.value === "number";
  const v = known ? (m!.value as number) : null;
  const rhsMetric = cond.value_metric ? bundle[cond.value_metric] : undefined;
  const rhs =
    rhsMetric && rhsMetric.status === "known" && typeof rhsMetric.value === "number"
      ? rhsMetric.value
      : cond.value;

  switch (cond.op) {
    case "not_null":
      return known;
    case "is_null":
      return !m || m.status !== "known" || m.value === null;
    case "eq":
      return known && rhs !== undefined && v === rhs;
    case "ne":
      return known && rhs !== undefined && v !== rhs;
    case "lt":
      return known && rhs !== undefined && v! < rhs;
    case "lte":
      return known && rhs !== undefined && v! <= rhs;
    case "gt":
      return known && rhs !== undefined && v! > rhs;
    case "gte":
      return known && rhs !== undefined && v! >= rhs;
    default:
      return false;
  }
}

export function diagnose(unit: KnowledgeUnit, bundle: MetricBundle): Diagnosis {
  const rules = [...unit.diagnosis_rules].sort((a, b) => b.priority - a.priority);
  for (const rule of rules) {
    const allOk = rule.conditions.every((c) => condOk(c, bundle));
    if (allOk) {
      // Доказательная база: метрики, названные условиями этого правила
      // (включая правую часть сравнений вида value_metric).
      const used = new Set<string>();
      for (const c of rule.conditions) {
        used.add(c.metric);
        if (c.value_metric) used.add(c.value_metric);
      }
      return {
        matched_rule: rule.id,
        funnel_stage: rule.outcome.funnel_stage,
        primary_unit: rule.outcome.primary_unit,
        severity: rule.outcome.severity,
        confidence: rule.outcome.confidence,
        findings: [rule.outcome.finding],
        used_metrics: [...used],
      };
    }
  }
  // fallback на случай отсутствия правила без условий
  return {
    matched_rule: "none",
    funnel_stage: "unknown",
    primary_unit: null,
    severity: "low",
    confidence: "low",
    findings: ["Ни одно правило не сработало."],
    used_metrics: [],
  };
}
