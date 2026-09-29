// Formula Engine — детерминированный слой. LLM здесь ничего не считает.
// Каждая формула отвечает за один показатель; входы приходят по именам из
// formulas.yaml (inputs). Формула может опираться на выход другой формулы —
// Metric Resolver сортирует их по зависимостям.
import type { FormulaResult, MetricResult, MetricValue } from "./types";

// Аргументы — по имени входа формулы (formulas.yaml: inputs).
type Inputs = Record<string, MetricResult>;

function num(m: MetricResult | undefined): number | null {
  return m && m.status === "known" && typeof m.value === "number" ? m.value : null;
}

// Статус результата наследуется от входов: любой unavailable → unavailable,
// любой unknown → unknown, иначе known.
function inheritStatus(...ms: (MetricResult | undefined)[]) {
  if (ms.some((m) => !m || m.status === "unavailable")) return "unavailable" as const;
  if (ms.some((m) => m!.status === "unknown")) return "unknown" as const;
  return "known" as const;
}

function result(
  formula_id: string,
  value: MetricValue,
  status: FormulaResult["status"],
  inputs: Inputs
): FormulaResult {
  const inputs_used: Record<string, MetricValue> = {};
  for (const k of Object.keys(inputs)) inputs_used[k] = inputs[k]?.value ?? null;
  return { formula_id, value, status, inputs_used, provenance: "formula_engine" };
}

// «Сколько процентов part составляет от whole». Общая форма для всех переходов
// воронки: делитель 0 — это не 0%, а неизвестно.
function share(
  formulaId: string,
  partKey: string,
  wholeKey: string,
  inputs: Inputs
): FormulaResult {
  const part = num(inputs[partKey]);
  const whole = num(inputs[wholeKey]);
  const status = inheritStatus(inputs[partKey], inputs[wholeKey]);
  if (status !== "known" || part === null || whole === null)
    return result(formulaId, null, status, inputs);
  if (whole <= 0) return result(formulaId, null, "unknown", inputs);
  return result(formulaId, Number(((part / whole) * 100).toFixed(2)), "known", inputs);
}

export function compute(formulaId: string, inputs: Inputs): FormulaResult {
  switch (formulaId) {
    case "conversion_rate": {
      const orders = num(inputs.orders);
      const sessions = num(inputs.sessions);
      const status = inheritStatus(inputs.orders, inputs.sessions);
      if (status !== "known" || orders === null || sessions === null)
        return result(formulaId, null, status, inputs);
      if (sessions <= 0) return result(formulaId, null, "unknown", inputs); // /0 → неизвестно
      return result(formulaId, Number(((orders / sessions) * 100).toFixed(2)), "known", inputs);
    }
    case "stock_days": {
      const stock = num(inputs.stock);
      const orders30 = num(inputs.orders_30d);
      const status = inheritStatus(inputs.stock, inputs.orders_30d);
      if (status !== "known" || stock === null || orders30 === null)
        return result(formulaId, null, status, inputs);
      if (orders30 === 0) return result(formulaId, "infinite", "known", inputs); // measured 0 ≠ unknown
      return result(formulaId, Number((stock / (orders30 / 30)).toFixed(1)), "known", inputs);
    }
    case "price_vs_market": {
      const ourPrice = num(inputs.our_price);
      const marketAvg = num(inputs.market_avg);
      const status = inheritStatus(inputs.our_price, inputs.market_avg);
      if (status !== "known" || ourPrice === null || marketAvg === null)
        return result(formulaId, null, status, inputs);
      if (marketAvg <= 0) return result(formulaId, null, "unknown", inputs);
      return result(
        formulaId,
        Number((((ourPrice - marketAvg) / marketAvg) * 100).toFixed(2)),
        "known",
        inputs
      );
    }
    // ── цена и промо ──
    case "discount_pct": {
      const oldPrice = num(inputs.old_price);
      const price = num(inputs.price);
      const status = inheritStatus(inputs.old_price, inputs.price);
      if (status !== "known" || oldPrice === null || price === null)
        return result(formulaId, null, status, inputs);
      if (oldPrice <= 0) return result(formulaId, null, "unknown", inputs);
      if (price > oldPrice) return result(formulaId, 0, "known", inputs); // скидки нет
      return result(
        formulaId,
        Number((((oldPrice - price) / oldPrice) * 100).toFixed(1)),
        "known",
        inputs
      );
    }
    case "unit_margin": {
      const price = num(inputs.price);
      const cost = num(inputs.cost_price);
      const commission = num(inputs.commission_pct);
      const logistics = num(inputs.logistics_per_unit);
      const status = inheritStatus(
        inputs.price,
        inputs.cost_price,
        inputs.commission_pct,
        inputs.logistics_per_unit
      );
      if (
        status !== "known" ||
        price === null ||
        cost === null ||
        commission === null ||
        logistics === null
      )
        return result(formulaId, null, status, inputs);
      const margin = price - cost - (price * commission) / 100 - logistics;
      return result(formulaId, Math.round(margin), "known", inputs);
    }
    case "margin_pct": {
      const margin = num(inputs.unit_margin);
      const price = num(inputs.price);
      const status = inheritStatus(inputs.unit_margin, inputs.price);
      if (status !== "known" || margin === null || price === null)
        return result(formulaId, null, status, inputs);
      if (price <= 0) return result(formulaId, null, "unknown", inputs);
      return result(formulaId, Number(((margin / price) * 100).toFixed(1)), "known", inputs);
    }

    // ── сток ──
    case "cover_gap_days": {
      const status = inheritStatus(inputs.stock_days, inputs.supply_lead_days);
      if (status !== "known") return result(formulaId, null, status, inputs);
      // Продаж нет → остатка хватит навсегда, дефицит поставки не грозит.
      if (inputs.stock_days?.value === "infinite")
        return result(formulaId, "infinite", "known", inputs);
      const cover = num(inputs.stock_days);
      const lead = num(inputs.supply_lead_days);
      if (cover === null || lead === null) return result(formulaId, null, "unknown", inputs);
      return result(formulaId, Number((cover - lead).toFixed(1)), "known", inputs);
    }

    // ── воронка: одинаковая форма «часть от целого» ──
    case "ctr":
      return share(formulaId, "sessions", "impressions", inputs);
    case "cart_rate":
      return share(formulaId, "to_cart", "sessions", inputs);
    case "buyout_rate":
      return share(formulaId, "orders", "to_cart", inputs);
    case "product_conversion":
      return share(formulaId, "orders", "sessions", inputs);

    // ── продвижение ──
    case "cpo": {
      const spend = num(inputs.ad_spend);
      const adOrders = num(inputs.ad_orders);
      const status = inheritStatus(inputs.ad_spend, inputs.ad_orders);
      if (status !== "known" || spend === null || adOrders === null)
        return result(formulaId, null, status, inputs);
      // Продвижения не было — это не «бесплатный заказ», а «нечего измерять».
      if (adOrders === 0 && spend === 0) return result(formulaId, null, "unknown", inputs);
      if (adOrders === 0) return result(formulaId, "infinite", "known", inputs); // платили, заказов нет
      return result(formulaId, Math.round(spend / adOrders), "known", inputs);
    }
    case "drr_product": {
      const spend = num(inputs.ad_spend);
      const adOrders = num(inputs.ad_orders);
      const price = num(inputs.price);
      const status = inheritStatus(inputs.ad_spend, inputs.ad_orders, inputs.price);
      if (status !== "known" || spend === null || adOrders === null || price === null)
        return result(formulaId, null, status, inputs);
      if (adOrders === 0 && spend === 0) return result(formulaId, null, "unknown", inputs);
      if (adOrders === 0) return result(formulaId, "infinite", "known", inputs);
      const adRevenue = adOrders * price;
      if (adRevenue <= 0) return result(formulaId, null, "unknown", inputs);
      return result(
        formulaId,
        Number(((spend / adRevenue) * 100).toFixed(1)),
        "known",
        inputs
      );
    }
    case "ad_margin_gap": {
      const status = inheritStatus(inputs.unit_margin, inputs.cpo);
      if (status !== "known") return result(formulaId, null, status, inputs);
      // Заказов с продвижения нет — сравнивать маржу не с чем.
      if (inputs.cpo?.value === "infinite") return result(formulaId, null, "unknown", inputs);
      const margin = num(inputs.unit_margin);
      const cpo = num(inputs.cpo);
      if (margin === null || cpo === null) return result(formulaId, null, "unknown", inputs);
      return result(formulaId, Math.round(margin - cpo), "known", inputs);
    }

    default:
      return result(formulaId, null, "unknown", inputs);
  }
}
