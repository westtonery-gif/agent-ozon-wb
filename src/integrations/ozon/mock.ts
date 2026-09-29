// Мок-данные Ozon: категория «Красота и здоровье» → косметика и парфюмерия.
// Модель кабинета: производитель с собственной разработкой, три бренда.
// Формат совпадает с тем, что отдаёт живой слой (products.ts / analytics.ts),
// поэтому переключение на реальные ключи не требует изменений выше по стеку.
//
// Поля, которых живой Ozon не отдаёт (себестоимость, срок производства, лид-тайм),
// в живом режиме приходят как null → метрика unknown, а не 0. Движок в этом случае
// говорит «нет данных», а не выдумывает цифру.

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

export interface OzonProduct {
  offer_id: string;
  sku?: number; // Ozon SKU; нужен для сопоставления и контекста
  name: string;
  brand: string | null;
  category: string | null;
  // Ozon «модель»: варианты одного товара (оттенки, объёмы) в одной карточке.
  // Нужна, чтобы видеть линейку целиком: дефицит одного оттенка и затоваривание
  // другого — это одна проблема планирования, а не две проблемы двух SKU.
  // Не задана — товар сам себе модель (см. modelOf).
  model_id?: string | null;

  // ── цена и юнит-экономика ──
  price: number; // текущая цена (с учётом акции), ₽
  old_price: number; // цена до скидки, ₽
  cost_price: number | null; // себестоимость производства, ₽
  commission_pct: number | null; // комиссия Ozon по категории, %
  logistics_per_unit: number | null; // логистика + обработка на единицу, ₽
  in_promo: boolean | null; // участвует в акции маркетплейса

  // ── сток и производство ──
  stock: number; // остаток на складах, шт
  supply_lead_days: number | null; // производство + поставка на склад, дней
  produced_at: string | null; // дата производства партии, ISO
  shelf_life_days: number | null; // полный срок годности, дней

  // ── воронка за 30 дней ──
  impressions_30d: number | null; // показы в поиске и каталоге
  sessions_30d: number | null; // сессии (просмотры карточки)
  to_cart_30d: number | null; // добавлений в корзину
  orders_30d: number | null; // заказов; null = нет данных

  // ── продвижение за 30 дней (в живом режиме — Performance API, пока null) ──
  ad_spend_30d: number | null; // расход на продвижение, ₽
  ad_orders_30d: number | null; // заказов с продвижения

  // ── отзывы ──
  reviews_count?: number | null;
  rating?: number | null;
}

// Модель товара: заданная или сам артикул (товар без вариантов).
export function modelOf(p: OzonProduct): string {
  return p.model_id ?? p.offer_id;
}

// Детерминированный сид от артикула. Производные мок-сигналы (дневные ряды,
// контент карточки) должны быть воспроизводимыми: со случайными значениями
// один и тот же вопрос давал бы разные диагнозы.
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Контент карточки (проверка «карточка» в диагностике падения) ──
export interface CardContent {
  photos_count: number;
  attributes_filled_pct: number;
  content_rating: number; // контент-рейтинг Ozon, 0-100
  moderation_note: string | null;
}

// Карточки с намеренными дырами. Остальные заполняются нормально.
const CONTENT_OVERRIDES: Record<string, Partial<CardContent>> = {
  "ORT-BLS-PWD-05": {
    photos_count: 2,
    attributes_filled_pct: 48,
    content_rating: 42,
    moderation_note: "Не указан состав (INCI) — обязателен для косметики",
  },
  "AVL-TON-AHA-200": {
    photos_count: 3,
    attributes_filled_pct: 61,
    content_rating: 55,
    moderation_note: null,
  },
};

export function cardContent(p: OzonProduct): CardContent {
  const h = seedOf(p.offer_id);
  // Сдвиг только беззнаковый: h — uint32, и обычный >> на значениях ≥ 2^31
  // даёт отрицательное число, из-за чего «заполненность» уезжала ниже порога
  // и карточка ложно помечалась неполной.
  return {
    photos_count: 5 + (h % 4),
    attributes_filled_pct: 86 + ((h >>> 3) % 13),
    content_rating: 80 + ((h >>> 7) % 16),
    moderation_note: null,
    ...CONTENT_OVERRIDES[p.offer_id],
  };
}

// Остаточный срок годности в днях. null, если дата производства или срок неизвестны
// (живой режим) — тогда метрика останется unknown и движок её не использует.
export function shelfLifeLeftDays(p: OzonProduct): number | null {
  if (!p.produced_at || p.shelf_life_days === null) return null;
  const produced = Date.parse(p.produced_at);
  if (Number.isNaN(produced)) return null;
  const expires = produced + p.shelf_life_days * DAY;
  return Math.round((expires - Date.now()) / DAY);
}

// Доля оставшегося срока годности, %. Ozon и сети требуют остаточный срок
// не ниже порога (обычно 50-80%), иначе приёмка или продажа блокируется.
export function shelfLifeLeftPct(p: OzonProduct): number | null {
  const left = shelfLifeLeftDays(p);
  if (left === null || !p.shelf_life_days) return null;
  return Number(((left / p.shelf_life_days) * 100).toFixed(1));
}

export const MOCK_PRODUCTS: OzonProduct[] = [
  // ───────────────────────── AVELINA — уход за лицом ─────────────────────────
  {
    offer_id: "AVL-SER-NIAC-30",
    sku: 1400101,
    name: "AVELINA Сыворотка для лица с ниацинамидом 10%, 30 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 1290,
    old_price: 1690,
    cost_price: 312,
    commission_pct: 16,
    logistics_per_unit: 72,
    in_promo: false,
    stock: 0,
    supply_lead_days: 21,
    produced_at: daysAgo(95),
    shelf_life_days: 730,
    impressions_30d: 48_200,
    sessions_30d: 2_350,
    to_cart_30d: 282,
    orders_30d: 96,
    ad_spend_30d: 6_900,
    ad_orders_30d: 38,
    reviews_count: 412,
    rating: 4.8,
  },
  {
    offer_id: "AVL-SER-HYAL-30",
    sku: 1400102,
    name: "AVELINA Сыворотка гиалуроновая увлажняющая, 30 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 1190,
    old_price: 1490,
    cost_price: 286,
    commission_pct: 16,
    logistics_per_unit: 72,
    in_promo: false,
    stock: 38,
    supply_lead_days: 21,
    produced_at: daysAgo(120),
    shelf_life_days: 730,
    impressions_30d: 41_600,
    sessions_30d: 2_060,
    to_cart_30d: 247,
    orders_30d: 84,
    ad_spend_30d: 4_500,
    ad_orders_30d: 29,
    reviews_count: 337,
    rating: 4.7,
  },
  {
    offer_id: "AVL-CRM-DAY-50",
    sku: 1400103,
    name: "AVELINA Крем дневной увлажняющий SPF 30, 50 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 1490,
    old_price: 1890,
    cost_price: 358,
    commission_pct: 16,
    logistics_per_unit: 84,
    in_promo: false,
    stock: 210,
    supply_lead_days: 24,
    produced_at: daysAgo(60),
    shelf_life_days: 730,
    impressions_30d: 33_400,
    sessions_30d: 1_520,
    to_cart_30d: 182,
    orders_30d: 62,
    ad_spend_30d: 3_800,
    ad_orders_30d: 21,
    reviews_count: 289,
    rating: 4.6,
  },
  {
    offer_id: "AVL-CRM-NGT-50",
    sku: 1400104,
    name: "AVELINA Крем ночной восстанавливающий с пептидами, 50 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 1590,
    old_price: 1990,
    cost_price: 402,
    commission_pct: 16,
    logistics_per_unit: 84,
    in_promo: false,
    stock: 164,
    supply_lead_days: 24,
    produced_at: daysAgo(74),
    shelf_life_days: 730,
    impressions_30d: 24_900,
    sessions_30d: 1_000,
    to_cart_30d: 120,
    orders_30d: 41,
    ad_spend_30d: 3_100,
    ad_orders_30d: 14,
    reviews_count: 158,
    rating: 4.7,
  },
  {
    offer_id: "AVL-TON-AHA-200",
    sku: 1400105,
    name: "AVELINA Тоник-эксфолиант с AHA-кислотами 5%, 200 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 890,
    old_price: 1190,
    cost_price: 214,
    commission_pct: 16,
    logistics_per_unit: 96,
    in_promo: true,
    stock: 520,
    supply_lead_days: 21,
    produced_at: daysAgo(430),
    shelf_life_days: 730,
    impressions_30d: 6_300,
    sessions_30d: 160,
    to_cart_30d: 18,
    orders_30d: 6,
    ad_spend_30d: 0,
    ad_orders_30d: 0,
    reviews_count: 41,
    rating: 4.3,
  },
  {
    offer_id: "AVL-MSK-CLAY-75",
    sku: 1400106,
    name: "AVELINA Маска глиняная очищающая, 75 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 690,
    old_price: 990,
    cost_price: 168,
    commission_pct: 16,
    logistics_per_unit: 78,
    in_promo: true,
    stock: 340,
    supply_lead_days: 18,
    produced_at: daysAgo(310),
    shelf_life_days: 730,
    impressions_30d: 9_800,
    sessions_30d: 340,
    to_cart_30d: 33,
    orders_30d: 11,
    ad_spend_30d: 2_100,
    ad_orders_30d: 3,
    reviews_count: 86,
    rating: 4.4,
  },
  {
    offer_id: "AVL-EYE-CAF-15",
    sku: 1400107,
    name: "AVELINA Крем для век с кофеином, 15 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 990,
    old_price: 1290,
    cost_price: 236,
    commission_pct: 16,
    logistics_per_unit: 64,
    in_promo: false,
    stock: 88,
    supply_lead_days: 21,
    produced_at: daysAgo(150),
    shelf_life_days: 730,
    impressions_30d: 18_700,
    sessions_30d: 830,
    to_cart_30d: 100,
    orders_30d: 34,
    ad_spend_30d: 1_500,
    ad_orders_30d: 11,
    reviews_count: 127,
    rating: 4.6,
  },
  {
    offer_id: "AVL-CLN-GEL-150",
    sku: 1400108,
    name: "AVELINA Гель для умывания с пантенолом, 150 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 590,
    old_price: 790,
    cost_price: 142,
    commission_pct: 16,
    logistics_per_unit: 82,
    in_promo: false,
    stock: 430,
    supply_lead_days: 18,
    produced_at: daysAgo(88),
    shelf_life_days: 730,
    impressions_30d: 22_100,
    sessions_30d: 1_420,
    to_cart_30d: 170,
    orders_30d: 58,
    ad_spend_30d: 4_300,
    ad_orders_30d: 16,
    reviews_count: 203,
    rating: 4.5,
  },
  {
    offer_id: "AVL-SER-VITC-30",
    sku: 1400109,
    name: "AVELINA Сыворотка с витамином C 15%, 30 мл",
    brand: "AVELINA",
    category: "Уход за лицом",
    price: 1390,
    old_price: 1790,
    cost_price: 334,
    commission_pct: 16,
    logistics_per_unit: 72,
    in_promo: false,
    stock: 46,
    supply_lead_days: 21,
    // Витамин C — короткий срок (18 мес), партия почти отработала свой ресурс.
    produced_at: daysAgo(465),
    shelf_life_days: 540,
    impressions_30d: 14_000,
    sessions_30d: 840,
    to_cart_30d: 118,
    orders_30d: 22,
    ad_spend_30d: 1_400,
    ad_orders_30d: 7,
    reviews_count: 94,
    rating: 4.4,
  },

  // ─────────────────────── ORTIKA — декоративная косметика ───────────────────
  {
    offer_id: "ORT-LIP-MAT-01",
    model_id: "ORT-LIP-MAT",
    sku: 1400201,
    name: "ORTIKA Помада матовая устойчивая, тон 01 Nude",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 690,
    old_price: 890,
    cost_price: 158,
    commission_pct: 16,
    logistics_per_unit: 58,
    in_promo: false,
    stock: 260,
    supply_lead_days: 25,
    produced_at: daysAgo(110),
    shelf_life_days: 1095,
    impressions_30d: 52_800,
    sessions_30d: 2_940,
    to_cart_30d: 353,
    orders_30d: 120,
    ad_spend_30d: 3_700,
    ad_orders_30d: 41,
    reviews_count: 528,
    rating: 4.7,
  },
  {
    offer_id: "ORT-LIP-MAT-04",
    model_id: "ORT-LIP-MAT",
    sku: 1400202,
    name: "ORTIKA Помада матовая устойчивая, тон 04 Berry",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 690,
    old_price: 890,
    cost_price: 158,
    commission_pct: 16,
    logistics_per_unit: 58,
    in_promo: false,
    stock: 12,
    supply_lead_days: 25,
    produced_at: daysAgo(130),
    shelf_life_days: 1095,
    impressions_30d: 38_400,
    sessions_30d: 1_910,
    to_cart_30d: 229,
    orders_30d: 78,
    ad_spend_30d: 2_300,
    ad_orders_30d: 26,
    reviews_count: 341,
    rating: 4.8,
  },
  {
    offer_id: "ORT-LIP-MAT-07",
    model_id: "ORT-LIP-MAT",
    sku: 1400203,
    name: "ORTIKA Помада матовая устойчивая, тон 07 Coral",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 690,
    old_price: 890,
    cost_price: 158,
    commission_pct: 16,
    logistics_per_unit: 58,
    in_promo: true,
    stock: 480,
    supply_lead_days: 25,
    produced_at: daysAgo(520),
    shelf_life_days: 1095,
    impressions_30d: 4_100,
    sessions_30d: 197,
    to_cart_30d: 14,
    orders_30d: 3,
    ad_spend_30d: 0,
    ad_orders_30d: 0,
    reviews_count: 19,
    rating: 4.1,
  },
  {
    offer_id: "ORT-MAS-VOL-10",
    sku: 1400204,
    name: "ORTIKA Тушь для ресниц объёмная, 10 мл",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 790,
    old_price: 1090,
    cost_price: 186,
    commission_pct: 16,
    logistics_per_unit: 62,
    in_promo: false,
    stock: 190,
    supply_lead_days: 25,
    produced_at: daysAgo(96),
    shelf_life_days: 730,
    impressions_30d: 44_700,
    sessions_30d: 2_350,
    to_cart_30d: 282,
    orders_30d: 96,
    ad_spend_30d: 3_400,
    ad_orders_30d: 33,
    reviews_count: 402,
    rating: 4.6,
  },
  {
    offer_id: "ORT-FND-SPF-30",
    sku: 1400205,
    name: "ORTIKA Тональный крем SPF 20, тон 02 Natural, 30 мл",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 1190,
    old_price: 1590,
    cost_price: 292,
    commission_pct: 16,
    logistics_per_unit: 66,
    in_promo: false,
    stock: 96,
    supply_lead_days: 28,
    produced_at: daysAgo(140),
    shelf_life_days: 730,
    impressions_30d: 26_300,
    sessions_30d: 1_075,
    to_cart_30d: 129,
    orders_30d: 44,
    ad_spend_30d: 2_300,
    ad_orders_30d: 15,
    reviews_count: 176,
    rating: 4.5,
  },
  {
    offer_id: "ORT-BLS-PWD-05",
    sku: 1400206,
    name: "ORTIKA Румяна компактные, тон 05 Peach",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 590,
    old_price: 790,
    cost_price: 136,
    commission_pct: 16,
    logistics_per_unit: 54,
    in_promo: false,
    stock: 300,
    supply_lead_days: 25,
    produced_at: daysAgo(180),
    shelf_life_days: 1095,
    // Показы и клики есть, но в корзину почти не кладут — провал на карточке.
    impressions_30d: 18_000,
    sessions_30d: 1_260,
    to_cart_30d: 63,
    orders_30d: 18,
    ad_spend_30d: 500,
    ad_orders_30d: 6,
    reviews_count: 58,
    rating: 4.2,
  },
  {
    offer_id: "ORT-BRW-GEL-04",
    sku: 1400207,
    name: "ORTIKA Гель для бровей фиксирующий, тон 04 Taupe, 4 мл",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 490,
    old_price: 690,
    cost_price: 112,
    commission_pct: 16,
    logistics_per_unit: 52,
    in_promo: false,
    stock: 150,
    supply_lead_days: 25,
    produced_at: daysAgo(102),
    shelf_life_days: 730,
    impressions_30d: 21_400,
    sessions_30d: 1_275,
    to_cart_30d: 153,
    orders_30d: 52,
    ad_spend_30d: 900,
    ad_orders_30d: 14,
    reviews_count: 149,
    rating: 4.5,
  },
  {
    offer_id: "ORT-EYE-PAL-12",
    sku: 1400208,
    name: "ORTIKA Палетка теней 12 оттенков Nude Story",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    // В акции: скидка 32% от базовой цены, при этом продвигается платно.
    // Палетка дороже в производстве — маржа тонкая ещё до рекламы.
    price: 1490,
    old_price: 2190,
    cost_price: 860,
    commission_pct: 16,
    logistics_per_unit: 118,
    in_promo: true,
    stock: 64,
    supply_lead_days: 30,
    produced_at: daysAgo(165),
    shelf_life_days: 1095,
    impressions_30d: 29_800,
    sessions_30d: 1_788,
    to_cart_30d: 143,
    orders_30d: 28,
    ad_spend_30d: 18_000,
    ad_orders_30d: 16,
    reviews_count: 71,
    rating: 4.4,
  },
  {
    offer_id: "ORT-LIP-GLS-03",
    sku: 1400209,
    name: "ORTIKA Блеск для губ увлажняющий, тон 03 Rose",
    brand: "ORTIKA",
    category: "Декоративная косметика",
    price: 590,
    old_price: 790,
    cost_price: 134,
    commission_pct: 16,
    logistics_per_unit: 54,
    in_promo: false,
    stock: 220,
    supply_lead_days: 25,
    produced_at: daysAgo(125),
    shelf_life_days: 1095,
    impressions_30d: 19_600,
    sessions_30d: 983,
    to_cart_30d: 118,
    orders_30d: 40,
    ad_spend_30d: 850,
    ad_orders_30d: 11,
    reviews_count: 118,
    rating: 4.4,
  },

  // ───────────────────────── NOIRÉ — парфюмерия ─────────────────────────────
  {
    offer_id: "NOI-EDP-VET-50",
    model_id: "NOI-EDP-VET",
    sku: 1400301,
    name: "NOIRÉ Vetiver Noir парфюмерная вода, 50 мл",
    brand: "NOIRÉ",
    category: "Парфюмерия",
    price: 3490,
    old_price: 4490,
    cost_price: 784,
    commission_pct: 17,
    logistics_per_unit: 124,
    in_promo: false,
    stock: 74,
    supply_lead_days: 45,
    produced_at: daysAgo(210),
    shelf_life_days: 1825,
    impressions_30d: 26_000,
    sessions_30d: 936,
    to_cart_30d: 103,
    orders_30d: 31,
    ad_spend_30d: 7_500,
    ad_orders_30d: 12,
    reviews_count: 96,
    rating: 4.7,
  },
  {
    offer_id: "NOI-EDP-ROS-50",
    sku: 1400302,
    name: "NOIRÉ Rose de Nuit парфюмерная вода, 50 мл",
    brand: "NOIRÉ",
    category: "Парфюмерия",
    price: 3490,
    old_price: 4490,
    cost_price: 792,
    commission_pct: 17,
    logistics_per_unit: 124,
    in_promo: false,
    stock: 118,
    supply_lead_days: 45,
    produced_at: daysAgo(240),
    shelf_life_days: 1825,
    impressions_30d: 16_000,
    sessions_30d: 573,
    to_cart_30d: 63,
    orders_30d: 19,
    ad_spend_30d: 5_600,
    ad_orders_30d: 8,
    reviews_count: 57,
    rating: 4.6,
  },
  {
    offer_id: "NOI-EDP-VET-100",
    model_id: "NOI-EDP-VET",
    sku: 1400303,
    name: "NOIRÉ Vetiver Noir парфюмерная вода, 100 мл",
    brand: "NOIRÉ",
    category: "Парфюмерия",
    price: 4990,
    old_price: 6490,
    cost_price: 1_092,
    commission_pct: 17,
    logistics_per_unit: 138,
    in_promo: false,
    stock: 22,
    supply_lead_days: 45,
    produced_at: daysAgo(198),
    shelf_life_days: 1825,
    impressions_30d: 10_000,
    sessions_30d: 364,
    to_cart_30d: 40,
    orders_30d: 12,
    ad_spend_30d: 3_200,
    ad_orders_30d: 4,
    reviews_count: 34,
    rating: 4.8,
  },
  {
    offer_id: "NOI-EDP-OUD-50",
    sku: 1400304,
    name: "NOIRÉ Oud Imperial парфюмерная вода, 50 мл",
    brand: "NOIRÉ",
    category: "Парфюмерия",
    price: 4490,
    old_price: 5490,
    cost_price: 1_140,
    commission_pct: 17,
    logistics_per_unit: 124,
    in_promo: false,
    stock: 9,
    supply_lead_days: 45,
    produced_at: daysAgo(175),
    shelf_life_days: 1825,
    impressions_30d: 12_000,
    sessions_30d: 427,
    to_cart_30d: 47,
    orders_30d: 14,
    ad_spend_30d: 9_200,
    ad_orders_30d: 5,
    reviews_count: 41,
    rating: 4.9,
  },
  {
    offer_id: "NOI-SET-MINI-3",
    sku: 1400305,
    name: "NOIRÉ Набор миниатюр 3×10 мл: Vetiver, Rose, Citrus",
    brand: "NOIRÉ",
    category: "Парфюмерия",
    // Классическая ловушка: набор загнали в акцию со скидкой 40%, а его
    // себестоимость — это три флакона и подарочная упаковка.
    price: 1610,
    old_price: 2690,
    cost_price: 1_420,
    commission_pct: 17,
    logistics_per_unit: 108,
    in_promo: true,
    stock: 340,
    supply_lead_days: 45,
    produced_at: daysAgo(390),
    shelf_life_days: 1825,
    impressions_30d: 7_400,
    sessions_30d: 260,
    to_cart_30d: 30,
    orders_30d: 9,
    ad_spend_30d: 1_200,
    ad_orders_30d: 2,
    reviews_count: 23,
    rating: 4.5,
  },
  {
    offer_id: "NOI-EDP-CIT-50",
    sku: 1400306,
    name: "NOIRÉ Citrus Blanc парфюмерная вода, 50 мл",
    brand: "NOIRÉ",
    category: "Парфюмерия",
    price: 2990,
    old_price: 3790,
    cost_price: 706,
    commission_pct: 17,
    logistics_per_unit: 124,
    in_promo: false,
    stock: 156,
    supply_lead_days: 45,
    produced_at: daysAgo(130),
    shelf_life_days: 1825,
    // Показов много, а в карточку почти не заходят — проблема выдачи, не карточки.
    impressions_30d: 92_000,
    sessions_30d: 1_840,
    to_cart_30d: 221,
    orders_30d: 47,
    ad_spend_30d: 8_500,
    ad_orders_30d: 19,
    reviews_count: 112,
    rating: 4.6,
  },
];

export interface OzonSalesSummary {
  period_days: number;
  orders: number;
  revenue: number; // выручка, ₽
  avg_check: number; // средний чек, ₽
  conversion: number; // конверсия в заказ, %
  sessions: number | null; // сессии магазина за период
  // Реклама и ДРР приходят из отдельного Performance API. Пока он не подключён,
  // в живом режиме здесь null («нет данных»), а не 0 — чтобы не вводить в заблуждение.
  ad_spend: number | null; // расходы на продвижение, ₽
  drr: number | null; // доля рекламных расходов, %
}

export const MOCK_SALES: OzonSalesSummary = {
  period_days: 30,
  orders: 1_025,
  revenue: 1_313_330,
  avg_check: 1_281,
  conversion: 2.4,
  sessions: 42_100,
  ad_spend: 94_750,
  drr: 7.2,
};
