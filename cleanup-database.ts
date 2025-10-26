// ABOUTME: Database cleanup script - removes all events and related data
// ABOUTME: Use this to reset the database before reimporting

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log('Starting database cleanup...');

    try {
      const session = env.RELAY_DATABASE.withSession('first-primary');

      // Delete in order to respect foreign keys (if any remain)
      const tables = [
        'videos',
        'event_tags_cache',
        'content_hashes',
        'tags',
        'events'
      ];

      const stats: Record<string, number> = {};

      for (const table of tables) {
        console.log(`Deleting from ${table}...`);

        const result = await session.prepare(`DELETE FROM ${table}`).run();
        stats[table] = result.meta.changes || 0;

        console.log(`  Deleted ${stats[table]} rows from ${table}`);
      }

      // Don't delete schema_migrations or paid_pubkeys
      console.log('Cleanup complete!');

      return Response.json({
        success: true,
        deleted: stats,
        message: 'Database cleaned. Events, tags, and videos removed. Schema and migrations preserved.'
      });

    } catch (error) {
      const err = error as Error;
      console.error('Cleanup failed:', err.message);
      return Response.json({
        success: false,
        error: err.message
      }, { status: 500 });
    }
  }
};
