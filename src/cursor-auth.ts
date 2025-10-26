// ABOUTME: Cursor authentication with HMAC and query hash binding
// ABOUTME: Prevents cursor tampering and cross-query reuse attacks

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
 * Compute HMAC-SHA256 using Web Crypto API (async)
 * @param secret - HMAC secret key
 * @param data - Data to sign
 * @returns Hex-encoded HMAC
 */
async function computeHmac(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Base64url encode (without padding)
 */
function base64urlEncode(str: string): string {
  const b64 = btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Base64url decode
 */
function base64urlDecode(str: string): string {
  // Add padding back
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  return atob(str);
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
export async function makeQueryHash(filter: any, sort: any, secret: string): Promise<string> {
  const payload = canonicalize({ filter, sort });
  const hmac = await computeHmac(secret, payload);
  return base64urlEncode(hmac);
}

/**
 * Encode a cursor with HMAC authentication
 *
 * @param cursor - Cursor payload
 * @param secret - HMAC secret
 * @returns Base64url-encoded signed cursor
 */
export async function encodeCursor(cursor: VideoCursor, secret: string): Promise<string> {
  const payload = cursor;

  // Sign the payload
  const hmac = await computeHmac(secret, JSON.stringify(payload));

  const signed: SignedCursor = { payload, hmac };

  // Encode to base64url
  return base64urlEncode(JSON.stringify(signed));
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
export async function decodeCursor(
  encoded: string,
  currentFilter: any,
  currentSort: any,
  secret: string,
  previousSecret?: string
): Promise<VideoCursor> {
  try {
    return await decodeCursorWithSecret(encoded, currentFilter, currentSort, secret);
  } catch (err) {
    // Try previous secret if rotation in progress
    if (previousSecret) {
      try {
        return await decodeCursorWithSecret(encoded, currentFilter, currentSort, previousSecret);
      } catch {}
    }
    throw err;  // Neither secret worked
  }
}

/**
 * Decode cursor with a specific secret
 * Internal helper for decodeCursor
 */
async function decodeCursorWithSecret(
  encoded: string,
  currentFilter: any,
  currentSort: any,
  secret: string
): Promise<VideoCursor> {
  // Decode from base64url
  const signed: SignedCursor = JSON.parse(base64urlDecode(encoded));

  // Verify HMAC
  const expectedHmac = await computeHmac(secret, JSON.stringify(signed.payload));

  if (signed.hmac !== expectedHmac) {
    throw new Error('invalid: cursor tampering detected');
  }

  // Verify query hash (prevents cursor reuse across different queries)
  const expectedQueryHash = await makeQueryHash(currentFilter, currentSort, secret);
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
export async function createCursorFromRow(
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
): Promise<string> {
  const queryHash = await makeQueryHash(filter, sort, secret);

  const cursor: VideoCursor = {
    sortField,
    sortDir,
    sortFieldValue: lastRow[sortField],
    createdAt: lastRow.created_at,
    eventId: lastRow.event_id,
    queryHash
  };

  return await encodeCursor(cursor, secret);
}
