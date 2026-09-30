// Отзывы: не сколько негатива, а о чём он и чей это процесс.
//
// «Пришло 14 негативных отзывов» — это симптом. «9 из 14 — румяна приехали
// разбитыми» — это ответ: дело в упаковке, а не в цене и не в карточке.
//
// Разделение ответственности:
//   модель — читает текст и относит каждый негативный отзыв к одной теме из
//            фиксированного списка (строгая схема, ничего вне списка);
//   код    — считает темы, доли, выбирает цитаты и решает, чей это процесс.
// Без ключа или без сети работает классификатор по словам — грубее, но
// детерминированный; в ответе указано, кто классифицировал.
//
// Прочитанные моделью отзывы кэшируются (.data/review-themes.json): отзыв не
// меняется, и платить за его чтение дважды незачем.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProducts, getReviews } from "../integrations/ozon/store";
import type { Review } from "../integrations/ozon/mock-reviews";

export const THEMES = {
  damaged_in_transit: {
    title: "пришло разбитым или повреждённым",
    owner: "логистика",
    process: "упаковка не выдерживает доставку",
    keywords: [/разбит/i, /разбил/i, /раскрош/i, /треснул/i, /мят\S* короб/i, /в пыль/i, /повредил/i, /сломан/i],
  },
  leaking: {
    title: "протекает",
    owner: "производство",
    process: "герметичность флакона",
    keywords: [/протек/i, /теч[её]т/i, /вытек/i],
  },
  shade_mismatch: {
    title: "цвет не как на фото",
    owner: "контент",
    process: "фото в карточке искажают оттенок",
    keywords: [/не как на фото/i, /на фото \S*\s?(другой|светлее|темнее|нежный|персиков)/i, /цвет (другой|не тот|темнее|светлее)/i, /оттенок не/i, /на картинке/i],
  },
  expired_oxidized: {
    title: "старая партия, окислилось",
    owner: "склад",
    process: "ротация партий: отгружают старое",
    keywords: [/окислил/i, /потемнел/i, /коричнев/i, /срок годности (заканч|истека|почти)/i, /просроч/i, /не свеж/i, /старая партия/i],
  },
  irritation: {
    title: "раздражение, аллергия",
    owner: "производство (R&D)",
    process: "состав",
    keywords: [/аллерг/i, /раздраж/i, /жж[её]т|жжени/i, /покраснен/i, /сыпь/i],
  },
  fake_suspicion: {
    title: "подозрение на подделку",
    owner: "коммерция",
    process: "цена или вид товара вызывают недоверие",
    keywords: [/подделк/i, /подозрительно дешев/i, /не оригинал/i, /паль\b/i],
  },
  weak_effect: {
    title: "слабый эффект, стойкость, пигмент",
    owner: "производство (R&D)",
    process: "формула не дотягивает до ожиданий",
    keywords: [/стойкост/i, /не держится/i, /эффекта/i, /пигмент/i, /осыпа/i],
  },
  delivery: {
    title: "долгая доставка",
    owner: "логистика",
    process: "сроки доставки",
    keywords: [/долго (шл|вез|доставл)/i, /доставк/i],
  },
  other: {
    title: "прочее",
    owner: "—",
    process: "без общей причины",
    keywords: [],
  },
} as const;

export type ThemeId = keyof typeof THEMES;

// Что делать, когда тема — главная жалоба. Адресовано тому, чей это процесс.
export const THEME_ACTIONS: Record<ThemeId, string> = {
  damaged_in_transit:
    "Логистике: усилить упаковку для доставки (жёсткая коробка, вставка) и проверить, как товар упакован для FBO. Покупателям ответить и предложить замену.",
  leaking: "Производству: проверить герметичность партии.",
  shade_mismatch:
    "Контенту: переснять фото при дневном свете, добавить свотчи на коже. До этого не делать выводов, что оттенок «не продаётся».",
  expired_oxidized:
    "Складу: проверить, какие партии уходят на Ozon, и отгружать свежие первыми; старую партию уценить по сроку.",
  irritation: "R&D: проверить состав и конкретную партию; ответить каждому покупателю.",
  fake_suspicion:
    "Коммерции: цена или вид товара вызывают недоверие — проверить цену против ниши, добавить в карточку подтверждение подлинности.",
  weak_effect: "R&D и контенту: сверить обещания в описании с реальным эффектом.",
  delivery: "Логистике: проверить сроки доставки по регионам.",
  other: "Общей причины нет — отвечать на отзывы по одному.",
};
const THEME_IDS = Object.keys(THEMES) as [ThemeId, ...ThemeId[]];

export interface Classified {
  id: string;
  theme: ThemeId;
  quote: string; // короткая цитата, по которой отнесено к теме
}

// ── Классификация по словам (без модели) ─────────────────────────────────

export function classifyByKeywords(r: Review): Classified {
  for (const id of THEME_IDS) {
    if (THEMES[id].keywords.some((k) => k.test(r.text))) {
      return { id: r.id, theme: id, quote: r.text };
    }
  }
  return { id: r.id, theme: "other", quote: r.text };
}

// ── Классификация моделью ────────────────────────────────────────────────

const CACHE_MODEL = "claude-opus-5-5";

function cachePath() {
  return process.env.OZON_REVIEWS_CACHE ?? join(process.cwd(), ".data", "review-themes.json");
}
function readCache(): Record<string, Classified> {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8"));
  } catch {
    return {};
  }
}
function writeCache(c: Record<string, Classified>) {
  mkdirSync(dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(c, null, 2));
}

const ClassifiedSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      theme: z.enum(THEME_IDS),
      quote: z.string(),
    })
  ),
});

let _client: Anthropic | null = null;

async function classifyByModel(reviews: Review[]): Promise<Classified[]> {
  _client ??= new Anthropic();
  const themes = THEME_IDS.map((id) => `- ${id}: ${THEMES[id].title}`).join("\n");
  const response = await _client.messages.parse({
    model: CACHE_MODEL,
    max_tokens: 16000,
    // Классификация по списку — простая задача, глубокое рассуждение не нужно.
    output_config: { effort: "low", format: zodOutputFormat(ClassifiedSchema) },
    system:
      "Ты читаешь негативные отзывы покупателей косметики на Ozon и относишь каждый к одной теме из списка — " +
      "к главной причине недовольства. Если причин несколько, выбирай ту, что сильнее всего повлияла на оценку. " +
      "quote — короткий фрагмент отзыва (до 12 слов), по которому видна тема, дословно.\n\nТемы:\n" +
      themes,
    messages: [
      {
        role: "user",
        content: reviews.map((r) => `[${r.id}] (${r.rating}★) ${r.text}`).join("\n"),
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error("модель не вернула классификацию");
  }
  const known = new Set(reviews.map((r) => r.id));
  // Только то, что мы спрашивали: модель не может добавить отзыв от себя.
  return response.parsed_output.items.filter((c) => known.has(c.id));
}

// Классифицирует негатив: из кэша, моделью или по словам.
async function classify(reviews: Review[]): Promise<{ items: Classified[]; by: "claude" | "keywords" }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { items: reviews.map(classifyByKeywords), by: "keywords" };
  }
  const cache = readCache();
  const fresh = reviews.filter((r) => !cache[r.id]);
  if (fresh.length) {
    try {
      const got = await classifyByModel(fresh);
      for (const c of got) cache[c.id] = c;
      // Что модель пропустила — по словам, чтобы отзыв не выпал из счёта.
      for (const r of fresh) cache[r.id] ??= classifyByKeywords(r);
      writeCache(cache);
    } catch (err) {
      console.warn(`[reviews] модель недоступна, классифицирую по словам: ${(err as Error).message}`);
      return { items: reviews.map(classifyByKeywords), by: "keywords" };
    }
  }
  return { items: reviews.map((r) => cache[r.id]), by: "claude" };
}

// ── Отчёт по товару ──────────────────────────────────────────────────────

export interface ThemeCount {
  theme: ThemeId;
  title: string;
  owner: string;
  process: string;
  count: number;
  share: number; // доля от негативных, %
  quotes: string[]; // до двух цитат
}

export interface ReviewReport {
  sku: string;
  name: string;
  total: number;
  negative: number; // оценка 3 и ниже
  themes: ThemeCount[]; // по убыванию count, без «прочего», если есть что-то кроме
  top: ThemeCount | null; // главная тема, если она заметна
  classified_by: "claude" | "keywords";
}

// Тема «главная», когда это не случайность: минимум три отзыва и не меньше
// трети негатива. На двух отзывах тренда нет, и говорить о нём нечестно.
const TOP_MIN_COUNT = 3;
const TOP_MIN_SHARE = 34;

export async function reviewReport(sku: string): Promise<ReviewReport | null> {
  const reviews = await getReviews(sku);
  if (!reviews) return null; // живой режим: отзывов нет — «нет данных»
  const product = (await getProducts()).find((p) => p.offer_id === sku);
  const negative = reviews.filter((r) => r.rating <= 3);
  const { items, by } = negative.length ? await classify(negative) : { items: [], by: "keywords" as const };

  const counts = new Map<ThemeId, Classified[]>();
  for (const c of items) counts.set(c.theme, [...(counts.get(c.theme) ?? []), c]);
  const themes: ThemeCount[] = [...counts.entries()]
    .map(([theme, list]) => ({
      theme,
      title: THEMES[theme].title,
      owner: THEMES[theme].owner,
      process: THEMES[theme].process,
      count: list.length,
      share: Math.round((list.length / negative.length) * 100),
      quotes: list.slice(0, 2).map((c) => c.quote),
    }))
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));

  const first = themes.find((t) => t.theme !== "other");
  const top = first && first.count >= TOP_MIN_COUNT && first.share >= TOP_MIN_SHARE ? first : null;

  return {
    sku,
    name: product?.name ?? sku,
    total: reviews.length,
    negative: negative.length,
    themes,
    top,
    classified_by: by,
  };
}

export async function storeReviewReports(): Promise<ReviewReport[]> {
  const out: ReviewReport[] = [];
  for (const p of await getProducts()) {
    const r = await reviewReport(p.offer_id);
    if (r && r.negative) out.push(r);
  }
  // Сначала товары с явной темой, потом по объёму негатива.
  return out.sort((a, b) => Number(!!b.top) - Number(!!a.top) || b.negative - a.negative);
}
