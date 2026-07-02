-- Drop config.handover_window_minutes (2026-07-02 code-vs-spec audit).
--
-- The field belonged to the spec §7.3 manual-override system
-- (dashboard bump-price / manual-cancel setting a suppression window)
-- that was retired before it ever shipped: tick.ts hardcodes the
-- override to null, no dashboard mutation buttons exist, and nothing
-- reads the column. The operator chose full retirement over keeping a
-- dormant knob. §7.3 in the spec is rewritten to match.
ALTER TABLE config DROP COLUMN handover_window_minutes;
