// ABOUTME: Quick check to verify database is intact after deployments
// ABOUTME: Returns counts of all tables to confirm nothing was lost

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const db = env.RELAY_DATABASE;

      // Get counts from all tables
      const events = await db.prepare('SELECT COUNT(*) as count FROM events').first();
      const videos = await db.prepare('SELECT COUNT(*) as count FROM videos').first();
      const tags = await db.prepare('SELECT COUNT(*) as count FROM tags').first();
      const videoHashtags = await db.prepare('SELECT COUNT(*) as count FROM video_hashtags').first();
      const videoMentions = await db.prepare('SELECT COUNT(*) as count FROM video_mentions').first();
      const videoReferences = await db.prepare('SELECT COUNT(*) as count FROM video_references').first();
      const videoAddresses = await db.prepare('SELECT COUNT(*) as count FROM video_addresses').first();

      // Get migrations status
      const migrations = await db.prepare(
        'SELECT version, description FROM schema_migrations ORDER BY version'
      ).all();

      return Response.json({
        success: true,
        counts: {
          events: events.count,
          videos: videos.count,
          tags: tags.count,
          video_hashtags: videoHashtags.count,
          video_mentions: videoMentions.count,
          video_references: videoReferences.count,
          video_addresses: videoAddresses.count
        },
        migrations: migrations.results
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return Response.json({
        success: false,
        error: error.message,
        stack: error.stack
      }, {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
