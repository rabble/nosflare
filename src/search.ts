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
