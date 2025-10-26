// ABOUTME: Check videos table data
// ABOUTME: Debug helper to see what's in the videos table

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Count total
      const countResult = await env.RELAY_DATABASE.prepare(
        'SELECT COUNT(*) as count FROM videos'
      ).first();

      // Get sample with metrics
      const sampleResult = await env.RELAY_DATABASE.prepare(`
        SELECT event_id, author, loop_count, likes, views, comments, hashtag
        FROM videos
        ORDER BY loop_count DESC
        LIMIT 10
      `).all();

      // Get stats
      const statsResult = await env.RELAY_DATABASE.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN loop_count > 0 THEN 1 ELSE 0 END) as has_loops,
          SUM(CASE WHEN likes > 0 THEN 1 ELSE 0 END) as has_likes,
          SUM(CASE WHEN views > 0 THEN 1 ELSE 0 END) as has_views,
          MAX(loop_count) as max_loops,
          MAX(likes) as max_likes,
          MAX(views) as max_views
        FROM videos
      `).first();

      return Response.json({
        count: countResult?.count || 0,
        stats: statsResult,
        sample: sampleResult.results
      }, {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      const err = error as Error;
      return Response.json({
        error: err.message,
        stack: err.stack
      }, { status: 500 });
    }
  }
};
