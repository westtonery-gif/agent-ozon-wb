import { getProducts, isMock } from "../../integrations/ozon/store";
import { shelfLifeLeftDays, shelfLifeLeftPct } from "../../integrations/ozon/mock";
import { formatRub, formatInt } from "../_ui/format";
import PageHeader from "../_ui/page-header";

export const metadata = { title: "Товары — Ozonologist" };

export default async function ProductsPage() {
  const products = await getProducts();
  const mock = isMock();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <PageHeader
          title="Товары"
          subtitle={`Ассортимент магазина: ${products.length} товаров, цены, остатки и сроки годности.`}
          mock={mock}
        />

        <div className="overflow-hidden rounded-xl border border-zinc-200">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Товар</th>
                <th className="px-4 py-3 font-medium">Бренд</th>
                <th className="px-4 py-3 font-medium">Артикул</th>
                <th className="px-4 py-3 text-right font-medium">Цена</th>
                <th className="px-4 py-3 text-right font-medium">Старая цена</th>
                <th className="px-4 py-3 text-right font-medium">Остаток</th>
                <th className="px-4 py-3 text-right font-medium">Заказы 30д</th>
                <th className="px-4 py-3 text-right font-medium">Срок годности</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {products.map((p) => {
                const out = p.stock === 0;
                const low = p.stock > 0 && p.stock <= 10;
                // Остаточный срок: ниже 40% — зона уценки, ниже 25% — риск списания.
                const leftPct = shelfLifeLeftPct(p);
                const leftDays = shelfLifeLeftDays(p);
                return (
                  <tr key={p.offer_id} className="hover:bg-zinc-50">
                    <td className="px-4 py-3">{p.name}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{p.brand ?? "н/д"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {p.offer_id}
                    </td>
                    <td className="px-4 py-3 text-right">{formatRub(p.price)}</td>
                    <td className="px-4 py-3 text-right text-zinc-400 line-through">
                      {formatRub(p.old_price)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={
                          out
                            ? "font-semibold text-red-600"
                            : low
                              ? "font-semibold text-amber-600"
                              : ""
                        }
                      >
                        {out ? "нет в наличии" : `${formatInt(p.stock)} шт.`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {p.orders_30d === null ? "н/д" : formatInt(p.orders_30d)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {leftPct === null || leftDays === null ? (
                        <span className="text-zinc-400">н/д</span>
                      ) : (
                        <span
                          className={
                            leftPct < 25
                              ? "font-semibold text-red-600"
                              : leftPct < 40
                                ? "font-semibold text-amber-600"
                                : ""
                          }
                        >
                          {leftPct}% · {formatInt(leftDays)} дн.
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-zinc-400">
          <span className="text-red-600">Красным</span> — нет в наличии или остаточный срок
          ниже 25%, <span className="text-amber-600">жёлтым</span> — низкий остаток (≤ 10 шт.)
          или срок ниже 40%. Срок годности приходит из учётной системы продавца, а не из Ozon:
          в живом режиме без неё здесь «н/д».
        </p>
      </div>
    </div>
  );
}
