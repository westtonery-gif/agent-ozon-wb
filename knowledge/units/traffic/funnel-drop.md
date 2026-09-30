---
id: traffic.funnel-drop
title: Воронка и продвижение — где теряется путь от показа до заказа
category: traffic
agents: [ozonologist]
keywords:
  [
    воронк,
    показ,
    просмотр,
    сесси,
    клик,
    ctr,
    корзин,
    конверси,
    продвижен,
    реклам,
    трафарет,
    ставк,
    дрр,
    drr,
    cpo,
    видимост,
    выдач,
  ]
required_metrics:
  [
    impressions_30d,
    sessions_30d,
    to_cart_30d,
    orders_30d,
    ctr,
    cart_rate,
    cart_to_order_rate,
    product_conversion,
    ad_spend_30d,
    ad_orders_30d,
    cpo,
    drr_product,
    unit_margin,
    ad_margin_gap,
  ]
diagnosis_rules:
  - id: ad_unprofitable
    priority: 100 # платим за заказ больше, чем он приносит
    conditions:
      - { metric: ad_margin_gap, op: not_null }
      - { metric: ad_margin_gap, op: lt, value: 0 }
    outcome:
      funnel_stage: promotion
      primary_unit: traffic.funnel-drop
      severity: critical
      confidence: high
      finding: "Привлечение одного заказа стоит дороже, чем маржа с единицы: продвижение работает в минус, и рост ставок только ускоряет убыток."

  - id: no_visibility
    priority: 90
    conditions:
      - { metric: impressions_30d, op: not_null }
      - { metric: impressions_30d, op: lt, value: 1000 }
    outcome:
      funnel_stage: visibility
      primary_unit: traffic.funnel-drop
      severity: high
      confidence: high
      finding: "Товар почти не показывается. Проблема не в карточке — до неё никто не доходит: вопрос к категории, запросам и позиции в выдаче."

  - id: ctr_low
    priority: 70
    conditions:
      - { metric: ctr, op: not_null }
      - { metric: ctr, op: lt, value: 3 }
    outcome:
      funnel_stage: impression_to_click
      primary_unit: traffic.funnel-drop
      severity: high
      confidence: high
      finding: "Показы есть, но в карточку не заходят. Решает то, что видно в выдаче: главное фото, цена, рейтинг и заголовок."

  - id: cart_low
    priority: 60
    conditions:
      - { metric: cart_rate, op: not_null }
      - { metric: cart_rate, op: lt, value: 8 }
    outcome:
      funnel_stage: click_to_cart
      primary_unit: traffic.funnel-drop
      severity: high
      confidence: high
      finding: "В карточку заходят, но не кладут в корзину. Отваливается на содержании карточки: состав, объём, фото, описание, цена относительно ожидания."

  - id: cart_to_order_low
    priority: 50
    conditions:
      - { metric: cart_to_order_rate, op: not_null }
      # Порог откалиброван по фактическому распределению кабинета: норма
      # 30-38%, поэтому 22% — это выброс, а не «чуть ниже среднего».
      # Правило, срабатывающее на трети ассортимента, диагностикой не является.
      - { metric: cart_to_order_rate, op: lt, value: 22 }
    outcome:
      funnel_stage: cart_to_order
      primary_unit: traffic.funnel-drop
      severity: medium
      confidence: medium
      finding: "Кладут в корзину, но не оформляют. Обычно это цена в сравнении с соседями по выдаче, срок доставки или отзывы."

  - id: drr_high
    priority: 40
    conditions:
      - { metric: drr_product, op: not_null }
      - { metric: drr_product, op: gt, value: 25 }
    outcome:
      funnel_stage: promotion
      primary_unit: traffic.funnel-drop
      severity: medium
      confidence: high
      finding: "ДРР выше 25%: продвижение ещё не в минус, но съедает заметную долю выручки с рекламных заказов."

  - id: funnel_healthy
    priority: 1
    conditions: []
    outcome:
      funnel_stage: unknown
      primary_unit: null
      severity: low
      confidence: medium
      finding: "Переходы воронки в пределах нормы."
---

## problem

«Мало заказов» — это не диагноз. Заказ теряется на одном из четырёх
переходов, и на каждом лечится разным. Пока не назван этап — любая
рекомендация угадана.

## symptoms

- показы < 1000 — товара нет в выдаче;
- `ctr < 3%` — видят, но не заходят;
- `cart_rate < 8%` — заходят, но не кладут;
- `cart_to_order_rate < 22%` — кладут, но не покупают;
- `ad_margin_gap < 0` — заказ с продвижения дороже собственной маржи.

## required_metrics

impressions_30d, sessions_30d, to_cart_30d, orders_30d и переходы между ними;
ad_spend_30d, ad_orders_30d, cpo, drr_product, ad_margin_gap.

Данные по продвижению в живом режиме приходят из отдельного Performance API
(свои ключи и OAuth). Он не подключён, поэтому в живом режиме эти метрики
остаются `unavailable`, и правила по рекламе просто не срабатывают —
вместо того чтобы сработать на нулях.

## diagnosis_logic

См. `diagnosis_rules`. Порядок приоритетов идёт снизу воронки вверх по деньгам:
убыточная реклама дороже плохого CTR, а отсутствие показов делает
обсуждение карточки бессмысленным.

## recommendation_logic

Всегда называть этап воронки и цифру, по которой он определён:

- `ad_unprofitable` → снизить ставку или выключить продвижение до починки
  экономики; считать предельную ставку от `unit_margin`, а не от «рынка»;
- `no_visibility` → категория, характеристики, запросы в заголовке;
- `ctr_low` → главное фото и цена в выдаче, это единственное, что видит покупатель до клика;
- `cart_low` → содержание карточки: состав, объём, назначение, фото «до/после», рич-контент;
- `cart_to_order_low` → цена относительно соседей, срок доставки, отзывы и рейтинг;
- `drr_high` → перераспределить бюджет на SKU с большей маржой.
