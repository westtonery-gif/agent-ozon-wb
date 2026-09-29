// LLM synthesis: превращает готовый диагноз в ответ менеджеру.
// Модель получает ТОЛЬКО факты (метрики), выходы формул и вывод движка.
// Запрещено: считать, выдумывать цифры, делать выводы вне diagnosis.
import OpenAI from "openai";
import { OZONOLOGIST_DOMAIN } from "../agents/ozonologist";
import type { SalesDropReport } from "./sales-drop";
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
ЧТО ТЕБЕ МОЖНО
- Все числа уже посчитаны детерминированным движком. Бери их как есть.
  Ничего не считай сам и не выводи новых цифр — даже простых процентов.
- Не добавляй причин и метрик, которых нет во входных данных.
  Вывод движка — граница твоих утверждений.
- Метрика со статусом unknown или unavailable — это «нет данных», а не ноль.
  Так и говори, и называй, что нужно подключить.

КАК ТЫ ПИШЕШЬ
- Коротко. Длинный ответ — это не старательность, а неуважение ко времени.
- Как коллега в рабочем чате: короткими предложениями, по-человечески.
- Запрещено: приветствия, «давайте разберёмся», «важно отметить», «в целом»,
  «надеюсь, это поможет», пересказ вопроса, описание того, что ты сейчас сделаешь,
  и предложения помощи в конце. Начинай сразу с сути.
- Без списков там, где хватает одной фразы. Без заголовков в коротком ответе.
- Рекомендация — это действие: какой SKU, что сделать, к какому сроку.
  Не «оптимизировать», не «поработать над карточкой», не «рассмотреть возможность».
- Русский язык.
`;

const SINGLE_SYSTEM = `${OZONOLOGIST_DOMAIN}\n${RULES}`;

const SCAN_SYSTEM = `${OZONOLOGIST_DOMAIN}
${RULES}

ФОРМАТ ОБХОДА АССОРТИМЕНТА
Тебе дают находки по товарам, отсортированные по критичности.
- Первая строка: сколько SKU проверено и сколько требует действия.
- Дальше только critical и high, сгруппированные по типу проблемы.
  По каждой: SKU, цифра, что сделать. Одна строка на находку.
- Medium не расписывай — сверни в одну строку вида
  «Ещё N находок пониже приоритетом — по запросу».
- Товары без находок не упоминай вовсе.
- Если unavailable_metrics не пуст — одна строка в конце, что недоступно.
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

// ── Режим «Диагностика падения продаж» ───────────────────────────────────

const DROP_SYSTEM = `${OZONOLOGIST_DOMAIN}
${RULES}

ФОРМАТ ДИАГНОСТИКИ ПАДЕНИЯ
Короткий ответ (по умолчанию), максимум 6 строк:
1. Что упало и насколько — одно предложение с цифрами и датой начала.
2. Главная вероятная причина: цифра, из которой она следует, и почему это она.
3. Что сделать — одно конкретное действие.
4. Когда перепроверить.
5. Последняя строка: сколько ещё причин найдено и сколько проверок без данных,
   с пометкой, что детали — по запросу. Сами причины НЕ раскрывать.

Если просят подробности — разбери каждую проверку одной строкой в формате
«проверка: данные → вывод», включая те, где данных нет. Не раздувай.

Причина названа вероятной, а не доказанной: ранжирование — это сила сигнала,
а не измеренный вклад. Не пиши «именно из-за этого».

Если падения нет (is_drop = false) — НЕ называй главную причину. Скажи, что
значимого падения нет, и, если проверки что-то нашли, назови это замечаниями
по товару, а не причинами падения.`;

// Согласование числительных: «1 причина», «2 причины», «5 причин».
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

// Детерминированный рендер. Он же — запасной вариант, если модель недоступна:
// на демонстрации ответ не должен зависеть от прокси и ключа.
export function renderSalesDrop(r: SalesDropReport, detail = false): string {
  if (r.status === "unknown_sku") return `Не нашёл товар ${r.offer_id} в кабинете.`;
  if (r.status === "no_series")
    return `По ${r.offer_id} нет истории продаж за период — сравнивать нечего. Нужны дневные данные аналитики.`;

  const d = r.drop!;
  const lines: string[] = [];

  lines.push(
    r.is_drop
      ? `${r.name}: заказы ${d.orders_before} → ${d.orders_now} (${d.orders_delta_pct}%), выручка ${Math.round(
          d.revenue_before
        )} → ${Math.round(d.revenue_now)} ₽${d.started_on ? `, падение с ${d.started_on}` : ""}.`
      : `${r.name}: заказы ${d.orders_before} → ${d.orders_now} (${d.orders_delta_pct}%) — значимого падения нет.`
  );

  // Причину называем только когда есть что объяснять. Без падения «главная
  // причина» — это ответ на незаданный вопрос: наблюдения по карточке или
  // стоку остаются наблюдениями, а не причинами.
  if (!r.is_drop) {
    const observations = r.primary ? [r.primary, ...r.others] : r.others;
    if (observations.length) {
      lines.push(
        `Причин искать не нужно, но ${plural(
          observations.length,
          "есть замечание",
          "есть замечания",
          "есть замечаний"
        )} по товару — скажите «подробнее».`
      );
    }
  } else if (r.primary) {
    lines.push(`Главная причина — ${r.primary.title.toLowerCase()}. ${r.primary.conclusion}`);
    if (r.primary.action) lines.push(`Что сделать: ${r.primary.action}`);
    if (r.primary.recheck_days)
      lines.push(`Перепроверить через ${r.primary.recheck_days} дн.`);
  } else {
    lines.push("Ни одна из восьми проверок причину не подтвердила.");
  }

  if (detail) {
    lines.push("", "Все проверки:");
    for (const c of r.checks) {
      const mark =
        c.status === "found" ? "причина найдена" : c.status === "not_confirmed" ? "не подтверждена" : "нет данных";
      lines.push(`${c.order}. ${c.title} — ${mark}. ${c.data}. ${c.conclusion} [${c.source}]`);
    }
  } else if (r.is_drop) {
    const tail: string[] = [];
    if (r.others.length)
      tail.push(
        `ещё ${plural(r.others.length, "возможная причина", "возможные причины", "возможных причин")}`
      );
    if (r.no_data.length)
      tail.push(
        plural(r.no_data.length, "проверка без данных", "проверки без данных", "проверок без данных")
      );
    if (tail.length) lines.push(`Есть ${tail.join(" и ")} — скажите «подробнее», покажу.`);
  }

  if (r.is_mock) lines.push("_Данные тестовые._");
  return lines.join("\n");
}

export async function synthesizeSalesDrop(
  r: SalesDropReport,
  detail = false
): Promise<string> {
  if (r.status !== "ok") return renderSalesDrop(r, detail);

  const facts = {
    sku: r.offer_id,
    name: r.name,
    period: { days: r.period_days, current: r.current_range, previous: r.previous_range },
    drop: r.drop,
    primary: r.primary,
    others_count: r.others.length,
    no_data_count: r.no_data.length,
    checks: detail ? r.checks : undefined,
    data_is_mock: r.is_mock,
  };

  try {
    const completion = await client().chat.completions.create({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: DROP_SYSTEM },
        {
          role: "user",
          content: `${detail ? "Просят подробности." : "Короткий ответ."}\n\nОТЧЁТ (JSON):\n${JSON.stringify(
            facts,
            null,
            2
          )}`,
        },
      ],
    });
    return completion.choices[0].message.content ?? renderSalesDrop(r, detail);
  } catch {
    // Ключа нет, прокси упал, лимит — ответ всё равно должен быть.
    return renderSalesDrop(r, detail);
  }
}
