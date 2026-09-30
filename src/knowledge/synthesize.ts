// LLM synthesis: превращает готовый диагноз в ответ менеджеру.
// Модель получает ТОЛЬКО факты (метрики), выходы формул и вывод движка.
// Запрещено: считать, выдумывать цифры, делать выводы вне diagnosis.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { OZONOLOGIST_DOMAIN, OZONOLOGIST_VOICE } from "../agents/ozonologist";
import type { SalesDropReport } from "./sales-drop";
import type { SupplyPlan } from "./supply-plan";
import { plural } from "./ru";
import type { DiagnosticSession, StoreScan } from "./types";

// ── Кто пишет ответ ──────────────────────────────────────────────────────
// Приоритет — Claude. OpenAI остаётся запасным провайдером (с него проект
// начинался). Без обоих ключей каждый режим отвечает детерминированным
// рендером: цифры и выводы те же, формулировки шаблонные.
//
// Клиенты создаются при первом вызове, а не при загрузке модуля: иначе
// `next build` без ключа падает на сборе данных страниц.
const CLAUDE_MODEL = "claude-opus-5-5";
let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;

async function complete(system: string, messages: Turn[]): Promise<string> {
  // Диалог обязан начинаться с реплики пользователя.
  const first = messages.findIndex((m) => m.role === "user");
  const convo = first < 0 ? [] : messages.slice(first);

  if (process.env.ANTHROPIC_API_KEY) {
    _anthropic ??= new Anthropic();
    const response = await _anthropic.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      // Opus 5.5 думает всегда; глубину задаёт effort. По умолчанию у этой
      // модели medium — задаём явно, чтобы поведение не менялось вслед за API.
      output_config: { effort: "medium" },
      // Если классификатор откажет, запрос сам переедет на рекомендованную
      // модель внутри того же вызова, а не вернёт пустой отказ.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: convo,
    });
    if (response.stop_reason === "refusal")
      throw new Error("модель отказалась отвечать");
    const text = response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
    console.log(
      `[synthesis] ${response.model}: ${response.usage.input_tokens} вх / ${response.usage.output_tokens} исх токенов`,
    );
    if (!text) throw new Error("пустой ответ модели");
    return text;
  }

  if (process.env.OPENAI_API_KEY) {
    _openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await _openai.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "system", content: system }, ...convo],
    });
    const text = completion.choices[0].message.content?.trim();
    if (!text) throw new Error("пустой ответ модели");
    return text;
  }

  throw new Error("нет ключа ни Anthropic, ни OpenAI");
}

// Модель недоступна — отвечаем детерминированно, но причину пишем в лог
// сервера. Иначе неверный ключ выглядел бы как «агент стал глупым».
function fallbackNotice(err: unknown) {
  console.warn(
    `[synthesis] модель недоступна, запасной ответ: ${(err as Error)?.message ?? err}`,
  );
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

Ты прошёл по всем товарам и возвращаешься к человеку с тем, что понял.
Движок дал тебе два слоя:
- patterns — закономерности: что у проблем общего, какой процесс за этим стоит,
  сколько это стоит и какой отдел чинит. Это главное.
- findings — отдельные находки по SKU. Это примеры и то, что ни в одну
  закономерность не вошло.

Начни с закономерностей, по убыванию денег. По каждой — что совпало, во что
обходится и кому что делать. Процесс, который за этим стоит, — гипотеза:
говори «похоже», и предложи, что проверить. Отдельные SKU упоминай только
как иллюстрацию к закономерности или если critical-находка ни в одну не
вошла. Остальное сверни одной фразой и предложи раскрыть.

Если закономерностей нет — тогда уже сгруппируй находки по типу проблемы.

ПРИМЕР

Плохо (отчёт по SKU):
  Проверено 24 SKU. AVL-TON-AHA-200 — залежался, 2600 дней запаса.
  AVL-MSK-CLAY-75 — залежался. ORT-LIP-MAT-07 — залежался. ORT-LIP-MAT-04 —
  подсортировка опоздала. ORT-EYE-PAL-12 — реклама в минус…

Хорошо (аналитик рассказывает про процессы):
  Если коротко — у вас три проблемы, и все три про то, как принимаются
  решения, а не про конкретные товары.
  Больше всего денег стоит сток: 637 тысяч по себестоимости лежат в четырёх
  позициях на год вперёд, и три из них уже в акциях — не уходят и со скидкой.
  Похоже, скидка тут не тот инструмент: коммерции стоит решить по каждой —
  набор, уценка по сроку или вывод из матрицы.
  Вторая — реклама. Все три товара, где продвижение уходит в минус, стоят
  в акциях, это 17,6 тысячи в месяц. Похоже, акции и продвижение
  согласуют раздельно — маркетингу на время акции стоит снижать ставку.
  И помады ORTIKA: Berry кончается, а Coral лежит 480 штук. Производят
  оттенки поровну, а покупают нет — следующую партию надо делить по продажам.
  Есть ещё перекос остатков в Москву, но он дешевле — рассказать?
`;

export async function synthesize(session: DiagnosticSession): Promise<string> {
  if (session.status === "data_unavailable") {
    return `Недостаточно данных для диагноза. Недоступны метрики: ${session.missing_metrics.join(
      ", ",
    )}. Подключи их (подписка/аналитика), тогда дам вывод.`;
  }

  const facts = {
    diagnosis: session.diagnosis,
    metrics: session.metrics.map((m) => ({
      id: m.metric_id,
      value: m.value,
      status: m.status,
    })),
    formulas: session.formulas.map((f) => ({
      id: f.formula_id,
      value: f.value,
      status: f.status,
    })),
    confidence: session.confidence,
  };

  return complete(SINGLE_SYSTEM, [
    {
      role: "user",
      content: `Вопрос: ${session.question}\n\nДИАГНОЗ (JSON):\n${JSON.stringify(
        facts,
        null,
        2,
      )}\n\nСформулируй ответ менеджеру.`,
    },
  ]);
}

const k = (n: number) =>
  n >= 10_000
    ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(".", ",")} тыс. ₽`
    : `${n} ₽`;

// Запасной рендер обхода: закономерности, потом то, что в них не вошло.
export function renderScan(scan: StoreScan, detail = false): string {
  const lines: string[] = [];
  const covered = new Set(scan.patterns.flatMap((p) => p.skus));

  if (scan.patterns.length) {
    lines.push(
      `Проверил ${scan.products_scanned} SKU. Главное — не отдельные товары, а ${plural(
        scan.patterns.length,
        "закономерность",
        "закономерности",
        "закономерностей",
      )}:`,
    );
    for (const p of scan.patterns) {
      const money = [
        p.money.frozen_rub ? `заморожено ${k(p.money.frozen_rub)}` : null,
        p.money.lost_margin_rub
          ? `недополучим ${k(p.money.lost_margin_rub)} маржи`
          : null,
        p.money.monthly_loss_rub
          ? `теряем ${k(p.money.monthly_loss_rub)} в месяц`
          : null,
      ].filter(Boolean);
      lines.push(
        "",
        detail
          ? `**${p.title}** (${p.owner}${money.length ? `, ${money.join(", ")}` : ""}). ${p.finding} ${p.hypothesis} ${p.action}`
          : `**${p.title}.** ${p.headline} ${p.hypothesis} ${p.action}`,
      );
    }
  }

  const rest = scan.findings.filter(
    (f) =>
      !covered.has(f.product.offer_id) && f.diagnosis.severity === "critical",
  );
  if (rest.length) {
    lines.push("", "Отдельно, вне закономерностей:");
    for (const f of rest)
      lines.push(`- ${f.product.name}: ${f.diagnosis.findings[0]}`);
  }
  if (!lines.length) {
    lines.push(
      `Проверил ${scan.products_scanned} SKU — отклонений, требующих действия, нет.`,
    );
  }
  lines.push("", "_Данные тестовые._");
  return lines.join("\n");
}

export async function synthesizeScan(
  scan: StoreScan,
  history: Turn[] = [],
  detail = false,
): Promise<string> {
  if (scan.status === "data_unavailable") {
    return "Не удалось получить данные магазина — ответ был бы догадкой. Проверьте доступ к Ozon и повторите.";
  }
  if (scan.status === "needs_metrics") {
    return "В кабинете не найдено товаров для анализа.";
  }
  if (scan.status === "no_findings") {
    return `Проверил ${scan.products_scanned} SKU — отклонений, требующих действия, нет.`;
  }

  const covered = new Set(scan.patterns.flatMap((p) => p.skus));
  const facts = {
    products_scanned: scan.products_scanned,
    patterns: scan.patterns.map((p) => ({
      title: p.title,
      owner: p.owner,
      money: p.money,
      headline: p.headline,
      finding: p.finding,
      hypothesis: p.hypothesis,
      action: p.action,
      skus: p.skus,
    })),
    // Находки, которые не вошли ни в одну закономерность, — отдельно.
    findings_outside_patterns: scan.findings
      .filter((f) => !covered.has(f.product.offer_id))
      .map((f) => ({
        sku: f.product.offer_id,
        name: f.product.name,
        severity: f.diagnosis.severity,
        finding: f.diagnosis.findings[0],
        evidence: f.evidence.map((m) => ({ id: m.metric_id, value: m.value })),
      })),
    unavailable_metrics: scan.unavailable_metrics,
  };

  try {
    return await complete(SCAN_SYSTEM, [
      ...recent(history),
      {
        role: "user",
        content: `${detail ? "Просят подробности — разверни каждую закономерность с цифрами по SKU.\n\n" : ""}Вопрос: ${scan.question}\n\nОТЧЁТ ДВИЖКА (JSON, только отсюда бери цифры):\n${JSON.stringify(
          facts,
          null,
          2,
        )}`,
      },
    ]);
  } catch (err) {
    // Нет ключа, упал прокси, лимит — ответ всё равно должен быть.
    fallbackNotice(err);
    return renderScan(scan, detail);
  }
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
  if (r.status === "unknown_sku")
    return `Не нашёл товар ${r.offer_id} в кабинете.`;
  if (r.status === "no_series")
    return `По ${r.offer_id} нет истории продаж за период — сравнивать нечего. Нужны дневные данные аналитики.`;

  const d = r.drop!;
  const lines: string[] = [];
  const day = (iso: string) => iso.slice(8, 10) + "." + iso.slice(5, 7);

  lines.push(
    r.is_drop
      ? `${r.name}: заказы упали с ${d.orders_before} до ${d.orders_now} за неделю, выручка — с ${Math.round(
          d.revenue_before,
        ).toLocaleString(
          "ru-RU",
        )} до ${Math.round(d.revenue_now).toLocaleString("ru-RU")} ₽${
          d.started_on ? `. Началось ${day(d.started_on)}` : ""
        }.`
      : `${r.name}: заказы держатся — ${d.orders_before} на прошлой неделе, ${d.orders_now} на этой. Падения нет.`,
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
          "есть замечаний",
        )} по товару — скажите «подробнее».`,
      );
    }
  } else if (r.primary) {
    // Без подписей полей: вывод и действие идут как обычные фразы.
    const tail = r.primary.recheck_days
      ? ` Через ${r.primary.recheck_days} дн. стоит проверить, помогло ли.`
      : "";
    lines.push(
      `Похоже на ${PRIMARY_LEAD[r.primary.id] ?? r.primary.title.toLowerCase()}. ${r.primary.conclusion}`,
    );
    if (r.primary.action) lines.push(`${r.primary.action}${tail}`);
    else if (tail) lines.push(tail.trim());
  } else {
    lines.push(
      "Ни одна из восьми проверок причину не подтвердила — падение есть, а объяснения в данных нет.",
    );
  }

  if (detail) {
    lines.push("", "Все проверки:");
    for (const c of r.checks) {
      const mark =
        c.status === "found"
          ? "причина найдена"
          : c.status === "not_confirmed"
            ? "не подтверждена"
            : "нет данных";
      lines.push(
        `${c.order}. ${c.title} — ${mark}. ${c.data}. ${c.conclusion} [${c.source}]`,
      );
    }
  } else if (r.is_drop) {
    const tail: string[] = [];
    if (r.others.length)
      tail.push(
        plural(
          r.others.length,
          "возможная причина",
          "возможные причины",
          "возможных причин",
        ),
      );
    if (r.no_data.length)
      tail.push(
        plural(
          r.no_data.length,
          "проверка без данных",
          "проверки без данных",
          "проверок без данных",
        ),
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
  history: Turn[] = [],
): Promise<string> {
  if (r.status !== "ok") return renderSalesDrop(r, detail);

  const facts = {
    sku: r.offer_id,
    name: r.name,
    period: {
      days: r.period_days,
      current: r.current_range,
      previous: r.previous_range,
    },
    drop: r.drop,
    primary: r.primary,
    others_count: r.others.length,
    no_data_count: r.no_data.length,
    checks: detail ? r.checks : undefined,
    data_is_mock: r.is_mock,
  };

  try {
    return await complete(DROP_SYSTEM, [
      ...recent(history),
      {
        role: "user",
        content: `${
          detail
            ? "Просят подробности — разверни."
            : "Ответь коротко, как коллега."
        }\n\nОТЧЁТ ДВИЖКА (JSON, только отсюда бери цифры):\n${JSON.stringify(
          facts,
          null,
          2,
        )}`,
      },
    ]);
  } catch (err) {
    // Ключа нет, прокси упал, лимит — ответ всё равно должен быть.
    fallbackNotice(err);
    return renderSalesDrop(r, detail);
  }
}

// ── План поставок ────────────────────────────────────────────────────────

const SUPPLY_SYSTEM = `${OZONOLOGIST_DOMAIN}
${RULES}

ПЛАН ПОСТАВОК

Движок посчитал, что, куда и сколько везти, и где своего склада не хватает.
Расскажи это как менеджер, который собрал поставку на неделю и объясняет
команде: сколько всего едет, что горит, где нужна партия в производство.

Что важно видеть за цифрами и говорить вслух:
- «лежит 0, ехать 8 дней» — покупатели в этом кластере уже сейчас ждут
  доставку из другого региона: дольше и дороже, а срок видно в карточке;
- если своего склада не хватает — дефицит ушёл туда, где товар продаётся
  быстрее, а остальные регионы закроет производственная партия. Назови цикл
  производства: это то, сколько регионы будут без товара;
- товары, которые никуда не нужно везти, не перечисляй.

Полный запрос на отгрузку — в файле, ссылку дадут отдельно. Не пересказывай
весь план построчно: главное, срочное, производство.

ПРИМЕР

Плохо:
  Итого к отгрузке: 267 шт, 22 короба, 5 SKU, 7 кластеров.
  Срочных позиций: 15. Потребность в производстве: ORT-LIP-MAT-04 — 40 шт.

Хорошо:
  На эту неделю едет 267 штук по семи кластерам, почти всё — сыворотки
  AVELINA: ниацинамид и гиалуронка сейчас лежат только в Москве, а в регионах
  по нулям, и их покупатели ждут доставку по неделе.
  С помадой Berry хуже: своих 30 штук, я их отдал Москве и Петербургу, там она
  уходит быстрее всего. Остальным регионам нужно ещё 40 штук, а это партия
  с циклом 25 дней — запускать надо сегодня, иначе почти месяц без неё.`;

export function renderSupplyPlan(plan: SupplyPlan): string {
  if (!plan.lines.length && !plan.production.length) {
    return plan.no_data.length
      ? `Для плана не хватает данных по ${plan.no_data.length} товарам — нужны остатки по складам и собственный склад.`
      : `Везти ничего не нужно: во всех кластерах запаса хватает на ${plan.target_days} дней с учётом дороги.`;
  }
  const t = plan.totals;
  const lines: string[] = [];
  lines.push(
    `На ближайшую поставку — ${t.units.toLocaleString("ru-RU")} шт по ${t.skus} товарам в ${t.clusters} кластеров.` +
      (t.urgent
        ? ` В ${t.urgent} позициях товар уже на нуле или кончится раньше, чем доедет.`
        : ""),
  );
  // by_cluster отсортирован по срочности; «больше всего» — это про объём.
  const top = [...plan.by_cluster]
    .sort((a, b) => b.units - a.units)
    .slice(0, 3)
    .map((c) => `${c.cluster_name} — ${c.units} шт`);
  if (top.length) lines.push(`Больше всего везём: ${top.join(", ")}.`);
  for (const n of plan.production) {
    lines.push(
      `${n.name}: своего склада ${n.own_stock} шт, не хватает ещё ${n.shortfall}` +
        (n.lead_days
          ? ` — это партия в производство с циклом ${n.lead_days} дн.`
          : "."),
    );
  }
  lines.push("[Скачать запрос на отгрузку (CSV)](/api/supply-plan)");
  if (plan.is_mock) lines.push("_Данные тестовые._");
  return lines.join("\n");
}

export async function synthesizeSupplyPlan(
  plan: SupplyPlan,
  history: Turn[] = [],
): Promise<string> {
  if (!plan.lines.length && !plan.production.length)
    return renderSupplyPlan(plan);

  const facts = {
    target_days: plan.target_days,
    totals: plan.totals,
    by_cluster: plan.by_cluster,
    urgent: plan.lines
      .filter((l) => l.urgent)
      .slice(0, 12)
      .map((l) => ({
        cluster: l.cluster_name,
        sku: l.offer_id,
        name: l.name,
        qty: l.qty,
        stock_now: l.stock_now,
        days_left: l.days_left,
        transit_days: l.transit_days,
      })),
    production: plan.production,
    skipped_low_demand: plan.skipped_low_demand,
    data_is_mock: plan.is_mock,
  };

  try {
    const text = await complete(SUPPLY_SYSTEM, [
      ...recent(history),
      {
        role: "user",
        content: `Ответь коротко, как коллега.\n\nПЛАН (JSON, только отсюда бери цифры):\n${JSON.stringify(facts, null, 2)}`,
      },
    ]);
    // Ссылку на файл добавляем сами: модель не должна её выдумывать или терять.
    return `${text}\n\n[Скачать запрос на отгрузку (CSV)](/api/supply-plan)`;
  } catch (err) {
    fallbackNotice(err);
    return renderSupplyPlan(plan);
  }
}
