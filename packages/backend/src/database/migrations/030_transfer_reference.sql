-- Migration 030: transfer_reference — system-minted transfer reference
--
-- Transfers displayed a bare sequence integer (#28) as their only identifier,
-- which is ambiguous next to transaction_number and impossible to quote with
-- confidence. The transfers table already carried transfer_reference and
-- external_reference columns, but nothing ever wrote or read them, so the
-- reference an operator would actually need did not exist in practice.
--
-- transfer_reference becomes our own minted identifier:
--
--     TRF-2026-000028   ^^^ ^^^^ ^^^^^^
--                        |   |    transfer_number, zero padded
--                        |    UTC year the row was created
--                        fixed type prefix
--
-- Uniqueness comes entirely from transfer_number, which is a sequence that is
-- never reset. The year is a LABEL, not part of the key — which is why the
-- sequence must not be reset annually either. Resetting it each year would
-- mean deriving the next value from max(transfer_number)+1, racing concurrent
-- inserts and risking the same reference being minted twice. Keeping one
-- global sequence makes collisions structurally impossible: TRF-2026-000105
-- is simply followed by TRF-2027-000106.
--
-- The backfill below deliberately avoids to_char(..., 'FM000000') and
-- lpad(...): both silently fail once the number exceeds the pattern width
-- (to_char returns '######', lpad truncates), which would have made every
-- transfer past #999999 collide on the unique constraint. repeat()/length()
-- pads only when there is room and leaves longer numbers intact.
--
-- external_reference is left untouched. It holds the counterparty's own
-- reference — a bank or wallet reference — and mixing a self-minted value into
-- it would poison any future statement matching.
--
-- Created at insert and never rewritten, including on reversal: a reference
-- that changes is worthless as an identifier. No UPDATE in the codebase
-- touches this column.

BEGIN;

UPDATE transfers
SET transfer_reference =
      'TRF-'
      || to_char(created_at AT TIME ZONE 'UTC', 'YYYY')
      || '-'
      || repeat('0', GREATEST(0, 6 - length(transfer_number::text)))
      || transfer_number::text
WHERE transfer_reference IS NULL
  AND transfer_number IS NOT NULL;

ALTER TABLE transfers ALTER COLUMN transfer_reference SET NOT NULL;

ALTER TABLE transfers
  ADD CONSTRAINT transfers_transfer_reference_key UNIQUE (transfer_reference);

COMMIT;

-- Migration:down
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_transfer_reference_key;

ALTER TABLE transfers ALTER COLUMN transfer_reference DROP NOT NULL;
