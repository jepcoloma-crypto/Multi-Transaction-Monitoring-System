-- Migration 038: a shift belongs to one calendar day
--
-- Until now a shift only knew the instant it opened (`opened_at`), so there was
-- nothing to hold a transaction's date against: a shift opened at 01:00 and a
-- transaction typed for the previous day were never compared, because there was
-- no day to compare them to. D17 answered "is the branch open"; it could not
-- answer "is it open for *this* date".
--
-- shift_date is DATE rather than timestamptz on purpose. It is not an instant —
-- it is the operator's statement that these movements belong to one Philippine
-- business day, and a business day has no offset. The instant stays in
-- opened_at/closed_at as timestamptz in UTC (design §6).
--
-- Backfill is derived from when the shift actually opened, read in Manila, not
-- from an invented date. On this deployment no shifts exist yet, so the UPDATE
-- touches nothing; it is written so the migration is correct wherever it runs.

ALTER TABLE shifts ADD COLUMN shift_date DATE;

UPDATE shifts
   SET shift_date = (opened_at AT TIME ZONE 'Asia/Manila')::date
 WHERE shift_date IS NULL;

ALTER TABLE shifts ALTER COLUMN shift_date SET NOT NULL;

-- Migration:down
--
-- Drops the column. On a deployment where shifts exist this discards the day
-- each one covered, so it is only safe while the table is still empty or its
-- shifts are expendable — the instants in opened_at survive either way and the
-- day could be recovered from them.

ALTER TABLE shifts DROP COLUMN IF EXISTS shift_date;
