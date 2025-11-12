-- Alternative cleanup approach for D1
-- This uses a different strategy that should work better with D1's SQLite

-- Step 1: Delete older kind 0 events, keeping only the newest per pubkey
DELETE FROM events
WHERE kind = 0
AND id NOT IN (
  SELECT id FROM (
    SELECT id, pubkey, created_at,
           ROW_NUMBER() OVER (PARTITION BY pubkey ORDER BY created_at DESC) as rn
    FROM events
    WHERE kind = 0
  )
  WHERE rn = 1
);

-- Step 2: Delete older kind 3 events, keeping only the newest per pubkey
DELETE FROM events
WHERE kind = 3
AND id NOT IN (
  SELECT id FROM (
    SELECT id, pubkey, created_at,
           ROW_NUMBER() OVER (PARTITION BY pubkey ORDER BY created_at DESC) as rn
    FROM events
    WHERE kind = 3
  )
  WHERE rn = 1
);

-- Step 3: Delete older regular replaceable events (10000-19999)
DELETE FROM events
WHERE kind >= 10000 AND kind < 20000
AND id NOT IN (
  SELECT id FROM (
    SELECT id, pubkey, kind, created_at,
           ROW_NUMBER() OVER (PARTITION BY pubkey, kind ORDER BY created_at DESC) as rn
    FROM events
    WHERE kind >= 10000 AND kind < 20000
  )
  WHERE rn = 1
);

-- Verify: Show remaining event counts
SELECT
  kind,
  COUNT(*) as event_count,
  COUNT(DISTINCT pubkey) as unique_authors
FROM events
WHERE kind IN (0, 3) OR (kind >= 10000 AND kind < 20000)
GROUP BY kind
ORDER BY kind;
