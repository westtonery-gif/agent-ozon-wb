// Сезонность спроса: во сколько раз будущий период отличается от последних
// 30 дней, по которым считается темп продаж.
//
// Профили — в knowledge/seasonality.yaml. Сейчас это экспертная оценка по
// категориям; на реальном кабинете её заменяют отношениями своих продаж
// прошлого года по месяцам.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

interface SeasonalityFile {
  profiles: Record<string, { title: string; months: number[] }>;
  categories: Record<string, string>;
  products: Record<string, string>;
}

let _file: SeasonalityFile | null = null;
function file(): SeasonalityFile {
  if (!_file) {
    _file = yaml.load(
      readFileSync(join(process.cwd(), "knowledge", "seasonality.yaml"), "utf8")
    ) as SeasonalityFile;
  }
  return _file;
}

export interface SeasonProfile {
  id: string;
  title: string;
  months: number[]; // 12 значений, январь первый
}

// Профиль товара: сначала собственный, потом профиль категории. Нет ни того,
// ни другого — сезон не учитывается (плоский профиль), и это видно в ответе.
export function profileFor(offerId: string, category: string | null): SeasonProfile {
  const f = file();
  const id = f.products[offerId] ?? (category ? f.categories[category] : undefined);
  const p = id ? f.profiles[id] : undefined;
  return p ? { id: id!, title: p.title, months: p.months } : { id: "flat", title: "без сезонности", months: Array(12).fill(1) };
}

const DAY = 86_400_000;

function indexOn(profile: SeasonProfile, t: number): number {
  return profile.months[new Date(t).getUTCMonth()];
}

// Средний индекс по дням [from, from + days).
function avgIndex(profile: SeasonProfile, from: number, days: number): number {
  let sum = 0;
  for (let i = 0; i < days; i++) sum += indexOn(profile, from + i * DAY);
  return sum / days;
}

// Во сколько раз спрос в будущем окне отличается от спроса последних 30 дней.
// Темп последних 30 дней делится на их сезонный индекс и умножается на индекс
// окна: сентябрь → декабрь для парфюма это ~2,3 раза.
export function seasonFactor(
  profile: SeasonProfile,
  today: Date,
  startInDays: number,
  lengthDays: number
): number {
  const t = today.getTime();
  const trailing = avgIndex(profile, t - 30 * DAY, 30);
  const ahead = avgIndex(profile, t + startInDays * DAY, Math.max(1, lengthDays));
  return trailing > 0 ? ahead / trailing : 1;
}

// Самый «горячий» месяц внутри окна — чтобы назвать пик словами.
const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];
export function peakMonth(profile: SeasonProfile, today: Date, days: number): string {
  let best = -1;
  let bestIdx = 0;
  for (let i = 0; i < days; i++) {
    const m = new Date(today.getTime() + i * DAY).getUTCMonth();
    if (profile.months[m] > best) {
      best = profile.months[m];
      bestIdx = m;
    }
  }
  return MONTHS[bestIdx];
}
