// ABOUTME: One-time script to run all migrations on production database
// ABOUTME: Calls the standard runMigrations() function to apply any missing migrations

import { runMigrations } from './src/migrations';

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const db = env.RELAY_DATABASE;

      // Check what tables exist before
      const tablesBefore = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all();

      // Check migration state before (if schema_migrations exists)
      let migrationsBefore: any[] = [];
      try {
        const result = await db.prepare(
          'SELECT version, description FROM schema_migrations ORDER BY version'
        ).all();
        migrationsBefore = result.results;
      } catch (e) {
        // schema_migrations table doesn't exist yet
      }

      // Run the standard migration function
      await runMigrations(db);

      // Check migration state after
      const migrationsAfter = await db.prepare(
        'SELECT version, description FROM schema_migrations ORDER BY version'
      ).all();

      // Check what tables exist after
      const tablesAfter = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all();

      return Response.json({
        success: true,
        before: {
          tables: tablesBefore.results,
          migrations: migrationsBefore
        },
        after: {
          tables: tablesAfter.results,
          migrations: migrationsAfter.results
        }
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
