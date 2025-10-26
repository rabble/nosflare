// ABOUTME: Video query builder with int# filters, sorting, and keyset pagination
// ABOUTME: Handles vendor extensions for filtering/sorting kind 34236 video events by engagement metrics

import { validateSortField } from './video-columns';
import { decodeCursor, createCursorFromRow, type VideoCursor } from './cursor-auth';
import { NostrEvent } from './types';

/**
 * Int# comparison operators
 */
export interface IntComparison {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
  eq?: number;
  neq?: number;
}

/**
 * Video filter extending Nostr filter with vendor extensions
 */
export interface VideoFilter {
  kinds?: number[];
  '#t'?: string[];              // Hashtag filter
  'int#loop_count'?: IntComparison;
  'int#likes'?: IntComparison;
  'int#views'?: IntComparison;
  'int#comments'?: IntComparison;
  'int#reposts'?: IntComparison;
  'int#avg_completion'?: IntComparison;
  since?: number;
  until?: number;
  sort?: {
    field: string;
    dir?: 'asc' | 'desc';
  };
  limit?: number;
  cursor?: string;
}

/**
 * Video query result
 */
interface VideoRow {
  event_id: string;
  author: string;
  created_at: number;
  loop_count: number;
  likes: number;
  views: number;
  comments: number;
  reposts: number;
  avg_completion: number;
  hashtag: string | null;
}

/**
 * Check if a filter uses vendor extensions (requires videos table)
 */
export function shouldUseVideosTable(filter: any): boolean {
  if (!filter.kinds?.includes(34236)) {
    return false;  // Not a video query
  }

  // Use videos table if any of these vendor extensions present:
  return (
    Object.keys(filter).some(k => k.startsWith('int#')) ||  // Has int# filters
    (filter.sort && filter.sort.field !== 'created_at') ||   // Non-default sort
    !!filter.cursor                                          // Using pagination
  );
}

/**
 * Build keyset pagination clause for DESC sort direction
 * ORDER BY: field DESC, created_at DESC, event_id ASC
 */
function buildKeysetClauseDesc(
  sqlCol: string,
  args: any[],
  cursor: VideoCursor
): string {
  args.push(
    cursor.sortFieldValue,
    cursor.sortFieldValue, cursor.createdAt,
    cursor.sortFieldValue, cursor.createdAt, cursor.eventId
  );

  return ` AND (
    (${sqlCol} < ?)
    OR (${sqlCol} = ? AND created_at < ?)
    OR (${sqlCol} = ? AND created_at = ? AND event_id > ?)
  )`;
}

/**
 * Build keyset pagination clause for ASC sort direction
 * ORDER BY: field ASC, created_at ASC, event_id ASC
 */
function buildKeysetClauseAsc(
  sqlCol: string,
  args: any[],
  cursor: VideoCursor
): string {
  args.push(
    cursor.sortFieldValue,
    cursor.sortFieldValue, cursor.createdAt,
    cursor.sortFieldValue, cursor.createdAt, cursor.eventId
  );

  return ` AND (
    (${sqlCol} > ?)
    OR (${sqlCol} = ? AND created_at > ?)
    OR (${sqlCol} = ? AND created_at = ? AND event_id > ?)
  )`;
}

/**
 * Build SQL query for videos table with all vendor extensions
 *
 * @param filter - Video filter with vendor extensions
 * @param cursorSecret - HMAC secret for cursor verification
 * @param previousCursorSecret - Optional previous secret for rotation
 * @returns SQL query string and bound parameters
 */
export function buildVideoQuery(
  filter: VideoFilter,
  cursorSecret: string,
  previousCursorSecret?: string
): { sql: string; args: any[] } {
  const where: string[] = [];
  const args: any[] = [];

  // Hashtag filtering (currently single hashtag in videos.hashtag)
  if (filter['#t']?.length) {
    const placeholders = filter['#t'].map(() => '?').join(',');
    where.push(`hashtag IN (${placeholders})`);
    args.push(...filter['#t']);
  }

  // Int# filters
  for (const [key, comparison] of Object.entries(filter)) {
    if (!key.startsWith('int#')) continue;

    const column = key.slice(4);  // e.g., 'loop_count'

    if (comparison.gte !== undefined) {
      where.push(`${column} >= ?`);
      args.push(comparison.gte);
    }
    if (comparison.gt !== undefined) {
      where.push(`${column} > ?`);
      args.push(comparison.gt);
    }
    if (comparison.lte !== undefined) {
      where.push(`${column} <= ?`);
      args.push(comparison.lte);
    }
    if (comparison.lt !== undefined) {
      where.push(`${column} < ?`);
      args.push(comparison.lt);
    }
    if (comparison.eq !== undefined) {
      where.push(`${column} = ?`);
      args.push(comparison.eq);
    }
    if (comparison.neq !== undefined) {
      where.push(`${column} != ?`);
      args.push(comparison.neq);
    }
  }

  // Time range filters
  if (filter.since !== undefined) {
    where.push('created_at >= ?');
    args.push(filter.since);
  }

  if (filter.until !== undefined) {
    where.push('created_at <= ?');
    args.push(filter.until);
  }

  // Sorting (validated by validateSortField)
  const sortField = validateSortField(filter.sort?.field);
  const sortDir = filter.sort?.dir === 'asc' ? 'ASC' : 'DESC';

  // Cursor pagination (keyset)
  let cursorClause = '';
  if (filter.cursor) {
    try {
      const cursor = decodeCursor(
        filter.cursor,
        filter,
        filter.sort || { field: 'created_at', dir: 'desc' },
        cursorSecret,
        previousCursorSecret
      );

      if (sortDir === 'DESC') {
        cursorClause = buildKeysetClauseDesc(sortField, args, cursor);
      } else {
        cursorClause = buildKeysetClauseAsc(sortField, args, cursor);
      }
    } catch (error) {
      // Cursor verification failed - will be handled by caller
      throw error;
    }
  }

  // Limit (LIMIT+1 to detect hasMore)
  const limit = Math.min(filter.limit || 50, 200);
  const fetchLimit = limit + 1;

  // Build final query
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT event_id, author, created_at, loop_count, likes, views, comments, reposts, avg_completion, hashtag
    FROM videos
    ${whereClause}
    ${cursorClause}
    ORDER BY ${sortField} ${sortDir}, created_at ${sortDir}, event_id ASC
    LIMIT ${fetchLimit}
  `;

  return { sql, args };
}

/**
 * Execute video query and return results with cursor
 *
 * @param filter - Video filter
 * @param db - D1 database
 * @param cursorSecret - HMAC secret
 * @param previousCursorSecret - Optional previous secret
 * @returns Video rows and next cursor (if more results available)
 */
export async function executeVideoQuery(
  filter: VideoFilter,
  db: D1Database,
  cursorSecret: string,
  previousCursorSecret?: string
): Promise<{
  rows: VideoRow[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const { sql, args } = buildVideoQuery(filter, cursorSecret, previousCursorSecret);

  const result = await db.prepare(sql).bind(...args).all();
  const rows = (result.results || []) as VideoRow[];

  // Check if there are more results (LIMIT+1 trick)
  const limit = Math.min(filter.limit || 50, 200);
  const hasMore = rows.length > limit;

  // Trim to actual limit
  if (hasMore) {
    rows.pop();
  }

  // Generate next cursor from last row
  let nextCursor: string | null = null;
  if (hasMore && rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    const sortField = validateSortField(filter.sort?.field);
    const sortDir = filter.sort?.dir === 'asc' ? 'asc' : 'desc';

    nextCursor = createCursorFromRow(
      lastRow,
      sortField,
      sortDir,
      filter,
      filter.sort || { field: 'created_at', dir: 'desc' },
      cursorSecret
    );
  }

  return { rows, nextCursor, hasMore };
}

/**
 * Fetch full Nostr events for video query results
 * Maintains sort order from video query
 *
 * @param videoRows - Sorted video rows from query
 * @param db - D1 database
 * @returns Nostr events in same order as videoRows
 */
export async function fetchEventsForVideoRows(
  videoRows: VideoRow[],
  db: D1Database
): Promise<NostrEvent[]> {
  if (videoRows.length === 0) return [];

  const eventIds = videoRows.map(v => v.event_id);

  // Fetch all events in one query
  const placeholders = eventIds.map(() => '?').join(',');
  const result = await db.prepare(`
    SELECT id, pubkey, created_at, kind, tags, content, sig
    FROM events
    WHERE id IN (${placeholders})
  `).bind(...eventIds).all();

  // Create map for O(1) lookup
  const eventMap = new Map<string, any>();
  for (const event of result.results || []) {
    eventMap.set(event.id as string, event);
  }

  // Return events in original sort order
  const orderedEvents: NostrEvent[] = [];
  for (const eventId of eventIds) {
    const event = eventMap.get(eventId);
    if (event) {
      // Parse tags from JSON
      const tags = typeof event.tags === 'string'
        ? JSON.parse(event.tags)
        : event.tags;

      orderedEvents.push({
        id: event.id as string,
        pubkey: event.pubkey as string,
        created_at: event.created_at as number,
        kind: event.kind as number,
        tags,
        content: event.content as string,
        sig: event.sig as string
      });
    }
  }

  return orderedEvents;
}
