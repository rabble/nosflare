// ABOUTME: Worker to directly query events table and check if events exist
// ABOUTME: Used to debug missing events issue

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Check total events count
      const countResult = await env.RELAY_DATABASE.prepare(
        'SELECT COUNT(*) as count FROM events'
      ).first();

      // Check kind 34236 events specifically
      const kind34236Count = await env.RELAY_DATABASE.prepare(
        'SELECT COUNT(*) as count FROM events WHERE kind = 34236'
      ).first();

      // Get sample events
      const sampleEvents = await env.RELAY_DATABASE.prepare(`
        SELECT id, kind, pubkey, created_at
        FROM events
        ORDER BY created_at DESC
        LIMIT 10
      `).all();

      // Get kind 34236 sample
      const videoEvents = await env.RELAY_DATABASE.prepare(`
        SELECT id, kind, pubkey, created_at
        FROM events
        WHERE kind = 34236
        ORDER BY created_at DESC
        LIMIT 10
      `).all();

      // Check videos table for comparison
      const videosCount = await env.RELAY_DATABASE.prepare(
        'SELECT COUNT(*) as count FROM videos'
      ).first();

      return Response.json({
        total_events: countResult?.count || 0,
        kind_34236_events: kind34236Count?.count || 0,
        videos_table_count: videosCount?.count || 0,
        sample_events: sampleEvents.results,
        video_events: videoEvents.results,
        diagnosis: {
          events_table_empty: (countResult?.count || 0) === 0,
          videos_populated_but_no_events: ((videosCount?.count || 0) > 0 && (kind34236Count?.count || 0) === 0),
          mismatch: (videosCount?.count || 0) !== (kind34236Count?.count || 0)
        }
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
