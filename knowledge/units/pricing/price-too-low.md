---
id: pricing.price-too-low
title: Цена слишком низкая — не на что продвигать и не доверяют
category: pricing
agents: [ozonologist]
keywords:
  [
    поднять цен,
    повысить цен,
    поднимать цен,
    дешев,
    дёшев,
    слишком низк,
    низкая цена,
    недооцен,
    недобира,
    не доверя,
    кажется подделк,
    выглядит дешев,
    можно дороже,
    стоит ли подня,
  ]
required_metrics:
  [
    price,
    competitor_avg_price,
    market_low_price,
    price_vs_market,
    price_test_breakeven,
    unit_margin,
    cpo,
    ad_margin_gap,
    cart_rate,
    rating,
    orders_30d,
  ]
# Во всех правилах, где предлагается поднять цену, в условия включены
# price, market_low_price и price_test_breakeven с op: not_null. Они ничего не
# фильтруют (если рынок известен, они известны), но попадают в доказательную
# базу находки — иначе модель получила бы «на 59% дешевле ниши» без самих
# цен и без цифры, которая решает, стоит ли тест.
diagnosis_rules:
  - id: underpriced_cant_promote
    priority: 90
    conditions:
      - { metric: price_vs_market, op: lt, value: -30 }
      - { metric: ad_margin_gap, op: lt, value: 0 }
      - { metric: price, op: not_null }
      - { metric: market_low_price, op: not_null }
      - { metric: price_test_breakeven, op: not_null }
    outcome:
      funnel_stage: unit_economics
      primary_unit: pricing.price-too-low
      severity: high
      confidence: medium
      finding: "Цена намного ниже ниши, и при ней маржи не хватает на продвижение: заказ с рекламы стоит дороже, чем остаётся с продажи. Резать ставку бесполезно — товар просто нельзя растить при такой цене. Похоже, цена занижена. Проверить тестом: поднять до нижней границы ниши на две недели и сравнивать маржу в день, а не заказы; price_test_breakeven — какую долю заказов достаточно сохранить, чтобы не проиграть."

  - id: underpriced_no_trust
    priority: 80
    conditions:
      - { metric: price_vs_market, op: lt, value: -30 }
      - { metric: cart_rate, op: lt, value: 8 }
      - { metric: rating, op: gte, value: 4.3 }
      - { metric: price, op: not_null }
      - { metric: market_low_price, op: not_null }
      - { metric: price_test_breakeven, op: not_null }
    outcome:
      funnel_stage: click_to_cart
      primary_unit: pricing.price-too-low
      severity: high
      confidence: medium
      finding: "Карточку смотрят, но в корзину кладут мало, хотя рейтинг хороший, а цена намного ниже ниши. Похоже, цена читается как дешёвка или подделка — в косметике и БАДах это частая причина. Проверить тестом: поднять до нижней границы ниши на две недели и сравнивать маржу в день; price_test_breakeven — какую долю заказов достаточно сохранить."

  - id: underpriced_room
    priority: 50
    conditions:
      - { metric: price_vs_market, op: lt, value: -40 }
      - { metric: price, op: not_null }
      - { metric: market_low_price, op: not_null }
      - { metric: price_test_breakeven, op: not_null }
    outcome:
      funnel_stage: unit_economics
      primary_unit: pricing.price-too-low
      severity: medium
      confidence: low
      finding: "Цена сильно ниже ниши при нормальных показателях. Возможно, это осознанное позиционирование, а возможно — недобранная маржа. Если не осознанное — стоит тест поднятия цены; price_test_breakeven показывает, сколько права на ошибку у такого теста."

  - id: margin_cant_fund_ads
    priority: 40
    conditions:
      - { metric: ad_margin_gap, op: lt, value: 0 }
      - { metric: price_vs_market, op: is_null }
    outcome:
      funnel_stage: unit_economics
      primary_unit: pricing.price-too-low
      severity: medium
      confidence: low
      finding: "Маржи не хватает на продвижение. Выходов два — снизить ставку или поднять цену, и выбрать между ними без цен ниши нельзя: сравнить с рынком нечем (MPSTATS или индекс цен Ozon не подключены)."

  - id: price_level_ok
    priority: 1
    conditions: []
    outcome:
      funnel_stage: unit_economics
      primary_unit: null
      severity: low
      confidence: medium
      finding: "Признаков заниженной цены нет."
---

## problem

Правила о цене обычно защищают маржу от скидок и неявно считают, что
дешевле — значит лучше продаётся. Бывает наоборот. Реальный случай:
БАД за 700 ₽ продавался плохо, за 2000 ₽ — пошёл. Два механизма:

1. **Цена как сигнал качества.** В косметике и БАДах слишком низкая цена
   читается как «разбавленный», «подделка», «несерьёзный».
2. **Экономика продвижения.** При низкой цене после комиссии и логистики
   маржи не хватает на рекламу, трафика нет. Поднимешь цену — появятся деньги
   на продвижение.

## symptoms

- цена ниже ниши больше чем на 30% **и** реклама в минус — нельзя растить;
- цена ниже ниши больше чем на 30%, **хороший рейтинг, но мало кладут в
  корзину** — не доверяют (хороший рейтинг исключает «товар плохой»);
- цена ниже ниши больше чем на 40% при нормальных показателях — возможно,
  недобранная маржа;
- реклама в минус, а цен ниши нет — выбрать между «срезать ставку» и
  «поднять цену» нельзя, так и сказать.

## required_metrics

Цены ниши — внешний источник (MPSTATS, индекс цен Ozon). Без него три правила
из четырёх молчат, а четвёртое честно говорит, что выбрать не из чего.

## diagnosis_logic

Подъём цены — это **всегда тест, а не ответ**. Тот же подъём, который помог
БАДу, на помаде Berry обвалил продажи. Заранее не знает никто, поэтому
правило предлагает эксперимент с мерой успеха.

`price_test_breakeven` — главная цифра. «28%» значит: при цене нижней границы
ниши достаточно сохранить 28% заказов, чтобы заработать в день столько же.
Чем она ниже, тем безопаснее тест.

## recommendation_logic

- поднимать до **нижней** границы ниши, а не до медианы: ближайшая цена,
  при которой товар перестаёт выделяться дешевизной;
- тест две недели; мера успеха — маржа в день, а не число заказов;
- заказы упадут — это ожидаемо; вопрос только, упадут ли они сильнее,
  чем говорит `price_test_breakeven`;
- после подъёма пересмотреть продвижение: теперь на него есть маржа.
