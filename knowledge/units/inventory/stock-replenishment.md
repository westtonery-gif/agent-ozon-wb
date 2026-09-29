---
id: inventory.stock-replenishment
title: Сток и подсортировка — дефицит, залежавшийся товар, срок годности
category: inventory
agents: [ozonologist]
keywords:
  [
    сток,
    остаток,
    остатки,
    подсортировка,
    подсортировать,
    отгрузк,
    поставк,
    оборачиваемост,
    запас,
    хватит,
    закончится,
    дефицит,
    out of stock,
    залежал,
    неликвид,
    срок годности,
    списание,
    производство,
  ]
required_metrics:
  [
    stock,
    orders_30d,
    price,
    stock_days,
    supply_lead_days,
    cover_gap_days,
    shelf_life_left_days,
    shelf_life_left_pct,
  ]
# Правила машиночитаемы: движок применяет по убыванию priority,
# первое совпавшее = primary. Условия внутри правила соединяются по И.
diagnosis_rules:
  - id: stockout
    priority: 100 # товара нет — продажи равны нулю прямо сейчас
    conditions:
      - { metric: stock, op: eq, value: 0 }
    outcome:
      funnel_stage: availability
      primary_unit: inventory.stock-replenishment
      severity: critical
      confidence: high
      finding: "Остаток 0 — товар не продаётся и теряет позиции в выдаче. Это перебивает все прочие причины."

  - id: expiry_risk
    priority: 80 # срок горит быстрее, чем уходит остаток
    conditions:
      - { metric: shelf_life_left_pct, op: not_null }
      - { metric: shelf_life_left_pct, op: lt, value: 40 }
    outcome:
      funnel_stage: availability
      primary_unit: inventory.stock-replenishment
      severity: high
      confidence: high
      finding: "Остаточный срок годности партии ниже 40%. Для косметики это зона уценки и риска списания: приёмка и продажа ограничиваются по остаточному сроку."

  - id: replenishment_overdue
    priority: 70
    conditions:
      - { metric: cover_gap_days, op: not_null }
      - { metric: cover_gap_days, op: lt, value: 0 }
    outcome:
      funnel_stage: availability
      primary_unit: inventory.stock-replenishment
      severity: high
      confidence: high
      finding: "Остатка хватит на меньший срок, чем занимает производство и поставка. Подсортировка уже опоздала — товар уйдёт в ноль до прихода партии."

  - id: dead_stock
    priority: 50
    conditions:
      - { metric: stock_days, op: not_null }
      # 9 месяцев, а не полгода: при сроке годности 2 года полугодовой запас
      # для сезонной косметики — ещё рабочая норма, а не замороженные деньги.
      - { metric: stock_days, op: gt, value: 270 }
    outcome:
      funnel_stage: availability
      primary_unit: inventory.stock-replenishment
      severity: medium
      confidence: high
      finding: "Запаса хватит более чем на 9 месяцев при текущем темпе. Деньги заморожены в стоке, а срок годности идёт."

  - id: replenishment_soon
    priority: 40
    conditions:
      - { metric: cover_gap_days, op: not_null }
      - { metric: cover_gap_days, op: lt, value: 14 }
    outcome:
      funnel_stage: availability
      primary_unit: inventory.stock-replenishment
      severity: medium
      confidence: medium
      finding: "Запас времени до дефицита меньше двух недель сверх срока поставки. Пора ставить партию в план производства."

  - id: stock_healthy
    priority: 1
    conditions: []
    outcome:
      funnel_stage: availability
      primary_unit: null
      severity: low
      confidence: medium
      finding: "По остаткам и срокам критичных отклонений нет."
---

## problem

Товар либо кончается раньше, чем приедет новая партия, либо лежит мёртвым грузом
и тратит срок годности. В косметике второе дороже, чем кажется: просроченная
партия не уценивается, а списывается.

## symptoms

- `stock = 0` — прямая потеря продаж и позиций в выдаче;
- `cover_gap_days < 0` — остатка хватит на меньше дней, чем занимает производство;
- `shelf_life_left_pct < 40` — партия не доживёт до продажи в нормальной цене;
- `stock_days > 270` — замороженные деньги.

## required_metrics

stock, orders_30d, stock_days, supply_lead_days, cover_gap_days,
shelf_life_left_days, shelf_life_left_pct.

Себестоимость, лид-тайм и дата партии живут в ERP продавца, а не в Ozon.
В живом режиме без них метрики остаются `unknown`, и движок говорит
«нет данных», а не подставляет ноль.

## diagnosis_logic

См. `diagnosis_rules`. Порядок приоритетов отражает деньги, а не удобство:
нулевой остаток теряет выручку сегодня, горящий срок — всю партию,
опоздавшая подсортировка — ближайшие недели.

## recommendation_logic

Всегда называть конкретный SKU, число дней и дату, к которой нужно действие:

- `stockout` → срочная отгрузка с ближайшего склада; параллельно проверить,
  не потеряна ли позиция в выдаче (после возврата в сток она восстанавливается не сразу);
- `replenishment_overdue` / `replenishment_soon` → запустить партию в производство
  сейчас, объём считать от темпа продаж за 30 дней и срока поставки;
- `expiry_risk` → уценка, промо-механика или списание; решение принимается
  по остаточному сроку, а не по остатку;
- `dead_stock` → не подсортировывать, а разгружать: акция, набор, вывод из матрицы.
