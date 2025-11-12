-- Simpler cleanup approach that definitely works in SQLite/D1
-- Uses MAX(created_at) to identify the newest event to keep

-- Step 1: Delete older kind 0 events
-- Keep only the one with MAX(created_at) for each pubkey
DELETE FROM events
WHERE kind = 0
AND (pubkey, created_at) NOT IN (
  SELECT pubkey, MAX(created_at)
  FROM events
  WHERE kind = 0
  GROUP BY pubkey
);

-- Step 2: Delete older kind 3 events
DELETE FROM events
WHERE kind = 3
AND (pubkey, created_at) NOT IN (
  SELECT pubkey, MAX(created_at)
  FROM events
  WHERE kind = 3
  GROUP BY pubkey
);

-- Step 3: Delete older regular replaceable events (10000-19999)
DELETE FROM events
WHERE kind >= 10000 AND kind < 20000
AND (pubkey, kind, created_at) NOT IN (
  SELECT pubkey, kind, MAX(created_at)
  FROM events
  WHERE kind >= 10000 AND kind < 20000
  GROUP BY pubkey, kind
);

-- Verify: Check for any remaining duplicates
SELECT
  'VERIFICATION' as check_type,
  kind,
  COUNT(*) as total_events,
  COUNT(DISTINCT pubkey) as unique_authors,
  CASE WHEN COUNT(*) = COUNT(DISTINCT pubkey) THEN 'PASS' ELSE 'FAIL' END as status
FROM events
WHERE kind IN (0, 3) OR (kind >= 10000 AND kind < 20000)
GROUP BY kind
ORDER BY kind;
