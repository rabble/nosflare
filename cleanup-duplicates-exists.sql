-- Cleanup using NOT EXISTS pattern (widely supported in SQLite)
-- This should work even if tuple matching doesn't

-- Step 1: Delete older kind 0 events
DELETE FROM events
WHERE kind = 0
AND EXISTS (
  SELECT 1 FROM events e2
  WHERE e2.kind = 0
  AND e2.pubkey = events.pubkey
  AND e2.created_at > events.created_at
);

-- Step 2: Delete older kind 3 events
DELETE FROM events
WHERE kind = 3
AND EXISTS (
  SELECT 1 FROM events e2
  WHERE e2.kind = 3
  AND e2.pubkey = events.pubkey
  AND e2.created_at > events.created_at
);

-- Step 3: Delete older regular replaceable events (10000-19999)
DELETE FROM events
WHERE kind >= 10000 AND kind < 20000
AND EXISTS (
  SELECT 1 FROM events e2
  WHERE e2.kind = events.kind
  AND e2.pubkey = events.pubkey
  AND e2.created_at > events.created_at
);

-- Verify: Show any remaining duplicates (should be empty)
SELECT
  pubkey,
  COUNT(*) as event_count,
  datetime(MAX(created_at), 'unixepoch') as newest_event
FROM events
WHERE kind = 0
GROUP BY pubkey
HAVING COUNT(*) > 1
LIMIT 20;
