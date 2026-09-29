// LLM synthesis: превращает готовый диагноз в ответ менеджеру.
// Модель получает ТОЛЬКО факты (метрики), выходы формул и вывод движка.
// Запрещено: считать, выдумывать цифры, делать выводы вне diagnosis.
import OpenAI from "openai";
import { OZONOLOGIST_DOMAIN, OZONOLOGIST_VOICE } from "../agents/ozonologist";
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
- Рекомендация — это действие: какой SKU, что сделать, к какому сроку.
  Не «оптимизировать», не «поработать над карточкой», не «рассмотреть возможность».
- Русский язык.
${OZONOLOGIST_VOICE}`;

const SINGLE_SYSTEM = `${OZONOLOGIST_DOMAIN}\n${RULES}`;

const SCAN_SYSTEM = `${OZONOLOGIST_DOMAIN}
${RULES}

ОБХОД АССОРТИМЕНТА

Ты прошёл по всем товарам и принёс человеку сводку. Говори как менеджер,
который вернулся с обхода: сколько посмотрел, что из этого горит, с чего
начать сегодня.

Разбирай только critical и high, группируя одинаковые проблемы — «три SKU
уйдут в ноль раньше, чем приедет партия» читается лучше, чем три отдельных
пункта. Medium сверни в одну фразу и предложи раскрыть. Товары без находок
не упоминай вовсе. Если чего-то не хватило для выводов — скажи в конце одной
фразой, без списка.

Здесь список уместен, но короткий: сгруппированные проблемы, по строке на
группу. Не превращай его в таблицу и не подписывай поля.
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

ДИАГНОСТИКА ПАДЕНИЯ

Движок прогнал восемь проверок и отдал тебе результат. Расскажи человеку,
что происходит с товаром: что упало, из-за чего похоже, что делать.
Про остальные найденные причины упомяни вскользь и предложи раскрыть —
разворачивай их только если просят.

Причина вероятная, а не доказанная: ранжирование — это сила сигнала, а не
измеренный вклад. Не пиши «именно из-за этого».

Если падения нет (is_drop = false) — не называй никакой причины. Скажи, что
всё в порядке, и, если проверки что-то нашли, подай это как замечание по
товару, а не как причину падения.

ПРИМЕРЫ. Разница между ними — единственное, что тут важно.

Плохо (робот заполняет поля):
  AVELINA Сыворотка с ниацинамидом: заказы 21 → 7 (-66.7%), выручка
  27 090 → 9 030 ₽, падение с 25.09.
  Главная причина — остаток. Товар выпал из продажи с 24.09.
  Что сделать: срочная отгрузка на склад.
  Перепроверить через 3 дн.
  Есть 1 проверка без данных — скажите «подробнее», покажу.

Хорошо (человек объясняет):
  Сыворотка с ниацинамидом просто кончилась. Остаток ушёл в ноль 24-го, и со
  следующего дня заказы обвалились с 21 до 7 — цена, карточка и реклама тут
  ни при чём, я их проверил.
  Отгружать надо сейчас: пока карточка стоит пустая, она опускается в выдаче,
  и обратно поднимется не мгновенно. Через три дня посмотрим, подобрались ли
  заказы к прежним двадцати.
  Конкурентов проверить не смог — MPSTATS не подключён.

Плохо:
  Главная причина — рейтинг и отзывы. Рейтинг просел на 0.3 и пришло
  14 негативных отзывов. Что сделать: прочитать негативные отзывы.

Хорошо:
  Румяна 05 встали колом: за неделю ни одного заказа против пяти на прошлой.
  Похоже на отзывы — рейтинг сполз на 0,3, и пришло 14 оценок не выше тройки.
  В косметике это бьёт по конверсии быстрее всего остального.
  Прочитайте их и поймите, что общего: брак партии, оттенок не как на фото
  или бой при доставке. От этого зависит, что чинить — производство,
  карточку или упаковку. Там ещё вопрос по заполненности карточки, но он
  мельче — сказать?`;

// Согласование числительных: «1 причина», «2 причины», «5 причин».
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

// Как называть причину в живой фразе «Похоже на …».
const PRIMARY_LEAD: Record<string, string> = {
  stock: "остаток",
  price: "цену",
  position: "просадку в выдаче",
  reviews: "отзывы",
  ads: "продвижение",
  content: "карточку",
};

// Детерминированный рендер — запасной вариант, если модель недоступна
// (нет ключа, упал прокси, кончился лимит). Шаблон не умеет вести разговор,
// поэтому здесь задача скромнее: связные фразы вместо подписанных полей.
// Основной ответ пишет модель — см. synthesizeSalesDrop.
export function renderSalesDrop(r: SalesDropReport, detail = false): string {
  if (r.status === "unknown_sku") return `Не нашёл товар ${r.offer_id} в кабинете.`;
  if (r.status === "no_series")
    return `По ${r.offer_id} нет истории продаж за период — сравнивать нечего. Нужны дневные данные аналитики.`;

  const d = r.drop!;
  const lines: string[] = [];
  const day = (iso: string) => iso.slice(8, 10) + "." + iso.slice(5, 7);

  lines.push(
    r.is_drop
      ? `${r.name}: заказы упали с ${d.orders_before} до ${d.orders_now} за неделю, выручка — с ${Math.round(
          d.revenue_before
        ).toLocaleString("ru-RU")} до ${Math.round(d.revenue_now).toLocaleString("ru-RU")} ₽${
          d.started_on ? `. Началось ${day(d.started_on)}` : ""
        }.`
      : `${r.name}: заказы держатся — ${d.orders_before} на прошлой неделе, ${d.orders_now} на этой. Падения нет.`
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
    // Без подписей полей: вывод и действие идут как обычные фразы.
    const tail = r.primary.recheck_days
      ? ` Через ${r.primary.recheck_days} дн. стоит проверить, помогло ли.`
      : "";
    lines.push(`Похоже на ${PRIMARY_LEAD[r.primary.id] ?? r.primary.title.toLowerCase()}. ${r.primary.conclusion}`);
    if (r.primary.action) lines.push(`${r.primary.action}${tail}`);
    else if (tail) lines.push(tail.trim());
  } else {
    lines.push("Ни одна из восьми проверок причину не подтвердила — падение есть, а объяснения в данных нет.");
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
        plural(r.others.length, "возможная причина", "возможные причины", "возможных причин")
      );
    if (r.no_data.length)
      tail.push(
        plural(r.no_data.length, "проверка без данных", "проверки без данных", "проверок без данных")
      );
    if (tail.length) lines.push(`Там ещё ${tail.join(" и ")} — сказать?`);
  }

  if (r.is_mock) lines.push("_Данные тестовые._");
  return lines.join("\n");
}

// Предыдущие реплики диалога. Нужны, чтобы «а почему?» и «что со вторым?»
// читались как продолжение разговора, а не как новый запрос в пустоту.
// Факты модель по-прежнему берёт только из отчёта — история даёт контекст
// вопроса, а не цифры (это прописано в OZONOLOGIST_VOICE).
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

function recent(history: Turn[] = [], limit = 6) {
  return history
    .slice(-limit)
    .filter((m) => m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function synthesizeSalesDrop(
  r: SalesDropReport,
  detail = false,
  history: Turn[] = []
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
        ...recent(history),
        {
          role: "user",
          content: `${
            detail ? "Просят подробности — разверни." : "Ответь коротко, как коллега."
          }\n\nОТЧЁТ ДВИЖКА (JSON, только отсюда бери цифры):\n${JSON.stringify(
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
