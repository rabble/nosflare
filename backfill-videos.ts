// ABOUTME: Backfill script to populate videos table from kind 34236 events
// ABOUTME: Extracts metrics from tags (loops, likes, comments, reposts) and inserts into videos table

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log('Starting videos table backfill...');

    try {
      // Create videos table if it doesn't exist
      console.log('Creating videos table...');
      await env.RELAY_DATABASE.prepare(`
        CREATE TABLE IF NOT EXISTS videos (
          event_id TEXT PRIMARY KEY,
          author TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          loop_count INTEGER NOT NULL DEFAULT 0,
          likes INTEGER NOT NULL DEFAULT 0,
          comments INTEGER NOT NULL DEFAULT 0,
          reposts INTEGER NOT NULL DEFAULT 0,
          views INTEGER NOT NULL DEFAULT 0,
          avg_completion INTEGER NOT NULL DEFAULT 0,
          hashtag TEXT,
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        )
      `).run();

      // Create indexes
      await env.RELAY_DATABASE.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_loops_created ON videos(loop_count DESC, created_at DESC)
      `).run();
      await env.RELAY_DATABASE.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_likes_created ON videos(likes DESC, created_at DESC)
      `).run();
      await env.RELAY_DATABASE.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_views_created ON videos(views DESC, created_at DESC)
      `).run();
      await env.RELAY_DATABASE.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_hashtag_loops ON videos(hashtag, loop_count DESC, created_at DESC)
      `).run();
      await env.RELAY_DATABASE.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC)
      `).run();

      console.log('Videos table created successfully');

      const stats = {
        total: 0,
        inserted: 0,
        updated: 0,
        errors: 0
      };

      // Get all kind 34236 events
      const events = await env.RELAY_DATABASE.prepare(`
        SELECT id, pubkey, created_at, tags
        FROM events
        WHERE kind = 34236
        ORDER BY created_at
      `).all();

      console.log(`Found ${events.results?.length || 0} video events`);

      for (const row of events.results || []) {
        stats.total++;

        try {
          const eventId = row.id as string;
          const author = row.pubkey as string;
          const createdAt = row.created_at as number;
          const tagsJson = row.tags as string;

          // Parse tags
          const tags: string[][] = JSON.parse(tagsJson);

          // Extract metrics from tags
          const getTagValue = (tagName: string): number => {
            const tag = tags.find(t => t[0] === tagName);
            return tag && tag[1] ? parseInt(tag[1], 10) || 0 : 0;
          };

          const loopCount = getTagValue('loops');
          const likes = getTagValue('likes');
          const comments = getTagValue('comments');
          const reposts = getTagValue('reposts');

          // Extract first hashtag if any (from 't' tags)
          const tTags = tags.filter(t => t[0] === 't');
          const hashtag = tTags.length > 0 ? tTags[0][1] : null;

          // Upsert into videos table
          const result = await env.RELAY_DATABASE.prepare(`
            INSERT INTO videos (event_id, author, created_at, loop_count, likes, comments, reposts, views, avg_completion, hashtag)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
            ON CONFLICT(event_id) DO UPDATE SET
              loop_count = excluded.loop_count,
              likes = excluded.likes,
              comments = excluded.comments,
              reposts = excluded.reposts,
              hashtag = excluded.hashtag
          `).bind(eventId, author, createdAt, loopCount, likes, comments, reposts, hashtag).run();

          if (result.meta.changes > 0) {
            stats.inserted++;
          } else {
            stats.updated++;
          }

          if (stats.total % 100 === 0) {
            console.log(`Processed ${stats.total} events...`);
          }

        } catch (error) {
          const err = error as Error;
          console.error(`Error processing event ${eventId}:`, err.message, err.stack);
          stats.errors++;

          // Log first error details for debugging
          if (stats.errors === 1) {
            console.error('First error details:', {
              eventId,
              author,
              createdAt,
              error: err.message
            });
          }
        }
      }

      console.log('Backfill complete:', stats);
      return new Response(JSON.stringify(stats, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      const err = error as Error;
      console.error('Backfill failed:', err);
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
