// Запрос на отгрузку в CSV — файл, который передаётся команде для
// формирования поставок. Ничего в кабинете Ozon не создаётся: это документ.
//
// ?days=N — целевой запас в днях (по умолчанию 28). Чтение параметра из
// запроса заодно гарантирует, что роут считается в момент скачивания,
// а не пререндерится при сборке со вчерашними остатками.
import { planSupply, supplyPlanCsv } from "../../../knowledge/supply-plan";

export async function GET(request: Request) {
  const raw = Number(new URL(request.url).searchParams.get("days"));
  const targetDays = Number.isFinite(raw) && raw >= 7 && raw <= 90 ? raw : 28;

  const plan = await planSupply({ targetDays });
  const date = new Date().toISOString().slice(0, 10);

  return new Response(supplyPlanCsv(plan), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="supply-request-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
