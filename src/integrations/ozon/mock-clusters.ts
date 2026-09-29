// Мок для планирования поставок: кластеры складов Ozon, спрос и остаток по ним,
// собственный склад производителя и кратность короба.
//
// Кластеры упрощены до семи макрорегионов — у Ozon их больше, но логика та же:
// товар, который лежит не в том кластере, где его покупают, едет к покупателю
// дольше и дороже. Это бьёт и по конверсии (срок доставки видно в карточке),
// и по марже (логистика растёт при низком индексе локализации).
//
// Детерминированно от артикула, как и остальные производные мок-данные.

import { seedOf, type OzonProduct } from "./mock";

export interface Cluster {
  id: string;
  name: string;
  transit_days: number; // от собственного склада (Подмосковье) до склада кластера
  base_share: number; // типичная доля спроса по косметике
}

export const CLUSTERS: Cluster[] = [
  { id: "msk", name: "Москва и МО", transit_days: 2, base_share: 0.38 },
  { id: "spb", name: "Санкт-Петербург и СЗО", transit_days: 3, base_share: 0.15 },
  { id: "south", name: "Юг", transit_days: 4, base_share: 0.13 },
  { id: "volga", name: "Поволжье", transit_days: 4, base_share: 0.12 },
  { id: "ural", name: "Урал", transit_days: 5, base_share: 0.09 },
  { id: "siberia", name: "Сибирь", transit_days: 8, base_share: 0.09 },
  { id: "fareast", name: "Дальний Восток", transit_days: 14, base_share: 0.04 },
];

export interface ClusterPosition {
  cluster: Cluster;
  demand_share: number; // доля заказов товара в этом кластере
  stock: number; // остаток товара на складах кластера
}

export interface SupplyInputs {
  own_stock: number; // на собственном складе, готово к отгрузке
  units_per_box: number; // кратность короба — отгружаем целыми коробами
  positions: ClusterPosition[];
}

// Товары со своей историей. Остальные получают правдоподобные значения по умолчанию.
// moscow_share — какая доля остатка на Ozon лежит в Москве. Типичная ошибка
// производителя: везти всё в Москву, потому что ближе, а продаётся по всей стране.
const OVERRIDES: Record<string, { own_stock?: number; moscow_share?: number }> = {
  // Хит кончился на Ozon, но готовая партия стоит на своём складе — надо просто везти.
  "AVL-SER-NIAC-30": { own_stock: 180 },
  // Остаток на Ozon только в Москве, своего мало — не хватит закрыть регионы.
  "AVL-SER-HYAL-30": { own_stock: 60, moscow_share: 1 },
  // Хит, но почти всё лежит в Москве — регионы пустые.
  "ORT-LIP-MAT-01": { own_stock: 400, moscow_share: 0.92 },
  // Тон кончается, а своего склада почти нет — нужна партия в производство.
  "ORT-LIP-MAT-04": { own_stock: 30 },
  "NOI-EDP-OUD-50": { own_stock: 8 },
  // Товара хватает, но почти весь лежит в Москве — отгружали туда по привычке.
  "ORT-MAS-VOL-10": { moscow_share: 0.9 },
  "AVL-CRM-DAY-50": { moscow_share: 0.95 },
};

const BOX: Record<string, number> = {
  "Уход за лицом": 24,
  "Декоративная косметика": 48,
  Парфюмерия: 12,
};

export function supplyInputs(p: OzonProduct): SupplyInputs {
  const h = seedOf(p.offer_id);
  const o = OVERRIDES[p.offer_id] ?? {};

  // Спрос по кластерам: базовые доли с небольшим разбросом, нормированные к 1.
  const raw = CLUSTERS.map((c, i) => c.base_share * (0.85 + (((h >>> (i * 3)) & 7) / 7) * 0.3));
  const total = raw.reduce((a, b) => a + b, 0);
  const shares = raw.map((v) => v / total);

  // Остаток на Ozon: доля Москвы задана или «по умолчанию перекошена в Москву»
  // (0.55 при доле спроса ~0.38), остальное — по регионам пропорционально спросу.
  const moscow = o.moscow_share ?? 0.55;
  const regionalDemand = shares.slice(1).reduce((a, b) => a + b, 0);
  const stocks = CLUSTERS.map((_, i) =>
    i === 0 ? p.stock * moscow : p.stock * (1 - moscow) * (shares[i] / regionalDemand)
  ).map(Math.floor);
  // Остаток от округления — в Москву, чтобы сумма сошлась с общим остатком.
  stocks[0] += p.stock - stocks.reduce((a, b) => a + b, 0);

  return {
    own_stock: o.own_stock ?? Math.round((p.orders_30d ?? 0) * 1.5),
    units_per_box: BOX[p.category ?? ""] ?? 24,
    positions: CLUSTERS.map((cluster, i) => ({
      cluster,
      demand_share: Number(shares[i].toFixed(3)),
      stock: stocks[i],
    })),
  };
}
