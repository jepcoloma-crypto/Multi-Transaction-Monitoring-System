-- Migration 039: an operating expense below a threshold settles at once
--
-- Until now every operating expense landed as a pending request, administrator
-- included: the two-person rule applied to a ₱200 roll of receipt paper the
-- same way it applied to a ₱200,000 lease payment, so small purchases waited on
-- a second signature that added nothing.
--
-- The limit is a business decision rather than a structural one, so it lives in
-- system_settings beside the other thresholds and an administrator can move it
-- without a deploy. The route reads 0 when the row is absent, and 0 sends every
-- expense through approval — the behaviour this setting exists to relax, and
-- the safe direction to fail in.

INSERT INTO system_settings (key, value, description) VALUES
  ('expense_approval_threshold', '3000', 'Operating expenses above this amount need approval; at or below it they settle immediately')
ON CONFLICT (key) DO NOTHING;

-- Migration:down
--
-- Deletes the setting. The route falls back to 0, so every operating expense
-- needs approval again — the state before this migration.

DELETE FROM system_settings WHERE key = 'expense_approval_threshold';
