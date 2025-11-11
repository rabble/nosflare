// ABOUTME: Search functionality for Nostr events using FTS5 full-text search
// ABOUTME: Implements NIP-50 search with entity-specific indexing and retrieval

import { NostrEvent, SearchResult, ParsedSearchQuery } from './types';
import { buildFTSQuery } from './search-parser';

/**
 * Search for user profiles (kind 0 events) in the FTS5 index
 * Searches across name, display_name, about, and nip05 fields
 * Returns results ordered by relevance score
 */
export async function searchUsers(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  const ftsQuery = buildFTSQuery(query.terms);

  if (!ftsQuery) {
    return [];
  }

  try {
    const session = db.withSession('first-unconstrained');
    const results = await session.prepare(`
      SELECT
        e.*,
        u.rank as relevance_score,
        snippet(users_fts, 2, '<mark>', '</mark>', '...', 32) as snippet
      FROM users_fts u
      JOIN events e ON e.id = u.event_id
      WHERE users_fts MATCH ?
      ORDER BY u.rank DESC, e.created_at DESC
      LIMIT ?
    `).bind(ftsQuery, limit).all();

    return results.results.map(r => ({
      type: 'user' as const,
      event: {
        id: r.id,
        pubkey: r.pubkey,
        created_at: r.created_at,
        kind: r.kind,
        tags: JSON.parse(r.tags),
        content: r.content,
        sig: r.sig
      },
      relevance_score: Math.abs(r.relevance_score || 0),
      snippet: r.snippet,
      match_fields: ['name', 'about']
    }));
  } catch (error) {
    console.error('User search error:', error);
    return [];
  }
}

/**
 * Index a user profile event (kind 0) into the FTS5 users_fts table
 * Extracts profile fields from the event content JSON
 * Note: FTS5 doesn't support UPSERT, so we delete then insert
 */
export async function indexUserProfile(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const profile = JSON.parse(event.content);
    const session = db.withSession('first-primary');

    // Delete existing entry for this event (if any)
    await session.prepare(`
      DELETE FROM users_fts WHERE event_id = ?
    `).bind(event.id).run();

    // Insert new entry
    await session.prepare(`
      INSERT INTO users_fts(event_id, pubkey, name, display_name, about, nip05)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      event.id,
      event.pubkey,
      profile.name || '',
      profile.display_name || profile.displayName || '',
      profile.about || '',
      profile.nip05 || ''
    ).run();
  } catch (error) {
    console.error('Error indexing user profile:', error);
  }
}

/**
 * Search for hashtags using FTS5 trigram tokenizer for prefix matching
 * Returns hashtag autocomplete results with trending scores
 */
export async function searchHashtags(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  const searchTerm = query.raw.replace(/^hashtag:#/, '').replace(/^#/, '').toLowerCase();

  if (!searchTerm) {
    return [];
  }

  try {
    const session = db.withSession('first-unconstrained');

    // Autocomplete query - prefix matching with trigram
    const results = await session.prepare(`
      SELECT
        h.hashtag,
        h.event_id,
        s.total_usage,
        s.trending_score
      FROM hashtags_fts h
      LEFT JOIN hashtag_stats s ON s.hashtag = h.hashtag
      WHERE hashtags_fts MATCH ?
      GROUP BY h.hashtag
      ORDER BY
        CASE
          WHEN h.hashtag = ? THEN 0
          WHEN h.hashtag LIKE ? THEN 1
          ELSE 2
        END,
        s.trending_score DESC,
        s.total_usage DESC
      LIMIT ?
    `).bind(
      `${searchTerm}*`,
      searchTerm,
      `${searchTerm}%`,
      limit
    ).all();

    // Return hashtag results as synthetic events
    return results.results.map(r => ({
      type: 'hashtag' as const,
      event: {
        id: r.event_id || 'hashtag-' + r.hashtag,
        pubkey: '',
        created_at: 0,
        kind: 0,
        tags: [['t', r.hashtag]],
        content: JSON.stringify({
          hashtag: r.hashtag,
          usage: r.total_usage || 0,
          trending: r.trending_score || 0
        }),
        sig: ''
      },
      relevance_score: r.trending_score || 0,
      snippet: `#${r.hashtag}`,
      match_fields: ['hashtag']
    }));
  } catch (error) {
    console.error('Hashtag search error:', error);
    return [];
  }
}

/**
 * Index hashtags from an event into the FTS5 hashtags_fts table
 * Also updates hashtag usage statistics for trending calculations
 */
export async function indexHashtags(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  const hashtags = event.tags
    .filter(t => t[0] === 't' && t[1])
    .map(t => t[1].toLowerCase());

  if (hashtags.length === 0) return;

  try {
    const session = db.withSession('first-primary');
    const now = Math.floor(Date.now() / 1000);

    for (const hashtag of hashtags) {
      // Update stats
      await session.prepare(`
        INSERT INTO hashtag_stats(hashtag, total_usage, unique_events, first_seen, last_seen, trending_score)
        VALUES (?, 1, 1, ?, ?, 1.0)
        ON CONFLICT(hashtag) DO UPDATE SET
          total_usage = total_usage + 1,
          unique_events = unique_events + 1,
          last_seen = ?,
          trending_score = (total_usage * 1.0) / (? - first_seen + 86400)
      `).bind(hashtag, now, now, now, now).run();

      // Add to FTS5 index
      await session.prepare(`
        INSERT INTO hashtags_fts(hashtag, event_id)
        VALUES (?, ?)
      `).bind(hashtag, event.id).run();
    }
  } catch (error) {
    console.error('Error indexing hashtags:', error);
  }
}

/**
 * Search for videos (kind 34236 events) in the FTS5 index
 * Searches across title, description, summary, and content fields
 * Boosts relevance by engagement metrics (loop_count, likes)
 * Returns results ordered by relevance score with engagement boost
 */
export async function searchVideos(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  const ftsQuery = buildFTSQuery(query.terms);

  if (!ftsQuery) {
    return [];
  }

  try {
    const session = db.withSession('first-unconstrained');

    // Search video metadata with engagement boost
    const results = await session.prepare(`
      SELECT
        e.*,
        v.loop_count,
        v.likes,
        vf.rank as base_relevance,
        vf.rank * (1 + LOG(COALESCE(v.loop_count, 0) + 1) * 0.1) *
                  (1 + LOG(COALESCE(v.likes, 0) + 1) * 0.05) as relevance_score,
        snippet(videos_fts, 1, '<mark>', '</mark>', '...', 64) as snippet
      FROM videos_fts vf
      JOIN events e ON e.id = vf.event_id
      LEFT JOIN videos v ON v.event_id = vf.event_id
      WHERE videos_fts MATCH ?
      ORDER BY relevance_score DESC, e.created_at DESC
      LIMIT ?
    `).bind(ftsQuery, limit).all();

    return results.results.map(r => ({
      type: 'video' as const,
      event: {
        id: r.id,
        pubkey: r.pubkey,
        created_at: r.created_at,
        kind: r.kind,
        tags: JSON.parse(r.tags),
        content: r.content,
        sig: r.sig
      },
      relevance_score: Math.abs(r.relevance_score || 0),
      snippet: r.snippet,
      match_fields: ['title', 'description', 'content']
    }));
  } catch (error) {
    console.error('Video search error:', error);
    return [];
  }
}

/**
 * Index a video event (kind 34236) into the FTS5 videos_fts table
 * Extracts title and summary from event tags, content from event.content
 * Note: FTS5 doesn't support UPSERT, so we delete then insert
 */
export async function indexVideo(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const title = event.tags.find(t => t[0] === 'title')?.[1] || '';
    const summary = event.tags.find(t => t[0] === 'summary')?.[1] || '';
    const session = db.withSession('first-primary');

    // Delete existing entry for this event (if any)
    await session.prepare(`
      DELETE FROM videos_fts WHERE event_id = ?
    `).bind(event.id).run();

    // Insert new entry
    await session.prepare(`
      INSERT INTO videos_fts(event_id, title, description, summary, content)
      VALUES (?, ?, ?, ?, ?)
    `).bind(event.id, title, event.content, summary, event.content).run();
  } catch (error) {
    console.error('Error indexing video:', error);
  }
}

/**
 * Search for notes (kind 1 events) in the FTS5 index
 * Searches across note content
 * Returns results ordered by relevance score
 */
export async function searchNotes(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  const ftsQuery = buildFTSQuery(query.terms);

  if (!ftsQuery) {
    return [];
  }

  try {
    const session = db.withSession('first-unconstrained');

    const results = await session.prepare(`
      SELECT
        e.*,
        n.rank as relevance_score,
        snippet(notes_fts, 0, '<mark>', '</mark>', '...', 64) as snippet
      FROM notes_fts n
      JOIN events e ON e.id = n.event_id
      WHERE notes_fts MATCH ?
      ORDER BY n.rank DESC, e.created_at DESC
      LIMIT ?
    `).bind(ftsQuery, limit).all();

    return results.results.map(r => ({
      type: 'note' as const,
      event: {
        id: r.id,
        pubkey: r.pubkey,
        created_at: r.created_at,
        kind: r.kind,
        tags: JSON.parse(r.tags),
        content: r.content,
        sig: r.sig
      },
      relevance_score: Math.abs(r.relevance_score || 0),
      snippet: r.snippet,
      match_fields: ['content']
    }));
  } catch (error) {
    console.error('Note search error:', error);
    return [];
  }
}

/**
 * Index a note event (kind 1) into the FTS5 notes_fts table
 * Note: FTS5 doesn't support UPSERT, so we delete then insert
 */
export async function indexNote(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const session = db.withSession('first-primary');

    // Delete existing entry for this event (if any)
    await session.prepare(`
      DELETE FROM notes_fts WHERE event_id = ?
    `).bind(event.id).run();

    // Insert new entry
    await session.prepare(`
      INSERT INTO notes_fts(event_id, content)
      VALUES (?, ?)
    `).bind(event.id, event.content).run();
  } catch (error) {
    console.error('Error indexing note:', error);
  }
}

/**
 * Search for lists (kinds 30000-30003) in the FTS5 index
 * Searches across name, description, and content fields
 * Returns results ordered by relevance score
 */
export async function searchLists(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  const ftsQuery = buildFTSQuery(query.terms);

  if (!ftsQuery) {
    return [];
  }

  try {
    const session = db.withSession('first-unconstrained');

    const results = await session.prepare(`
      SELECT
        e.*,
        l.rank as relevance_score,
        snippet(lists_fts, 3, '<mark>', '</mark>', '...', 64) as snippet
      FROM lists_fts l
      JOIN events e ON e.id = l.event_id
      WHERE lists_fts MATCH ?
      ORDER BY l.rank DESC, e.created_at DESC
      LIMIT ?
    `).bind(ftsQuery, limit).all();

    return results.results.map(r => ({
      type: 'list' as const,
      event: {
        id: r.id,
        pubkey: r.pubkey,
        created_at: r.created_at,
        kind: r.kind,
        tags: JSON.parse(r.tags),
        content: r.content,
        sig: r.sig
      },
      relevance_score: Math.abs(r.relevance_score || 0),
      snippet: r.snippet,
      match_fields: ['name', 'description', 'content']
    }));
  } catch (error) {
    console.error('List search error:', error);
    return [];
  }
}

/**
 * Index a list event (kinds 30000-30003) into the FTS5 lists_fts table
 * Extracts d_tag, name, and description from event tags
 * Note: FTS5 doesn't support UPSERT, so we delete then insert
 */
export async function indexList(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
    const name = event.tags.find(t => t[0] === 'name')?.[1] || '';
    const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
    const session = db.withSession('first-primary');

    // Delete existing entry for this event (if any)
    await session.prepare(`
      DELETE FROM lists_fts WHERE event_id = ?
    `).bind(event.id).run();

    // Insert new entry
    await session.prepare(`
      INSERT INTO lists_fts(event_id, d_tag, kind, name, description, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(event.id, dTag, event.kind, name, description, event.content).run();
  } catch (error) {
    console.error('Error indexing list:', error);
  }
}

/**
 * Search for articles (kind 30023 events) in the FTS5 index
 * Searches across title, summary, and content fields
 * Returns results ordered by relevance score
 */
export async function searchArticles(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  const ftsQuery = buildFTSQuery(query.terms);

  if (!ftsQuery) {
    return [];
  }

  try {
    const session = db.withSession('first-unconstrained');

    const results = await session.prepare(`
      SELECT
        e.*,
        a.rank as relevance_score,
        snippet(articles_fts, 2, '<mark>', '</mark>', '...', 64) as snippet
      FROM articles_fts a
      JOIN events e ON e.id = a.event_id
      WHERE articles_fts MATCH ?
      ORDER BY a.rank DESC, e.created_at DESC
      LIMIT ?
    `).bind(ftsQuery, limit).all();

    return results.results.map(r => ({
      type: 'article' as const,
      event: {
        id: r.id,
        pubkey: r.pubkey,
        created_at: r.created_at,
        kind: r.kind,
        tags: JSON.parse(r.tags),
        content: r.content,
        sig: r.sig
      },
      relevance_score: Math.abs(r.relevance_score || 0),
      snippet: r.snippet,
      match_fields: ['title', 'summary', 'content']
    }));
  } catch (error) {
    console.error('Article search error:', error);
    return [];
  }
}

/**
 * Index an article event (kind 30023) into the FTS5 articles_fts table
 * Extracts d_tag, title, and summary from event tags
 * Note: FTS5 doesn't support UPSERT, so we delete then insert
 */
export async function indexArticle(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
    const title = event.tags.find(t => t[0] === 'title')?.[1] || '';
    const summary = event.tags.find(t => t[0] === 'summary')?.[1] || '';
    const session = db.withSession('first-primary');

    // Delete existing entry for this event (if any)
    await session.prepare(`
      DELETE FROM articles_fts WHERE event_id = ?
    `).bind(event.id).run();

    // Insert new entry
    await session.prepare(`
      INSERT INTO articles_fts(event_id, d_tag, title, summary, content)
      VALUES (?, ?, ?, ?, ?)
    `).bind(event.id, dTag, title, summary, event.content).run();
  } catch (error) {
    console.error('Error indexing article:', error);
  }
}
