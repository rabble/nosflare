// ABOUTME: Schema migration system with versioning
// ABOUTME: Tracks which migrations have been applied, supports idempotent re-runs

/**
 * Migration definition
 */
export interface Migration {
  version: number;
  description: string;
  up: (db: D1Database) => Promise<void>;
}

/**
 * All database migrations in order
 * Add new migrations to the end of this array
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema - events, tags, event_tags_cache, paid_pubkeys, content_hashes',
    up: async (db: D1Database) => {
      // This migration is already applied by the existing schema initialization
      // Marking it as applied for version tracking only
      console.log('Migration 1: Already applied (existing schema)');
    }
  },

  {
    version: 2,
    description: 'Add videos table with composite indexes for video discovery',
    up: async (db: D1Database) => {
      // Create videos table
      await db.prepare(`
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

      console.log('Created videos table');

      // Create composite indexes matching ORDER BY clauses
      // These are CRITICAL for SQLite/D1 performance

      // Global sorts (no hashtag filter)
      const globalIndexes = [
        'CREATE INDEX IF NOT EXISTS idx_videos_loops_created_id ON videos(loop_count DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_likes_created_id ON videos(likes DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_views_created_id ON videos(views DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_comments_created_id ON videos(comments DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_reposts_created_id ON videos(reposts DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_avg_completion_created_id ON videos(avg_completion DESC, created_at DESC, event_id ASC)'
      ];

      for (const sql of globalIndexes) {
        await db.prepare(sql).run();
      }

      console.log(`Created ${globalIndexes.length} global sort indexes`);

      // With hashtag constraint
      const hashtagIndexes = [
        'CREATE INDEX IF NOT EXISTS idx_videos_hashtag_loops_created_id ON videos(hashtag, loop_count DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_hashtag_likes_created_id ON videos(hashtag, likes DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_hashtag_views_created_id ON videos(hashtag, views DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_hashtag_comments_created_id ON videos(hashtag, comments DESC, created_at DESC, event_id ASC)'
      ];

      for (const sql of hashtagIndexes) {
        await db.prepare(sql).run();
      }

      console.log(`Created ${hashtagIndexes.length} hashtag-filtered sort indexes`);

      // Time window queries (recent videos sorted by metrics)
      const timeWindowIndexes = [
        'CREATE INDEX IF NOT EXISTS idx_videos_time_loops_id ON videos(created_at DESC, loop_count DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_time_likes_id ON videos(created_at DESC, likes DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_time_views_id ON videos(created_at DESC, views DESC, event_id ASC)'
      ];

      for (const sql of timeWindowIndexes) {
        await db.prepare(sql).run();
      }

      console.log(`Created ${timeWindowIndexes.length} time-window sort indexes`);
      console.log('Migration 2: Videos table and indexes created successfully');
    }
  }

  // Add future migrations here with incrementing version numbers
  // Example:
  // {
  //   version: 3,
  //   description: 'Add video_hashtags junction table for multi-hashtag support',
  //   up: async (db: D1Database) => {
  //     await db.prepare(`
  //       CREATE TABLE IF NOT EXISTS video_hashtags (
  //         event_id TEXT NOT NULL,
  //         hashtag TEXT NOT NULL,
  //         PRIMARY KEY (event_id, hashtag),
  //         FOREIGN KEY (event_id) REFERENCES videos(event_id) ON DELETE CASCADE
  //       )
  //     `).run();
  //
  //     await db.prepare(`
  //       CREATE INDEX IF NOT EXISTS idx_vh_hashtag_event ON video_hashtags(hashtag, event_id)
  //     `).run();
  //   }
  // }
];

/**
 * Run all pending migrations
 * Idempotent - safe to run multiple times
 *
 * @param db - D1 database instance
 */
export async function runMigrations(db: D1Database): Promise<void> {
  console.log('Starting migration check...');

  // Create migrations table if it doesn't exist
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT NOT NULL
    )
  `).run();

  // Run each migration if not already applied
  for (const migration of MIGRATIONS) {
    const existing = await db.prepare(
      'SELECT version FROM schema_migrations WHERE version = ?'
    ).bind(migration.version).first();

    if (!existing) {
      console.log(`Running migration ${migration.version}: ${migration.description}`);

      try {
        await migration.up(db);

        await db.prepare(
          'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
        ).bind(
          migration.version,
          Math.floor(Date.now() / 1000),
          migration.description
        ).run();

        console.log(`✓ Migration ${migration.version} completed`);
      } catch (error) {
        console.error(`✗ Migration ${migration.version} failed:`, error);
        throw error;
      }
    } else {
      console.log(`Migration ${migration.version} already applied, skipping`);
    }
  }

  console.log('All migrations completed');
}

/**
 * Get currently applied migration version
 */
export async function getCurrentVersion(db: D1Database): Promise<number> {
  try {
    const result = await db.prepare(
      'SELECT MAX(version) as version FROM schema_migrations'
    ).first();

    return (result?.version as number) || 0;
  } catch {
    // schema_migrations table doesn't exist yet
    return 0;
  }
}

/**
 * Get list of all applied migrations
 */
export async function getAppliedMigrations(db: D1Database): Promise<{
  version: number;
  applied_at: number;
  description: string;
}[]> {
  try {
    const result = await db.prepare(
      'SELECT version, applied_at, description FROM schema_migrations ORDER BY version'
    ).all();

    return result.results as any[];
  } catch {
    return [];
  }
}
