---
id: pricing.promo-efficiency
title: Цена и промо — маржа после скидки, комиссии и логистики
category: pricing
agents: [ozonologist]
keywords:
  [
    цена,
    ценообразован,
    скидк,
    акци,
    промо,
    маржа,
    маржинальност,
    юнит-экономик,
    себестоимост,
    комисси,
    прибыл,
    в минус,
    убыточ,
    уценк,
  ]
required_metrics:
  [
    price,
    old_price,
    discount_pct,
    cost_price,
    commission_pct,
    logistics_per_unit,
    unit_margin,
    margin_pct,
    orders_30d,
  ]
diagnosis_rules:
  - id: margin_negative
    priority: 100 # каждая продажа увеличивает убыток
    conditions:
      - { metric: unit_margin, op: not_null }
      - { metric: unit_margin, op: lt, value: 0 }
    outcome:
      funnel_stage: unit_economics
      primary_unit: pricing.promo-efficiency
      severity: critical
      confidence: high
      finding: "После комиссии и логистики цена не покрывает себестоимость: каждая проданная единица увеличивает убыток. Чем лучше продаётся — тем хуже."

  - id: margin_thin
    priority: 80
    conditions:
      - { metric: margin_pct, op: not_null }
      - { metric: margin_pct, op: lt, value: 15 }
    outcome:
      funnel_stage: unit_economics
      primary_unit: pricing.promo-efficiency
      severity: high
      confidence: high
      finding: "Маржинальность ниже 15%: запаса нет ни на продвижение, ни на возвраты, ни на следующую акцию."

  - id: promo_eats_margin
    priority: 60
    conditions:
      - { metric: discount_pct, op: gt, value: 30 }
      - { metric: margin_pct, op: not_null }
      - { metric: margin_pct, op: lt, value: 25 }
    outcome:
      funnel_stage: unit_economics
      primary_unit: pricing.promo-efficiency
      severity: high
      confidence: medium
      finding: "Скидка глубже 30% при маржинальности ниже 25%: акция выкупает оборот за счёт прибыли."

  # Сравнение с рынком здесь намеренно отсутствует: это отдельная компетенция
  # (competition.market-position) на внешнем источнике, которого пока нет.
  # Дублировать её правилом здесь значило бы помечать половину ассортимента
  # «цена выше рынка» по одной заглушке.
  - id: pricing_healthy
    priority: 1
    conditions: []
    outcome:
      funnel_stage: unit_economics
      primary_unit: null
      severity: low
      confidence: medium
      finding: "Цена и скидка не нарушают юнит-экономику."
---

## problem

Скидка и участие в акции считаются по обороту, а платит за них маржа.
Вопрос не «выросли ли заказы», а «сколько осталось с единицы после
скидки, комиссии площадки и логистики».

## symptoms

- `unit_margin < 0` — продажа в минус;
- `margin_pct < 15` — нет запаса на продвижение и возвраты;
- `discount_pct > 30` при `margin_pct < 25` — акция съедает прибыль.

Сравнение с ценами рынка сюда не входит — см. `competition.market-position`.

## required_metrics

price, old_price, discount_pct, cost_price, commission_pct,
logistics_per_unit, unit_margin, margin_pct.

Себестоимость и условия по комиссии Ozon не отдаёт — это данные продавца.
Без них маржа не считается, и движок обязан сказать «нет данных»:
маржа, посчитанная по нулевой себестоимости, опаснее отсутствия ответа.

## diagnosis_logic

См. `diagnosis_rules`. Считает Formula Engine, не модель:
`unit_margin = price − cost_price − price × commission_pct / 100 − logistics_per_unit`.

## recommendation_logic

Называть конкретное решение по цене, а не «поднять маржинальность»:

- `margin_negative` → вывести из акции либо пересчитать цену входа;
  для наборов — пересобрать состав, а не давить скидку;
- `margin_thin` → проверить, тянет ли товар платное продвижение (см. `traffic.funnel-drop`);
- `promo_eats_margin` → сравнить прирост заказов в акции с потерей маржи
  на единицу; если прирост не перекрывает — выходить из механики.
