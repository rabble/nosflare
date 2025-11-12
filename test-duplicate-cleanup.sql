-- TEST QUERY: Shows what WOULD be deleted (without actually deleting)
-- Run this first to verify the logic is correct

-- Show duplicate kind 0 events that would be deleted
-- (keeping only the newest per pubkey)
SELECT
  'KIND 0 - TO DELETE' as action,
  e1.id,
  e1.pubkey,
  e1.created_at as old_timestamp,
  e2.created_at as newer_timestamp,
  datetime(e1.created_at, 'unixepoch') as old_date,
  datetime(e2.created_at, 'unixepoch') as newer_date
FROM events e1
INNER JOIN events e2 ON e1.pubkey = e2.pubkey AND e1.kind = e2.kind
WHERE e1.kind = 0
AND e1.created_at < e2.created_at
ORDER BY e1.pubkey, e1.created_at
LIMIT 50;

-- Count how many would be deleted per kind
SELECT
  'DELETION SUMMARY' as report,
  kind,
  COUNT(*) as events_to_delete
FROM events e1
WHERE EXISTS (
  SELECT 1 FROM events e2
  WHERE e1.pubkey = e2.pubkey
  AND e1.kind = e2.kind
  AND e1.created_at < e2.created_at
)
AND kind IN (0, 3)
GROUP BY kind;

-- Show what would REMAIN after cleanup
SELECT
  'AFTER CLEANUP' as report,
  kind,
  COUNT(*) as events_remaining,
  COUNT(DISTINCT pubkey) as unique_authors
FROM events
WHERE kind IN (0, 3)
AND NOT EXISTS (
  SELECT 1 FROM events e2
  WHERE events.pubkey = e2.pubkey
  AND events.kind = e2.kind
  AND events.created_at < e2.created_at
)
GROUP BY kind;

-- Sample: Show which specific events would be KEPT for kind 0
-- (these should be the newest for each author)
SELECT
  'KIND 0 - TO KEEP' as action,
  id,
  pubkey,
  created_at,
  datetime(created_at, 'unixepoch') as date,
  substr(content, 1, 100) as content_preview
FROM events
WHERE kind = 0
AND NOT EXISTS (
  SELECT 1 FROM events e2
  WHERE events.pubkey = e2.pubkey
  AND events.kind = 0
  AND events.created_at < e2.created_at
)
ORDER BY pubkey
LIMIT 20;
