// ABOUTME: Quick script to verify video_hashtags table was populated with existing data
// ABOUTME: Compares videos.hashtag column with video_hashtags junction table

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const db = env.RELAY_DATABASE;

      // Count videos with hashtags in the old column
      const videosWithHashtags = await db.prepare(`
        SELECT COUNT(*) as count
        FROM videos
        WHERE hashtag IS NOT NULL AND hashtag != ''
      `).first();

      // Count unique event_ids in video_hashtags
      const junctionCount = await db.prepare(`
        SELECT COUNT(DISTINCT event_id) as count
        FROM video_hashtags
      `).first();

      // Sample comparison - show first 10 videos and their hashtags in both places
      const sampleVideos = await db.prepare(`
        SELECT
          v.event_id,
          v.hashtag as old_hashtag,
          (SELECT GROUP_CONCAT(hashtag, ',')
           FROM video_hashtags vh
           WHERE vh.event_id = v.event_id) as new_hashtags
        FROM videos v
        WHERE v.hashtag IS NOT NULL AND v.hashtag != ''
        LIMIT 10
      `).all();

      // Check for videos with hashtags that are NOT in the junction table
      const missing = await db.prepare(`
        SELECT COUNT(*) as count
        FROM videos v
        WHERE v.hashtag IS NOT NULL
          AND v.hashtag != ''
          AND NOT EXISTS (
            SELECT 1 FROM video_hashtags vh
            WHERE vh.event_id = v.event_id
          )
      `).first();

      return Response.json({
        success: true,
        counts: {
          videosWithHashtags: videosWithHashtags.count,
          eventsInJunctionTable: junctionCount.count,
          missingFromJunctionTable: missing.count
        },
        sampleComparison: sampleVideos.results,
        allMigrated: missing.count === 0
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
