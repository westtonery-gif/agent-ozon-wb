// Загрузка Knowledge Core: taxonomy / metrics / formulas / unit-файлы.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as yaml from "js-yaml";

const ROOT = join(process.cwd(), "knowledge");

function loadYaml<T>(relPath: string): T {
  return yaml.load(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

export interface MetricDef {
  source: string;
  tool?: string;
  scope?: "product" | "store";
  field?: string;
  aggregation?: "avg" | "min";
  formula?: string;
  inputs?: string[];
  type: string;
  unit: string;
  availability: string;
}

export interface FormulaDef {
  description: string;
  inputs: string[];
  output: { id: string; type: string; unit: string };
}

export interface DiagnosisRule {
  id: string;
  priority: number;
  conditions: Array<{ metric: string; op: string; value?: number; value_metric?: string }>;
  outcome: {
    funnel_stage: string;
    primary_unit: string | null;
    severity: string;
    confidence: string;
    finding: string;
  };
}

export interface KnowledgeUnit {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  required_metrics: string[];
  diagnosis_rules: DiagnosisRule[];
}

interface Taxonomy {
  severity_levels: Record<string, { rank: number; meaning: string }>;
  confidence_levels: Record<string, { rank: number; meaning: string }>;
}

let _metrics: Record<string, MetricDef> | null = null;
let _formulas: Record<string, FormulaDef> | null = null;
let _taxonomy: Taxonomy | null = null;

export function taxonomy(): Taxonomy {
  if (!_taxonomy) _taxonomy = loadYaml<Taxonomy>("taxonomy.yaml");
  return _taxonomy;
}

// Вес severity для сортировки находок. Единый словарь живёт в taxonomy.yaml,
// чтобы порядок важности не разъехался между юнитами и кодом.
export function severityRank(severity: string): number {
  return taxonomy().severity_levels[severity]?.rank ?? 0;
}

export function metricsCatalog(): Record<string, MetricDef> {
  if (!_metrics) _metrics = loadYaml<{ metrics: Record<string, MetricDef> }>("metrics.yaml").metrics;
  return _metrics;
}

export function formulasCatalog(): Record<string, FormulaDef> {
  if (!_formulas) _formulas = loadYaml<{ formulas: Record<string, FormulaDef> }>("formulas.yaml").formulas;
  return _formulas;
}

// Разбор unit-файла: YAML-фронтматтер между --- ... ---
export function loadUnit(relPath: string): KnowledgeUnit {
  const raw = readFileSync(join(ROOT, "units", relPath), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error(`Нет фронтматтера в юните: ${relPath}`);
  return yaml.load(m[1]) as KnowledgeUnit;
}

// Все юниты каталога. Роутер сопоставляет вопрос с их собственными keywords,
// поэтому новый .md-файл подключается сам — без правок в коде.
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith(".md") ? [full] : [];
  });
}

let _units: Array<{ path: string; unit: KnowledgeUnit }> | null = null;

export function listUnits(): Array<{ path: string; unit: KnowledgeUnit }> {
  if (_units) return _units;
  const base = join(ROOT, "units");
  _units = walk(base)
    .map((full) => {
      const path = relative(base, full).split(/[\\/]/).join("/");
      return { path, unit: loadUnit(path) };
    })
    // Порядок каталога зависит от файловой системы — фиксируем по id,
    // чтобы одинаковый вопрос всегда давал одинаковый юнит.
    .sort((a, b) => a.unit.id.localeCompare(b.unit.id));
  return _units;
}
