// Мок внешнего рынка: сопоставимые карточки конкурентов по каждому товару.
//
// Раньше заглушка отдавала одни и те же три сыворотки для любого товара —
// палетку теней сравнивали с сыворотками, и «цена относительно рынка»
// получалась бессмысленной. Теперь у каждого товара своя ниша: медиана цен
// около нашей цены (±20%), кроме товаров с заданной историей.
//
// В живом режиме этого файла нет вообще: внешний рынок — это MPSTATS или
// индекс цен Ozon, и пока их нет, сравнение с рынком честно «нет данных».
//
// Детерминированно от артикула, как и остальные производные мок-данные.

import { seedOf, type OzonProduct } from "./mock";

export interface Competitor {
  title: string;
  price: number;
  rating: number;
  reviews_count: number;
  url: string;
}

// Медиана цены ниши для товаров с историей. Остальным — около своей цены.
const NICHE_MEDIAN: Record<string, number> = {
  // Сыворотка с ретинолом за 690 ₽ при нише около 1700 ₽. Для активов вроде
  // ретинола низкая цена читается как «разбавленный» или подделка, а маржи
  // при такой цене не хватает на продвижение. Аналог реального случая:
  // БАД за 700 ₽ продавался плохо, за 2000 ₽ — пошёл.
  "AVL-SER-RETI-30": 1_700,
};

export function marketFor(p: OzonProduct): Competitor[] {
  const h = seedOf(`market:${p.offer_id}`);
  const jitter = (k: number) => (((h >>> (k * 5)) & 31) / 31) * 2 - 1; // -1..1
  const median = NICHE_MEDIAN[p.offer_id] ?? Math.round(p.price * (1 + jitter(0) * 0.2));
  const base = p.name.replace(/^[A-ZÉ]+\s+/, "").split(",")[0];

  return [0.85, 1, 1.15].map((k, i) => ({
    title: `${base} — конкурент ${i + 1}`,
    price: Math.round((median * k * (1 + jitter(i + 1) * 0.04)) / 10) * 10,
    rating: Number((4.4 + ((h >>> (i * 3 + 7)) & 3) * 0.1).toFixed(1)),
    reviews_count: 150 + ((h >>> (i * 4 + 2)) & 1023),
    url: `https://www.ozon.ru/mock/${p.offer_id.toLowerCase()}-competitor-${i + 1}`,
  }));
}
