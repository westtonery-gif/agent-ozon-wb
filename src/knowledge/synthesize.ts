// LLM synthesis: превращает готовый диагноз в ответ менеджеру.
// Модель получает ТОЛЬКО факты (метрики), выходы формул и вывод движка.
// Запрещено: считать, выдумывать цифры, делать выводы вне diagnosis.
import OpenAI from "openai";
import { OZONOLOGIST_DOMAIN } from "../agents/ozonologist";
import type { DiagnosticSession, StoreScan } from "./types";

// Клиент создаётся при первом вызове, а не при загрузке модуля: иначе
// `next build` без OPENAI_API_KEY падает на сборе данных страниц, хотя ключ
// нужен только в рантайме (и сборка на CI/Vercel его обычно не видит).
let _openai: OpenAI | null = null;

function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Не задан OPENAI_API_KEY — ответ сформулировать нечем.");
  }
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const RULES = `
КАК ТЫ ОТВЕЧАЕШЬ
- Все числа уже посчитаны детерминированным движком. Бери их как есть.
  Ничего не считай сам и не выводи новых цифр — даже простых процентов.
- Не добавляй причин и метрик, которых нет во входных данных.
  Вывод движка (diagnosis) — граница твоих утверждений.
- Метрика со статусом unknown или unavailable — это «нет данных», а не ноль.
  Так и говори, и называй, что нужно подключить.
- Рекомендация должна быть действием менеджера с конкретикой из данных:
  какой SKU, что сделать, к какому сроку. Без «оптимизировать» и «поработать над».
- Кратко, по делу, русский язык. Тон практикующего менеджера маркетплейсов.
`;

const SINGLE_SYSTEM = `${OZONOLOGIST_DOMAIN}\n${RULES}`;

const SCAN_SYSTEM = `${OZONOLOGIST_DOMAIN}
${RULES}

ФОРМАТ ОБХОДА АССОРТИМЕНТА
Тебе дают список находок по товарам, уже отсортированный по критичности.
- Начни с одной строки: сколько SKU проверено и что горит в первую очередь.
- Дальше разбери находки по убыванию важности, группируя одинаковые проблемы.
  По каждой: SKU, цифра из evidence, что делать.
- Не перечисляй товары без находок — движок их уже отфильтровал.
- В конце, если список unavailable_metrics не пуст, одной строкой скажи,
  какие выводы остались недоступны и что для них нужно подключить.
`;

export async function synthesize(session: DiagnosticSession): Promise<string> {
  if (session.status === "data_unavailable") {
    return `Недостаточно данных для диагноза. Недоступны метрики: ${session.missing_metrics.join(
      ", "
    )}. Подключи их (подписка/аналитика), тогда дам вывод.`;
  }

  const facts = {
    diagnosis: session.diagnosis,
    metrics: session.metrics.map((m) => ({ id: m.metric_id, value: m.value, status: m.status })),
    formulas: session.formulas.map((f) => ({ id: f.formula_id, value: f.value, status: f.status })),
    confidence: session.confidence,
  };

  const completion = await client().chat.completions.create({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: SINGLE_SYSTEM },
      {
        role: "user",
        content: `Вопрос: ${session.question}\n\nДИАГНОЗ (JSON):\n${JSON.stringify(
          facts,
          null,
          2
        )}\n\nСформулируй ответ менеджеру.`,
      },
    ],
  });

  return completion.choices[0].message.content ?? "";
}

export async function synthesizeScan(scan: StoreScan): Promise<string> {
  if (scan.status === "data_unavailable") {
    return "Не удалось получить данные магазина — ответ был бы догадкой. Проверьте доступ к Ozon и повторите.";
  }
  if (scan.status === "needs_metrics") {
    return "В кабинете не найдено товаров для анализа.";
  }
  if (scan.status === "no_findings") {
    return `Проверено ${scan.products_scanned} SKU по правилам: ${scan.units.join(
      ", "
    )}. Отклонений, требующих действия, не найдено.`;
  }

  const facts = {
    products_scanned: scan.products_scanned,
    units_applied: scan.units,
    findings: scan.findings.map((f) => ({
      sku: f.product.offer_id,
      name: f.product.name,
      brand: f.product.brand,
      rule: f.diagnosis.matched_rule,
      severity: f.diagnosis.severity,
      funnel_stage: f.diagnosis.funnel_stage,
      finding: f.diagnosis.findings[0],
      evidence: f.evidence.map((m) => ({ id: m.metric_id, value: m.value })),
    })),
    unavailable_metrics: scan.unavailable_metrics,
  };

  const completion = await client().chat.completions.create({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: SCAN_SYSTEM },
      {
        role: "user",
        content: `Вопрос: ${scan.question}\n\nНАХОДКИ (JSON):\n${JSON.stringify(
          facts,
          null,
          2
        )}\n\nСформулируй ответ менеджеру.`,
      },
    ],
  });

  return completion.choices[0].message.content ?? "";
}
