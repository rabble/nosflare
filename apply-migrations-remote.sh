#!/bin/bash
# ABOUTME: Script to apply missing migrations 3 and 4 directly via wrangler d1 execute --remote
# ABOUTME: This fixes the production database that skipped these migrations

set -e

echo "🔍 Checking current migration state..."
wrangler d1 execute --remote RELAY_DATABASE --command="SELECT version, description FROM schema_migrations ORDER BY version"

echo ""
echo "📦 Applying Migration 3: video_hashtags junction table..."

# Create video_hashtags table
wrangler d1 execute --remote RELAY_DATABASE --command="
CREATE TABLE IF NOT EXISTS video_hashtags (
  event_id TEXT NOT NULL,
  hashtag TEXT NOT NULL,
  PRIMARY KEY (event_id, hashtag)
)"

# Create indexes
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_vh_hashtag ON video_hashtags(hashtag, event_id)"
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_vh_event ON video_hashtags(event_id)"

# Migrate existing data
wrangler d1 execute --remote RELAY_DATABASE --command="
INSERT INTO video_hashtags (event_id, hashtag)
SELECT event_id, hashtag
FROM videos
WHERE hashtag IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM video_hashtags WHERE video_hashtags.event_id = videos.event_id AND video_hashtags.hashtag = videos.hashtag)
"

# Mark as applied
wrangler d1 execute --remote RELAY_DATABASE --command="
INSERT OR IGNORE INTO schema_migrations (version, applied_at, description)
VALUES (3, $(date +%s), 'Add video_hashtags junction table for multi-hashtag support')
"

echo "✅ Migration 3 applied"

echo ""
echo "📦 Applying Migration 4: author-scoped indexes..."

# Create author indexes
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_videos_author_loops_created_id ON videos(author, loop_count DESC, created_at DESC, event_id ASC)"
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_videos_author_likes_created_id ON videos(author, likes DESC, created_at DESC, event_id ASC)"
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_videos_author_views_created_id ON videos(author, views DESC, created_at DESC, event_id ASC)"
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_videos_author_comments_created_id ON videos(author, comments DESC, created_at DESC, event_id ASC)"
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_videos_author_reposts_created_id ON videos(author, reposts DESC, created_at DESC, event_id ASC)"
wrangler d1 execute --remote RELAY_DATABASE --command="CREATE INDEX IF NOT EXISTS idx_videos_author_created_id ON videos(author, created_at DESC, event_id ASC)"

# Mark as applied
wrangler d1 execute --remote RELAY_DATABASE --command="
INSERT OR IGNORE INTO schema_migrations (version, applied_at, description)
VALUES (4, $(date +%s), 'Add author-scoped composite indexes for per-author video queries')
"

echo "✅ Migration 4 applied"

echo ""
echo "🎉 Final migration state:"
wrangler d1 execute --remote RELAY_DATABASE --command="SELECT version, description, datetime(applied_at, 'unixepoch') as applied FROM schema_migrations ORDER BY version"

echo ""
echo "✅ All migrations applied successfully!"
