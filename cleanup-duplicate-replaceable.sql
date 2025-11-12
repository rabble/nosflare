-- Cleanup script for duplicate replaceable events
-- This removes older versions of replaceable events, keeping only the latest

-- Clean up duplicate kind 0 (metadata) events
-- Keep only the newest event for each pubkey
DELETE FROM events
WHERE id IN (
  SELECT e1.id
  FROM events e1
  INNER JOIN events e2 ON e1.pubkey = e2.pubkey AND e1.kind = e2.kind
  WHERE e1.kind = 0
  AND e1.created_at < e2.created_at
);

-- Clean up duplicate kind 3 (contact list) events
DELETE FROM events
WHERE id IN (
  SELECT e1.id
  FROM events e1
  INNER JOIN events e2 ON e1.pubkey = e2.pubkey AND e1.kind = e2.kind
  WHERE e1.kind = 3
  AND e1.created_at < e2.created_at
);

-- Clean up duplicate regular replaceable events (10000-19999)
DELETE FROM events
WHERE id IN (
  SELECT e1.id
  FROM events e1
  INNER JOIN events e2 ON e1.pubkey = e2.pubkey AND e1.kind = e2.kind
  WHERE e1.kind >= 10000 AND e1.kind < 20000
  AND e1.created_at < e2.created_at
);

-- Count remaining events by kind
SELECT
  kind,
  COUNT(*) as event_count,
  COUNT(DISTINCT pubkey) as unique_authors
FROM events
WHERE kind IN (0, 3) OR (kind >= 10000 AND kind < 20000)
GROUP BY kind
ORDER BY kind;
