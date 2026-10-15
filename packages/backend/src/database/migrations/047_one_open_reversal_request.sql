-- Migration:up
-- One open cancellation request per record. The approval path locks the request
-- row it was given, so two pending requests for the same record would race
-- their approvers: the second approve would only find out its record had
-- already moved after the first had posted. The half-open index (pending only)
-- closes the door at the source without touching decided requests, whose
-- history stays append-only like everything else.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_reversals_open
  ON pending_reversals (entity_type, entity_id)
  WHERE status = 'pending';

-- Migration:down

DROP INDEX IF EXISTS uq_pending_reversals_open;
