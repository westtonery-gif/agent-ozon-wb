import { NextRequest } from "next/server";
import { runDiagnosis, runStoreScan } from "../../../knowledge/runtime";
import { synthesize, synthesizeScan } from "../../../knowledge/synthesize";
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

    // Назван конкретный товар — разбираем его. Товар не назван — вопрос
    // менеджера по определению про ассортимент, а не про первую попавшуюся
    // карточку: идём обходом по всем SKU.
    let answer: string;
    if (productRef) {
      const session = await runDiagnosis({ question, productRef });
      logDiagnosticSession(session);
      answer =
        session.status === "no_match"
          ? "Не понял, про какую область вопрос. Спросите про сток и подсортировку, цену и промо или воронку и продвижение."
          : await synthesize(session);
    } else {
      const scan = await runStoreScan({ question });
      logStoreScan(scan);
      answer = await synthesizeScan(scan);
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
