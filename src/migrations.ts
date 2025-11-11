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
          hashtag TEXT
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
  },

  {
    version: 3,
    description: 'Add video_hashtags junction table for multi-hashtag support',
    up: async (db: D1Database) => {
      // Create video_hashtags junction table
      // This enables videos to have multiple hashtags instead of single hashtag column
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS video_hashtags (
          event_id TEXT NOT NULL,
          hashtag TEXT NOT NULL,
          PRIMARY KEY (event_id, hashtag)
        )
      `).run();

      console.log('Created video_hashtags table');

      // Create indexes for efficient hashtag queries
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_vh_hashtag ON video_hashtags(hashtag, event_id)
      `).run();

      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_vh_event ON video_hashtags(event_id)
      `).run();

      console.log('Created video_hashtags indexes');

      // Migrate existing hashtag data from videos.hashtag column
      // Only migrate non-null hashtags
      await db.prepare(`
        INSERT INTO video_hashtags (event_id, hashtag)
        SELECT event_id, hashtag
        FROM videos
        WHERE hashtag IS NOT NULL
      `).run();

      console.log('Migrated existing hashtags to video_hashtags table');
      console.log('Migration 3: video_hashtags junction table created successfully');
    }
  },

  {
    version: 4,
    description: 'Add author-scoped composite indexes for per-author video queries',
    up: async (db: D1Database) => {
      // Create composite indexes for author-specific queries
      // These support filtering by author AND sorting by metrics
      // Index order: (author, metric DESC, created_at DESC, event_id ASC)

      const authorIndexes = [
        'CREATE INDEX IF NOT EXISTS idx_videos_author_loops_created_id ON videos(author, loop_count DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_author_likes_created_id ON videos(author, likes DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_author_views_created_id ON videos(author, views DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_author_comments_created_id ON videos(author, comments DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_author_reposts_created_id ON videos(author, reposts DESC, created_at DESC, event_id ASC)',
        'CREATE INDEX IF NOT EXISTS idx_videos_author_created_id ON videos(author, created_at DESC, event_id ASC)'
      ];

      for (const sql of authorIndexes) {
        await db.prepare(sql).run();
      }

      console.log(`Created ${authorIndexes.length} author-scoped sort indexes`);
      console.log('Migration 4: Author indexes created successfully');
    }
  },

  {
    version: 5,
    description: 'Add junction tables for mentions (#p), references (#e), and addresses (#a) tags',
    up: async (db: D1Database) => {
      // Create video_mentions table for #p tags (pubkey mentions)
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS video_mentions (
          event_id TEXT NOT NULL,
          pubkey TEXT NOT NULL,
          PRIMARY KEY (event_id, pubkey)
        )
      `).run();

      console.log('Created video_mentions table');

      // Create indexes for mention queries
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_vm_pubkey ON video_mentions(pubkey, event_id)
      `).run();

      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_vm_event ON video_mentions(event_id)
      `).run();

      console.log('Created video_mentions indexes');

      // Create video_references table for #e tags (event references)
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS video_references (
          event_id TEXT NOT NULL,
          referenced_event_id TEXT NOT NULL,
          PRIMARY KEY (event_id, referenced_event_id)
        )
      `).run();

      console.log('Created video_references table');

      // Create indexes for reference queries
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_vr_ref_event ON video_references(referenced_event_id, event_id)
      `).run();

      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_vr_event ON video_references(event_id)
      `).run();

      console.log('Created video_references indexes');

      // Create video_addresses table for #a tags (addressable event references)
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS video_addresses (
          event_id TEXT NOT NULL,
          address TEXT NOT NULL,
          PRIMARY KEY (event_id, address)
        )
      `).run();

      console.log('Created video_addresses table');

      // Create indexes for address queries
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_va_address ON video_addresses(address, event_id)
      `).run();

      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_va_event ON video_addresses(event_id)
      `).run();

      console.log('Created video_addresses indexes');
      console.log('Migration 5: Tag junction tables created successfully');
    }
  },

  {
    version: 6,
    description: 'Add ProofMode verification columns and indexes for video authenticity',
    up: async (db: D1Database) => {
      // Add ProofMode verification columns to videos table
      await db.prepare(`
        ALTER TABLE videos ADD COLUMN verification_level TEXT
      `).run();

      await db.prepare(`
        ALTER TABLE videos ADD COLUMN has_proofmode INTEGER DEFAULT 0
      `).run();

      await db.prepare(`
        ALTER TABLE videos ADD COLUMN has_device_attestation INTEGER DEFAULT 0
      `).run();

      await db.prepare(`
        ALTER TABLE videos ADD COLUMN has_pgp_signature INTEGER DEFAULT 0
      `).run();

      console.log('Added ProofMode columns to videos table');

      // Create indexes for ProofMode filtering
      // Index for filtering by verification level
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_verification ON videos(verification_level)
      `).run();

      // Index for filtering by has_proofmode flag
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_proofmode ON videos(has_proofmode)
      `).run();

      // Index for filtering by device attestation
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_device_attestation ON videos(has_device_attestation)
      `).run();

      // Composite index for verification-aware sorting (loops)
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_verification_loops ON videos(verification_level, loop_count DESC, created_at DESC, event_id ASC)
      `).run();

      // Composite index for verification-aware sorting (likes)
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_videos_verification_likes ON videos(verification_level, likes DESC, created_at DESC, event_id ASC)
      `).run();

      console.log('Created ProofMode indexes');
      console.log('Migration 6: ProofMode verification support added successfully');
    }
  },

  {
    version: 7,
    description: 'Create FTS5 virtual tables for comprehensive search (NIP-50)',
    up: async (db: D1Database) => {
      // Users FTS5 (kind 0)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS users_fts USING fts5(
          event_id UNINDEXED,
          pubkey UNINDEXED,
          name,
          display_name,
          about,
          nip05,
          tokenize='porter unicode61 remove_diacritics 1'
        )
      `).run();

      console.log('Created users_fts table');

      // Videos FTS5 (kind 34236)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
          event_id UNINDEXED,
          title,
          description,
          summary,
          content,
          tokenize='porter unicode61'
        )
      `).run();

      console.log('Created videos_fts table');

      // Hashtags FTS5 (all kinds with #t tags)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS hashtags_fts USING fts5(
          hashtag,
          event_id UNINDEXED,
          tokenize='trigram'
        )
      `).run();

      console.log('Created hashtags_fts table');

      // Hashtag statistics table
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS hashtag_stats (
          hashtag TEXT PRIMARY KEY,
          total_usage INTEGER DEFAULT 1,
          unique_events INTEGER DEFAULT 1,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          trending_score REAL DEFAULT 0
        )
      `).run();

      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_hashtag_trending
          ON hashtag_stats(trending_score DESC, last_seen DESC)
      `).run();

      console.log('Created hashtag_stats table and index');

      // Lists FTS5 (kinds 30000-30003, 10000-10003)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts USING fts5(
          event_id UNINDEXED,
          d_tag UNINDEXED,
          kind UNINDEXED,
          name,
          description,
          content,
          tokenize='porter unicode61'
        )
      `).run();

      console.log('Created lists_fts table');

      // Notes FTS5 (kind 1)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          event_id UNINDEXED,
          content,
          tokenize='porter unicode61'
        )
      `).run();

      console.log('Created notes_fts table');

      // Articles FTS5 (kind 30023)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
          event_id UNINDEXED,
          d_tag UNINDEXED,
          title,
          summary,
          content,
          tokenize='porter unicode61'
        )
      `).run();

      console.log('Created articles_fts table');

      // Communities FTS5 (kind 34550)
      await db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS communities_fts USING fts5(
          event_id UNINDEXED,
          d_tag UNINDEXED,
          name,
          description,
          tokenize='porter unicode61'
        )
      `).run();

      console.log('Created communities_fts table');
      console.log('Migration 7: FTS5 virtual tables created successfully');
    }
  }

  // Add future migrations here with incrementing version numbers
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
