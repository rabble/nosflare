// ABOUTME: Cursor authentication with HMAC and query hash binding
// ABOUTME: Prevents cursor tampering and cross-query reuse attacks

import { createHmac } from 'crypto';

/**
 * Video cursor payload
 * Contains pagination state and query binding
 */
export interface VideoCursor {
  sortField: string;              // Which column we're sorting by
  sortDir: 'asc' | 'desc';        // Sort direction
  sortFieldValue: number | string; // Value of sort field at this position
  createdAt: number;              // Tie-breaker 1
  eventId: string;                // Tie-breaker 2 (unique)
  queryHash: string;              // HMAC of normalized filter+sort (prevents cross-query reuse)
}

/**
 * Signed cursor with HMAC for tamper detection
 */
interface SignedCursor {
  payload: VideoCursor;
  hmac: string;  // HMAC-SHA256 of payload
}

/**
 * Canonicalize an object to stable JSON for hashing
 * Sorts keys alphabetically to ensure consistent serialization
 *
 * @param obj - Object to canonicalize
 * @returns Stable JSON string
 */
function canonicalize(obj: any): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }

  if (typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => `"${k}":${canonicalize(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Generate a stable hash of a filter+sort combination
 * Used to bind cursors to specific queries
 *
 * @param filter - Nostr filter object
 * @param sort - Sort specification
 * @param secret - HMAC secret
 * @returns Base64url-encoded hash
 */
export function makeQueryHash(filter: any, sort: any, secret: string): string {
  const payload = canonicalize({ filter, sort });
  return createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
}

/**
 * Encode a cursor with HMAC authentication
 *
 * @param cursor - Cursor payload
 * @param secret - HMAC secret
 * @returns Base64url-encoded signed cursor
 */
export function encodeCursor(cursor: VideoCursor, secret: string): string {
  const payload = cursor;

  // Sign the payload
  const hmac = createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  const signed: SignedCursor = { payload, hmac };

  // Encode to base64url
  return Buffer.from(JSON.stringify(signed)).toString('base64url');
}

/**
 * Decode and verify a cursor
 * Throws on HMAC verification failure or query hash mismatch
 *
 * @param encoded - Base64url-encoded signed cursor
 * @param currentFilter - Current filter (to verify query hash)
 * @param currentSort - Current sort spec (to verify query hash)
 * @param secret - HMAC secret for verification
 * @param previousSecret - Optional previous secret (for rotation)
 * @returns Verified cursor payload
 * @throws Error if HMAC invalid or query hash mismatch
 */
export function decodeCursor(
  encoded: string,
  currentFilter: any,
  currentSort: any,
  secret: string,
  previousSecret?: string
): VideoCursor {
  try {
    return decodeCursorWithSecret(encoded, currentFilter, currentSort, secret);
  } catch (err) {
    // Try previous secret if rotation in progress
    if (previousSecret) {
      try {
        return decodeCursorWithSecret(encoded, currentFilter, currentSort, previousSecret);
      } catch {}
    }
    throw err;  // Neither secret worked
  }
}

/**
 * Decode cursor with a specific secret
 * Internal helper for decodeCursor
 */
function decodeCursorWithSecret(
  encoded: string,
  currentFilter: any,
  currentSort: any,
  secret: string
): VideoCursor {
  // Decode from base64url
  const signed: SignedCursor = JSON.parse(
    Buffer.from(encoded, 'base64url').toString()
  );

  // Verify HMAC
  const expectedHmac = createHmac('sha256', secret)
    .update(JSON.stringify(signed.payload))
    .digest('hex');

  if (signed.hmac !== expectedHmac) {
    throw new Error('invalid: cursor tampering detected');
  }

  // Verify query hash (prevents cursor reuse across different queries)
  const expectedQueryHash = makeQueryHash(currentFilter, currentSort, secret);
  if (signed.payload.queryHash !== expectedQueryHash) {
    throw new Error('invalid: cursor query mismatch');
  }

  return signed.payload;
}

/**
 * Create a cursor from query results
 * Used to generate pagination cursor from last result row
 *
 * @param lastRow - Last row from query results
 * @param sortField - Column being sorted by
 * @param sortDir - Sort direction
 * @param filter - Current filter
 * @param sort - Current sort spec
 * @param secret - HMAC secret
 * @returns Encoded cursor string
 */
export function createCursorFromRow(
  lastRow: {
    event_id: string;
    created_at: number;
    [key: string]: any;
  },
  sortField: string,
  sortDir: 'asc' | 'desc',
  filter: any,
  sort: any,
  secret: string
): string {
  const queryHash = makeQueryHash(filter, sort, secret);

  const cursor: VideoCursor = {
    sortField,
    sortDir,
    sortFieldValue: lastRow[sortField],
    createdAt: lastRow.created_at,
    eventId: lastRow.event_id,
    queryHash
  };

  return encodeCursor(cursor, secret);
}
