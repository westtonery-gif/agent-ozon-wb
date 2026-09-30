import { NextRequest } from "next/server";
import { matchUnits, runDiagnosis, runStoreScan } from "../../../knowledge/runtime";
import { diagnoseSalesDrop } from "../../../knowledge/sales-drop";
import { planSupply } from "../../../knowledge/supply-plan";
import {
  synthesize,
  synthesizeSalesDrop,
  synthesizeScan,
  synthesizeSupplyPlan,
} from "../../../knowledge/synthesize";
import { getProducts } from "../../../integrations/ozon/store";
import type { DiagnosticSession, ProductRef, StoreScan } from "../../../knowledge/types";

type ClientMessage = { role: "user" | "assistant"; content: string };

// Товар из запроса. Если не передан — runtime возьмёт первый товар магазина.
function extractProductRef(body: unknown): ProductRef | undefined {
  const p = (body as { productRef?: { offer_id?: unknown; sku?: unknown } })?.productRef;
  if (!p) return undefined;
  const ref: ProductRef = {};
  if (typeof p.offer_id === "string") ref.offer_id = p.offer_id;
  if (typeof p.sku === "number") ref.sku = p.sku;
  return ref.offer_id || ref.sku !== undefined ? ref : undefined;
}

// Артикул, названный в тексте. Сверяем с реальным списком товаров, а не с
// регуляркой: артикул — это то, что есть в кабинете, а не то, что похоже на него.
function findOfferId(text: string, knownIds: string[]): string | null {
  const lower = text.toLowerCase();
  // Самый длинный совпавший — чтобы «AVL-SER-NIAC-30» не проиграл «AVL-SER».
  return (
    knownIds
      .filter((id) => lower.includes(id.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

// Просят раскрыть остальные причины. Нужно, потому что короткий ответ по
// умолчанию называет только главную.
const DETAIL_RE =
  /подробн|детал|остальн|все причины|полный|разверн|что ещё|что еще|покажи всё|покажи все/i;

// Вопрос про поставки: куда и сколько везти, запрос на отгрузку. Проверяется
// раньше общего обхода — иначе «что отгружать?» ушло бы в диагностику остатков,
// которая скажет «кончается», но не скажет «вези 22 шт в Москву».
const SUPPLY_RE =
  /поставк|отгруз|на как(ие|ой) склад|куда вез|сколько вез|что вез|кластер|распредел.*склад/i;

// Вопрос именно про падение продаж. Названный артикул сам по себе ещё не
// значит «диагностика падения»: «стоит ли поднять цену на X?» — вопрос про
// цену, и отвечать на него надо правилами цены, а не восемью проверками спада.
const DROP_RE =
  /упал|упад|падени|просел|просад|снизил|меньше заказ|хуже прода|не прода[её]тся|почему.*продаж/i;

// Период сравнения: «за 14 дней» → 14. По умолчанию 7 против предыдущих 7.
function periodDays(text: string): number {
  const m = text.match(/(\d{1,2})\s*дн/i);
  const n = m ? Number(m[1]) : 7;
  return n >= 3 && n <= 30 ? n : 7;
}

// Все сообщения диалога, новые первыми. Памяти у роута нет, но история
// приходит с фронта — по ней находим SKU, о котором шла речь, когда в самом
// вопросе («подробнее») его уже нет.
function historyText(body: unknown): string[] {
  const b = body as { messages?: ClientMessage[] };
  return Array.isArray(b.messages)
    ? [...b.messages].reverse().map((m) => m?.content ?? "")
    : [];
}

function latestUserQuestion(body: unknown): string {
  const b = body as { messages?: ClientMessage[]; message?: unknown };
  if (Array.isArray(b.messages)) {
    const lastUser = [...b.messages]
      .reverse()
      .find((m) => m?.role === "user" && m.content);
    if (lastUser) return lastUser.content;
  }
  return b.message ? String(b.message) : "";
}

function logStoreScan(scan: StoreScan) {
  console.log(
    "[knowledge-runtime] store scan",
    JSON.stringify(
      {
        units_applied: scan.units,
        products_scanned: scan.products_scanned,
        findings: scan.findings.map((f) => ({
          sku: f.product.offer_id,
          unit: f.unit_id,
          rule: f.diagnosis.matched_rule,
          severity: f.diagnosis.severity,
          evidence: f.evidence.map((m) => `${m.metric_id}=${m.value}`),
        })),
        unavailable_metrics: scan.unavailable_metrics,
      },
      null,
      2
    )
  );
}

function logDiagnosticSession(session: DiagnosticSession) {
  console.log(
    "[knowledge-runtime]",
    JSON.stringify(
      {
        selected_knowledge_unit: session.intent.unit_id,
        resolved_metrics: session.metrics.map((m) => ({
          id: m.metric_id,
          value: m.value,
          status: m.status,
          source: m.source,
          tool: m.tool,
        })),
        formulas_executed: session.formulas.map((f) => ({
          id: f.formula_id,
          value: f.value,
          status: f.status,
          provenance: f.provenance,
        })),
        diagnosis: session.diagnosis,
      },
      null,
      2
    )
  );
}

function errorMessage(error: unknown): string {
  const e = error as {
    status?: number;
    code?: string;
    error?: { code?: string };
    message?: string;
  };
  const status = e?.status;
  const code = e?.code ?? e?.error?.code;

  if (status === 401) {
    return "OpenAI отклонил ключ. Проверьте OPENAI_API_KEY в `.env.local`.";
  }
  if (code === "unsupported_country_region_territory" || status === 403) {
    return "OpenAI заблокировал запрос по региону. Проверьте VPN/прокси и перезапустите сервер с `NODE_USE_ENV_PROXY=1`.";
  }
  if (status === 429) {
    return "OpenAI: слишком много запросов. Подождите немного и повторите.";
  }
  const msg = String(e?.message ?? "");
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket|network|fetch failed/i.test(msg)) {
    return "Не удалось соединиться с OpenAI. Проверьте сеть или прокси и повторите.";
  }
  return "Не удалось получить ответ. Повторите попытку.";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = latestUserQuestion(body).trim();

    if (!question) {
      return new Response("Напишите вопрос, и я проанализирую доступные данные.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const productRef = extractProductRef(body);
    const detail = DETAIL_RE.test(question);

    // Артикул ищем сначала в самом вопросе, потом в истории: на «подробнее»
    // товар уже не назван, но речь всё ещё о нём.
    const knownIds = (await getProducts()).map((p) => p.offer_id);
    let offerId = productRef?.offer_id ?? findOfferId(question, knownIds);
    // По какому тексту выбирать режим. На «подробнее» это прошлый вопрос про
    // тот же товар: иначе разбор цены на «подробнее» превратился бы в
    // диагностику падения.
    let topic = question;
    if (!offerId && detail) {
      for (const past of historyText(body)) {
        offerId = findOfferId(past, knownIds);
        if (offerId) {
          topic = past;
          break;
        }
      }
    }
    // Тема вопроса про товар: юнит знаний, если вопрос не про падение.
    const topicUnit =
      offerId && !DROP_RE.test(topic)
        ? matchUnits(topic).find((u) => u.unit.category !== "diagnostics")
        : undefined;

    const b = body as { messages?: ClientMessage[] };
    const dialogue = (b.messages ?? []).slice(0, -1).filter((m) => m?.content);

    let answer: string;
    if (SUPPLY_RE.test(question)) {
      // План поставок: что, куда и сколько везти. Назван артикул — по нему,
      // нет — по всему ассортименту.
      const plan = await planSupply(offerId ? { offerIds: [offerId] } : {});
      console.log(
        "[supply-plan]",
        JSON.stringify({ totals: plan.totals, production: plan.production.map((p) => p.offer_id) })
      );
      answer = await synthesizeSupplyPlan(plan, dialogue);
    } else if (offerId && topicUnit) {
      // Вопрос про конкретный товар и конкретную тему (цена, сток, реклама):
      // применяем правила этой темы к этому товару.
      const session = await runDiagnosis({
        question,
        productRef: { offer_id: offerId },
        unitPath: topicUnit.path,
      });
      logDiagnosticSession(session);
      answer = await synthesize(session, dialogue);
    } else if (offerId) {
      // Назван конкретный SKU — режим «Диагностика падения продаж»:
      // восемь проверок по порядку, каждую делает код.
      const report = await diagnoseSalesDrop(offerId, periodDays(question));
      console.log(
        "[sales-drop]",
        JSON.stringify(
          {
            sku: report.offer_id,
            period_days: report.period_days,
            is_drop: report.is_drop,
            primary: report.primary?.id ?? null,
            checks: report.checks.map((c) => `${c.order}.${c.id}=${c.status}`),
          },
          null,
          2
        )
      );
      // Предыдущие реплики уходят в синтез: «а почему?» должно читаться как
      // продолжение разговора. Цифры модель всё равно берёт только из отчёта.
      answer = await synthesizeSalesDrop(report, detail, dialogue);
    } else if (productRef) {
      const session = await runDiagnosis({ question, productRef });
      logDiagnosticSession(session);
      answer =
        session.status === "no_match"
          ? "Не понял, про какую область вопрос. Спросите про сток и подсортировку, цену и промо или воронку и продвижение."
          : await synthesize(session);
    } else {
      const scan = await runStoreScan({ question });
      logStoreScan(scan);
      answer = await synthesizeScan(scan, dialogue, detail);
    }

    return new Response(answer, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error(error);
    return new Response(errorMessage(error), {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
