# Production Readiness Checklist - Final Mile

## Critical Additions (Before Code Cut)

### 1. ✅ Query Hash in Cursor
**Problem**: Users can reuse cursors across different queries → unpredictable results
**Solution**: Bind cursor to exact query with hash

```typescript
interface VideoCursor {
  sortField: string;
  sortDir: 'asc' | 'desc';
  sortFieldValue: number | string;
  createdAt: number;
  eventId: string;
  queryHash: string;  // NEW: HMAC of normalized filter+sort
}

function canonicalize(x: any): string {
  return JSON.stringify(x, Object.keys(x).sort());
}

function makeQueryHash(filter: any, sort: any, secret: string): string {
  const payload = canonicalize({ filter, sort });
  return createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
}

// On decode: verify queryHash matches current filter
function decodeCursor(encoded: string, currentFilter: any, currentSort: any, secret: string): VideoCursor {
  const signed = JSON.parse(Buffer.from(encoded, 'base64url').toString());

  // Verify HMAC
  const expectedHmac = createHmac('sha256', secret)
    .update(JSON.stringify(signed.payload))
    .digest('hex');

  if (signed.hmac !== expectedHmac) {
    throw new Error('invalid: cursor tampering detected');
  }

  // NEW: Verify query hash
  const expectedQueryHash = makeQueryHash(currentFilter, currentSort, secret);
  if (signed.payload.queryHash !== expectedQueryHash) {
    throw new Error('invalid: cursor query mismatch');
  }

  return signed.payload;
}
```

### 2. ✅ NOTICE Payload Format
**Current**: String-based NOTICE
**Better**: Machine-parsable structure

```typescript
// Recommended format:
["NOTICE", "VCURSOR", {"sub": "sub-123", "cursor": "<base64url+hmac>"}]

// Alternative (string-based but prefixed):
["NOTICE", "VCURSOR sub-123 <base64url+hmac>"]

// Implementation:
function sendCursorNotice(ws: WebSocket, subId: string, cursor: string) {
  ws.send(JSON.stringify([
    "NOTICE",
    "VCURSOR",
    { sub: subId, cursor }
  ]));
}
```

### 3. ✅ Result Ordering Guarantee
**Problem**: Parallel fetches can interleave results
**Solution**: Maintain SQL ORDER BY when sending EVENTs

```typescript
async function sendQueryResults(ws: WebSocket, subId: string, videoResults: VideoRow[], env: Env) {
  // Fetch full events in same order as video query results
  const eventIds = videoResults.map(v => v.event_id);

  // Single batch fetch preserving order
  const eventMap = new Map();
  const events = await env.RELAY_DATABASE.prepare(`
    SELECT * FROM events WHERE id IN (${eventIds.map(() => '?').join(',')})
  `).bind(...eventIds).all();

  for (const event of events.results || []) {
    eventMap.set(event.id, event);
  }

  // Send in original sort order
  for (const eventId of eventIds) {
    const event = eventMap.get(eventId);
    if (event) {
      ws.send(JSON.stringify(["EVENT", subId, event]));
    }
  }
}
```

### 4. ✅ Strict Integer Semantics
**Problem**: avg_completion as float → sort surprises
**Solution**: Cast to INTEGER (0-100) at write time

```typescript
// In backfill-videos.ts and analytics upsert:
const avgCompletion = Math.round(Math.min(100, Math.max(0, rawAvgCompletion)));

await env.RELAY_DATABASE.prepare(`
  INSERT INTO videos (event_id, author, created_at, loop_count, likes, comments, reposts, views, avg_completion, hashtag)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id) DO UPDATE SET
    loop_count = excluded.loop_count,
    likes = excluded.likes,
    views = excluded.views,
    comments = excluded.comments,
    reposts = excluded.reposts,
    avg_completion = excluded.avg_completion  -- Always INTEGER 0-100
`).bind(eventId, author, createdAt, loopCount, likes, comments, reposts, views, avgCompletion, hashtag).run();
```

### 5. ✅ Safe Column Maps (Single Source of Truth)
**Problem**: Whitelists scattered across validation/SQL/publisher
**Solution**: Single shared map

```typescript
// src/video-columns.ts (NEW FILE)
export const SORTABLE_COLUMNS: Record<string, string> = {
  loop_count: 'loop_count',
  likes: 'likes',
  views: 'views',
  comments: 'comments',
  avg_completion: 'avg_completion',
  created_at: 'created_at'
  // NOTE: reposts removed until populated
};

export const INT_FILTERABLE_COLUMNS: Record<string, string> = {
  loop_count: 'loop_count',
  likes: 'likes',
  views: 'views',
  comments: 'comments',
  avg_completion: 'avg_completion'
  // NOTE: reposts removed until populated
};

export function validateSortField(field?: string): string {
  return SORTABLE_COLUMNS[field ?? 'created_at'] ?? 'created_at';
}

export function validateIntColumn(column: string): boolean {
  return column in INT_FILTERABLE_COLUMNS;
}
```

### 6. ✅ Remove Unpopulated Fields
**Problem**: `reposts` in allowed lists but not populated → confusing behavior
**Fix**: Remove from whitelist until metrics exist

```typescript
// In SORTABLE_COLUMNS and INT_FILTERABLE_COLUMNS:
// reposts: 'reposts'  // COMMENTED OUT until analytics populates this
```

### 7. ✅ Aggressive Limits
**Problem**: Large queries can DoS relay
**Solution**: Stricter caps

```typescript
const MAX_LIMIT = 200;           // Hard cap for video queries (500 for lists only)
const MAX_INT_FILTERS = 3;       // Max int# predicates per query
const MAX_HASHTAG_FILTERS = 5;   // Max #t values per query
const MAX_TIME_WINDOW_DAYS = 365; // Reject since < (now - 365d) when sorting non-chronologically

// Validation:
if (filter['#t'] && filter['#t'].length > MAX_HASHTAG_FILTERS) {
  this.sendClosed(session.webSocket, subscriptionId,
    `invalid: too many hashtag filters (max ${MAX_HASHTAG_FILTERS})`);
  return;
}

// Time window restriction for non-chronological sorts:
if (filter.sort && filter.sort.field !== 'created_at' && filter.since) {
  const maxSince = Math.floor(Date.now() / 1000) - (MAX_TIME_WINDOW_DAYS * 86400);
  if (filter.since < maxSince) {
    this.sendClosed(session.webSocket, subscriptionId,
      `invalid: time window too large when sorting by ${filter.sort.field} (max ${MAX_TIME_WINDOW_DAYS} days)`);
    return;
  }
}
```

### 8. ✅ Cursor Secret Rotation
**Problem**: Can't rotate secrets without invalidating all cursors
**Solution**: Support dual secrets for one deploy cycle

```typescript
interface Env {
  CURSOR_SECRET: string;
  CURSOR_SECRET_PREVIOUS?: string;  // Optional: previous secret during rotation
}

function verifyCursor(encoded: string, secret: string, previousSecret?: string): VideoCursor {
  try {
    return decodeCursor(encoded, secret);
  } catch (err) {
    // Try previous secret if rotation in progress
    if (previousSecret) {
      try {
        return decodeCursor(encoded, previousSecret);
      } catch {}
    }
    throw err;  // Neither worked
  }
}

// Always encode new cursors with current secret
function encodeCursor(cursor: VideoCursor, secret: string): string {
  // ...
}
```

### 9. ✅ Ranked List Sharding
**Problem**: Lists > 500 events hit relay size limits
**Solution**: Shard large lists

```typescript
async function publishRankedList(
  env: Env,
  dTag: string,
  metric: string,
  window: string,
  hashtag: string | null,
  cutoffTime: number
): Promise<void> {
  const MAX_EVENTS_PER_LIST = 500;

  // Query top videos
  const allResults = await queryTopVideos(env, metric, hashtag, cutoffTime, 5000);

  if (allResults.length === 0) return;

  // De-dupe event IDs
  const uniqueIds = Array.from(new Set(allResults.map(r => r.event_id)));

  // Shard if needed
  const totalParts = Math.ceil(uniqueIds.length / MAX_EVENTS_PER_LIST);

  for (let part = 0; part < totalParts; part++) {
    const start = part * MAX_EVENTS_PER_LIST;
    const end = Math.min(start + MAX_EVENTS_PER_LIST, uniqueIds.length);
    const partIds = uniqueIds.slice(start, end);

    const partDTag = totalParts > 1
      ? `${dTag}:part:${part + 1}/${totalParts}`
      : dTag;

    const tags: string[][] = [
      ['d', partDTag],
      ['metric', metric],
      ['window', window],
      ['ttl', getTTL(window)],
      ['v', '1']
    ];

    if (totalParts > 1) {
      tags.push(['parts', String(totalParts)]);
      tags.push(['part', String(part + 1)]);
    }

    if (hashtag) {
      tags.push(['t', hashtag]);
    }

    for (const eventId of partIds) {
      tags.push(['e', eventId]);
    }

    await publishEvent(env, 30000, tags);
  }
}
```

### 10. ✅ NIP-11 Content-Type & Structure
**Problem**: Missing content-type, vendor block at root
**Solution**: Proper headers and nested vendor key

```typescript
// In relay-worker.ts handleRelayInfoRequest():
async function handleRelayInfoRequest(): Promise<Response> {
  const info = {
    name: "relay.divine.video",
    description: relayInfo.description,
    pubkey: relayInfo.pubkey,
    contact: relayInfo.contact,
    supported_nips: relayInfo.supported_nips,
    software: relayInfo.software,
    version: relayInfo.version,

    // Vendor-scoped extensions
    divine_extensions: {
      int_filters: true,
      sort_fields: ["loop_count", "likes", "views", "comments", "avg_completion", "created_at"],
      cursor_format: "base64url+hmac",
      videos_kind: 34236,
      metrics_freshness_sec: 900,
      limit_max: 200
    }
  };

  return new Response(JSON.stringify(info, null, 2), {
    headers: {
      'Content-Type': 'application/nostr+json',  // CRITICAL: proper content-type
      'Access-Control-Allow-Origin': '*'
    }
  });
}
```

### 11. ✅ EXPLAIN Tests in CI
**Problem**: Index regressions go unnoticed
**Solution**: Snapshot EXPLAIN QUERY PLAN in tests

```yaml
# .github/workflows/test.yml
- name: Test Index Usage
  run: |
    # Test hashtag + sort query
    sqlite3 test.db "EXPLAIN QUERY PLAN
      SELECT event_id FROM videos
      WHERE hashtag = 'music'
      ORDER BY loop_count DESC, created_at DESC, event_id ASC
      LIMIT 50" > explain_hashtag_loops.txt

    grep -q "USING INDEX idx_videos_hashtag_loops_created_id" explain_hashtag_loops.txt || exit 1

    # Test time window + sort query
    sqlite3 test.db "EXPLAIN QUERY PLAN
      SELECT event_id FROM videos
      WHERE created_at >= 1735000000
      ORDER BY likes DESC, created_at DESC, event_id ASC
      LIMIT 50" > explain_time_likes.txt

    grep -q "USING INDEX" explain_time_likes.txt || exit 1

    # Fail if any query does SCAN TABLE
    ! grep -q "SCAN TABLE" explain_*.txt
```

### 12. ✅ Global Rate Limiting
**Problem**: Per-connection limits can be bypassed with multiple sockets
**Solution**: Add DO-level IP-based rate limiting

```typescript
// In RelayWebSocket Durable Object:
class RelayWebSocket {
  private ipRateLimiters: Map<string, TokenBucket> = new Map();

  async handleReq(session: WebSocketSession, message: any[]) {
    const clientIp = session.clientIp;  // From CF-Connecting-IP header

    // Check if this query uses vendor extensions
    const hasVendorExtensions = filters.some(f =>
      Object.keys(f).some(k => k.startsWith('int#')) || f.sort
    );

    if (hasVendorExtensions) {
      // Per-connection rate limit
      if (!session.vendorQueryLimiter.removeToken()) {
        this.sendClosed(session.webSocket, subscriptionId, 'rate-limited: too fast');
        return;
      }

      // Global IP-based rate limit
      let ipLimiter = this.ipRateLimiters.get(clientIp);
      if (!ipLimiter) {
        ipLimiter = new TokenBucket({ rate: 50 / 60000, capacity: 50 });  // 50/min global
        this.ipRateLimiters.set(clientIp, ipLimiter);
      }

      if (!ipLimiter.removeToken()) {
        this.sendClosed(session.webSocket, subscriptionId, 'rate-limited: IP quota exceeded');
        return;
      }
    }

    // ... rest of handling
  }
}
```

### 13. ✅ Observability Metrics
**Problem**: No visibility into query performance
**Solution**: Emit metrics for monitoring

```typescript
interface QueryMetrics {
  queryType: 'vendor' | 'standard';
  sortField: string;
  hasHashtag: boolean;
  hasIntFilters: boolean;
  latencyMs: number;
  rowsScanned: number;
  indexUsed: string | null;
  cursorRejected: boolean;
  cursorRejectReason?: string;
}

class MetricsCollector {
  private metrics: QueryMetrics[] = [];

  recordQuery(m: QueryMetrics) {
    this.metrics.push(m);

    // Log to console (Cloudflare collects these)
    console.log(JSON.stringify({
      type: 'query_metrics',
      ...m
    }));
  }

  getP95Latency(): number {
    const sorted = this.metrics.map(m => m.latencyMs).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] || 0;
  }
}

// In query execution:
const startTime = Date.now();
const result = await executeVideoQuery(filter, env);
const latencyMs = Date.now() - startTime;

metricsCollector.recordQuery({
  queryType: 'vendor',
  sortField: filter.sort?.field || 'created_at',
  hasHashtag: !!filter['#t'],
  hasIntFilters: Object.keys(filter).some(k => k.startsWith('int#')),
  latencyMs,
  rowsScanned: result.rowsScanned,  // From EXPLAIN or query stats
  indexUsed: result.indexUsed,       // Parse from EXPLAIN
  cursorRejected: false
});
```

### 14. ✅ Schema Migrations Versioning
**Problem**: Can't track which migrations ran
**Solution**: Migration version table

```typescript
// Add to schema initialization:
await session.prepare(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT NOT NULL
  )
`).run();

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema',
    up: async (db: D1Database) => {
      // Create events, tags, etc.
    }
  },
  {
    version: 2,
    description: 'Add videos table with composite indexes',
    up: async (db: D1Database) => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS videos (...)`).run();
      await db.prepare(`CREATE INDEX idx_videos_loops_created_id ...`).run();
      // ... all other indexes
    }
  }
];

async function runMigrations(db: D1Database) {
  for (const migration of MIGRATIONS) {
    const existing = await db.prepare(
      'SELECT version FROM schema_migrations WHERE version = ?'
    ).bind(migration.version).first();

    if (!existing) {
      console.log(`Running migration ${migration.version}: ${migration.description}`);
      await migration.up(db);
      await db.prepare(
        'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
      ).bind(migration.version, Math.floor(Date.now() / 1000), migration.description).run();
      console.log(`Migration ${migration.version} complete`);
    }
  }
}
```

### 15. ✅ Keyset Clause Generator
**Drop-in helper for DESC,DESC,ASC order**

```typescript
function buildKeysetClauseDesc(sqlCol: string, args: any[], cursor: VideoCursor): string {
  // For ORDER BY sqlCol DESC, created_at DESC, event_id ASC:
  // WHERE (field < ?) OR (field = ? AND created_at < ?) OR (field = ? AND created_at = ? AND event_id > ?)

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

function buildKeysetClauseAsc(sqlCol: string, args: any[], cursor: VideoCursor): string {
  // For ORDER BY sqlCol ASC, created_at ASC, event_id ASC:
  // WHERE (field > ?) OR (field = ? AND created_at > ?) OR (field = ? AND created_at = ? AND event_id > ?)

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
```

---

## Implementation Checklist

### Code Files to Create
- [ ] `src/video-columns.ts` - Safe column maps (single source of truth)
- [ ] `src/cursor-auth.ts` - HMAC + query hash functions
- [ ] `src/query-metrics.ts` - Metrics collection
- [ ] `src/migrations.ts` - Schema versioning
- [ ] `src/video-queries.ts` - Query builder with all guards
- [ ] `src/list-publisher.ts` - Ranked lists with sharding

### Code Files to Modify
- [ ] `src/relay-worker.ts` - NIP-11 content-type, migrations, observability
- [ ] `src/durable-object.ts` - Global rate limits, NOTICE format, validation
- [ ] `src/config.ts` - divine_extensions block
- [ ] `backfill-videos.ts` - Integer casting for avg_completion

### Tests to Add
- [ ] `.github/workflows/test.yml` - EXPLAIN QUERY PLAN snapshots
- [ ] Cursor tampering (bad HMAC, wrong query hash)
- [ ] Rate limit bypass attempts (multi-socket)
- [ ] Result ordering stability
- [ ] Integer overflow/underflow for metrics

### Deployment Steps
- [ ] Generate CURSOR_SECRET (256-bit random)
- [ ] Generate PUBLISHER_SECRET_KEY (nostr keypair)
- [ ] Run migrations in staging first
- [ ] Monitor p95 latency for 24h
- [ ] Verify EXPLAIN output in prod logs
- [ ] Check cursor rejection rate

---

## Success Criteria (Updated)

- [ ] p95 latency < 60ms for vendor queries
- [ ] p95 cursor advance < 40ms
- [ ] 0% extended EOSE usage
- [ ] < 0.1% cursor rejections (HMAC/query hash)
- [ ] 100% index usage on hot queries (EXPLAIN tests)
- [ ] Global rate limits prevent multi-socket bypass
- [ ] Ranked lists < 64KB each (sharding works)
- [ ] Metrics emitted for all vendor queries

---

## Files Summary

**New**:
- `PROD_READINESS_CHECKLIST.md` (this file)
- `src/video-columns.ts`
- `src/cursor-auth.ts`
- `src/query-metrics.ts`
- `src/migrations.ts`

**Modified**:
- `VIDEO_FILTERS_IMPLEMENTATION_PLAN.md`
- `IMPLEMENTATION_REFINEMENTS.md`

**Ready for**: Phase 1 code implementation with all prod safeguards.
