-- #312 follow-up: 0112 added tick_metrics.max_overpay_vs_hashprice_sat_per_eh_day
-- and started recording the "max premium over hashprice" knob per tick, but left
-- every pre-0112 row NULL. The Price chart falls back to the *current* config value
-- for NULL rows, so all the history recorded before 0112 still tracked the live knob
-- (the exact bug 0112 set out to fix - it only fixed it going forward). Lowering the
-- premium therefore still dragged the whole historical effective-cap line down with it.
--
-- We can't know the true premium for those old ticks (it was never stored). The best
-- proxy is the earliest value we *did* record - the first per-tick premium after the
-- daemon picked up 0112 - carried backward over the leading NULL block. That freezes
-- the unknown past at a concrete historical value (the one in effect when we started
-- recording) instead of letting it chase the current config. Future knob changes then
-- only move the line from the change forward, which is the whole point.
--
-- Scope is the leading NULL block only (tick_at < the first recorded value's tick_at),
-- so a later NULL from disabling the dynamic cap is left alone and handled by the live
-- fallback. No-op when the dynamic cap was never enabled (no non-NULL row exists, so
-- the MIN(tick_at) subquery is NULL and the predicate matches nothing).

UPDATE tick_metrics
SET max_overpay_vs_hashprice_sat_per_eh_day = (
  SELECT max_overpay_vs_hashprice_sat_per_eh_day
  FROM tick_metrics
  WHERE max_overpay_vs_hashprice_sat_per_eh_day IS NOT NULL
  ORDER BY tick_at ASC
  LIMIT 1
)
WHERE max_overpay_vs_hashprice_sat_per_eh_day IS NULL
  AND tick_at < (
    SELECT MIN(tick_at)
    FROM tick_metrics
    WHERE max_overpay_vs_hashprice_sat_per_eh_day IS NOT NULL
  );
