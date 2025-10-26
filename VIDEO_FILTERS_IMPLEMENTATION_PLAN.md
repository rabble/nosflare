# Video Discovery: Custom Filters & Ranked Lists - Implementation Plan

## Overview
Add vendor-specific extensions to enable powerful video discovery while maintaining backward compatibility with standard Nostr clients.

**Dual approach:**
- **(A) Relay vendor extension**: Custom `int#` filters + sorting for power users
- **(B) Portable ranked lists**: kind 30000 events consumable by any client

---

## Part A: Relay Vendor Extension

### 1. Filter Format (Backward Compatible)

```json
{
  "kinds": [34236],
  "#t": ["music", "lofi"],              // Standard NIP-01 tag filter
  "int#loop_count": {"gte": 100},       // NEW: numeric comparisons
  "int#likes": {"gte": 50},             // NEW: numeric comparisons
  "int#avg_completion": {"gte": 60},    // NEW: numeric comparisons
  "since": 1730000000,
  "until": 1735600000,
  "sort": {                              // NEW: explicit sorting
    "field": "loop_count",
    "dir": "desc"
  },
  "limit": 50,
  "cursor": "base64-encoded-token"       // NEW: keyset pagination
}
```

**Supported int# comparisons**: `gte`, `gt`, `lte`, `lt`, `eq`, `neq`
**Supported sort.field**: `loop_count`, `likes`, `views`, `comments`, `reposts`, `avg_completion`, `created_at`
**Supported sort.dir**: `asc`, `desc` (default: `desc`)

### 2. Architecture Decision: When to Use Videos Table

**Key question**: Should we query `videos` table or `events` table?

**Decision tree**:
```javascript
function shouldUseVideosTable(filter) {
  // Use videos table if ANY of these conditions are true:
  return (
    filter.kinds?.includes(34236) &&  // is video query
    (
      hasIntFilters(filter) ||         // has int# filters
      filter.sort?.field !== 'created_at' || // non-default sort
      filter.cursor                    // using pagination
    )
  );
}
```

**Why this approach?**
- Standard queries (no int#, default sort) can use existing optimized `events` table queries
- Only "power queries" hit the `videos` table
- Maintains performance for basic clients

### 3. Implementation Location Strategy

**Option 1: Dual-path in queryEvents() [RECOMMENDED]**
```
relay-worker.ts:queryEvents()
├─ if (shouldUseVideosTable(filters))
│  └─ return queryVideosTable(filters, bookmark, env)
└─ else
   └─ return queryEventsTable(filters, bookmark, env) // existing code
```

**Option 2: Separate endpoint**
- Add new message type: `["VREQ", subscriptionId, ...filters]`
- Cleaner separation but requires client changes

**Recommendation**: Option 1 - transparent to clients, backward compatible

### 4. Query Builder for Videos Table

**File**: `src/video-queries.ts` (new file)

```typescript
interface VideoFilter {
  kinds?: number[];
  '#t'?: string[];              // hashtags
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
    dir: 'asc' | 'desc';
  };
  limit?: number;
  cursor?: string;
}

interface IntComparison {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
  eq?: number;
  neq?: number;
}

function buildVideoQuery(filter: VideoFilter): {sql: string, args: any[]} {
  const where: string[] = [];
  const args: any[] = [];

  // Hashtag filtering (currently single hashtag in videos.hashtag)
  if (filter['#t']?.length) {
    where.push(`hashtag IN (${filter['#t'].map(() => '?').join(',')})`);
    args.push(...filter['#t']);
  }

  // Int# filters
  for (const [key, comparison] of Object.entries(filter)) {
    if (!key.startsWith('int#')) continue;

    const column = key.slice(4); // e.g., 'loop_count'
    const allowed = ['loop_count', 'likes', 'views', 'comments', 'reposts', 'avg_completion'];
    if (!allowed.includes(column)) continue;

    if (comparison.gte !== undefined) {
      where.push(`${column} >= ?`);
      args.push(comparison.gte);
    }
    if (comparison.gt !== undefined) {
      where.push(`${column} > ?`);
      args.push(comparison.gt);
    }
    // ... lt, lte, eq, neq
  }

  // Time range
  if (filter.since) {
    where.push('created_at >= ?');
    args.push(filter.since);
  }
  if (filter.until) {
    where.push('created_at <= ?');
    args.push(filter.until);
  }

  // Sorting
  const sortField = validateSortField(filter.sort?.field ?? 'created_at');
  const sortDir = filter.sort?.dir === 'asc' ? 'ASC' : 'DESC';

  // Cursor (keyset pagination)
  const cursorClause = buildCursorClause(filter.cursor, sortField, sortDir, args);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 50, 500);

  const sql = `
    SELECT event_id, author, created_at, loop_count, likes, views, comments, reposts, avg_completion, hashtag
    FROM videos
    ${whereClause}
    ${cursorClause}
    ORDER BY ${sortField} ${sortDir}, created_at ${sortDir}, event_id ASC
    LIMIT ${limit + 1}
  `;

  return {sql, args};
}
```

### 5. Cursor Encoding (Keyset Pagination)

**Why keyset pagination?**
- Offset-based pagination (`LIMIT x OFFSET y`) performs poorly on large datasets
- Keyset pagination uses WHERE clauses on indexed columns
- Consistent results even when data changes

**CRITICAL: Cursor integrity with HMAC**
Cursors must be authenticated to prevent pathological scans from tampered cursors.

**Cursor structure**:
```typescript
interface VideoCursor {
  sortFieldValue: number | string;  // value of the sort field (e.g., loop_count=485)
  createdAt: number;                 // tie-breaker 1
  eventId: string;                   // tie-breaker 2 (unique)
  sortField: string;                 // which field we're sorting by
  sortDir: 'asc' | 'desc';
}

interface SignedCursor {
  payload: VideoCursor;
  hmac: string;  // HMAC-SHA256 of payload
}

function encodeCursor(cursor: VideoCursor, secret: string): string {
  const payload = cursor;
  const hmac = createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  const signed: SignedCursor = { payload, hmac };
  return Buffer.from(JSON.stringify(signed)).toString('base64url');
}

function decodeCursor(encoded: string, secret: string): VideoCursor {
  const signed: SignedCursor = JSON.parse(Buffer.from(encoded, 'base64url').toString());

  // Verify HMAC
  const expectedHmac = createHmac('sha256', secret)
    .update(JSON.stringify(signed.payload))
    .digest('hex');

  if (signed.hmac !== expectedHmac) {
    throw new Error('invalid: cursor tampering detected');
  }

  return signed.payload;
}

function buildCursorClause(
  encodedCursor: string | undefined,
  sortField: string,
  sortDir: 'ASC' | 'DESC',
  args: any[],
  secret: string
): string {
  if (!encodedCursor) return '';

  const cursor = decodeCursor(encodedCursor, secret);

  // CRITICAL: Keyset clause must mirror ORDER BY exactly
  // ORDER BY: sortField DESC/ASC, created_at DESC/ASC, event_id ASC

  // For DESC,DESC,ASC: (field < ?) OR (field = ? AND created_at < ?) OR (field = ? AND created_at = ? AND event_id > ?)
  // For ASC,ASC,ASC:   (field > ?) OR (field = ? AND created_at > ?) OR (field = ? AND created_at = ? AND event_id > ?)

  const fieldOp = sortDir === 'DESC' ? '<' : '>';
  const timeOp = sortDir === 'DESC' ? '<' : '>';  // Same direction as field for created_at
  const idOp = '>';  // Always ASC for event_id tie-breaker

  args.push(
    cursor.sortFieldValue,
    cursor.sortFieldValue, cursor.createdAt,
    cursor.sortFieldValue, cursor.createdAt, cursor.eventId
  );

  return ` AND (
    (${sortField} ${fieldOp} ?)
    OR (${sortField} = ? AND created_at ${timeOp} ?)
    OR (${sortField} = ? AND created_at = ? AND event_id ${idOp} ?)
  )`;
}
```

### 6. Integration Points

**File**: `src/durable-object.ts`

**handleReq() validation** (lines 533-607):
```typescript
// CRITICAL: Whitelist and validate everything
const MAX_INT_FILTERS = 3;  // Prevent Cartesian pain
const MAX_LIMIT = 500;       // Hard cap
const ALLOWED_SORT_FIELDS = ['loop_count', 'likes', 'views', 'comments', 'reposts', 'avg_completion', 'created_at'];
const ALLOWED_INT_COLUMNS = ['loop_count', 'likes', 'views', 'comments', 'reposts', 'avg_completion'];

for (const filter of filters) {
  let intFilterCount = 0;

  // Validate int# filters
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('int#')) {
      intFilterCount++;

      // Enforce max int# predicates
      if (intFilterCount > MAX_INT_FILTERS) {
        this.sendClosed(session.webSocket, subscriptionId,
          `invalid: too many int# filters (max ${MAX_INT_FILTERS})`);
        return;
      }

      // Reject unknown columns
      const column = key.slice(4);
      if (!ALLOWED_INT_COLUMNS.includes(column)) {
        this.sendClosed(session.webSocket, subscriptionId,
          `invalid: unsupported int# column: ${column}`);
        return;
      }

      if (typeof value !== 'object') {
        this.sendClosed(session.webSocket, subscriptionId,
          `invalid: int# filter must be an object with comparison operators`);
        return;
      }

      const validOps = ['gte', 'gt', 'lte', 'lt', 'eq', 'neq'];
      for (const op of Object.keys(value)) {
        if (!validOps.includes(op)) {
          this.sendClosed(session.webSocket, subscriptionId,
            `invalid: unknown int# operator: ${op}`);
          return;
        }
        if (typeof value[op] !== 'number' || !isFinite(value[op])) {
          this.sendClosed(session.webSocket, subscriptionId,
            `invalid: int# operator ${op} must have finite numeric value`);
          return;
        }
      }
    }
  }

  // Validate sort (whitelist fields)
  if (filter.sort) {
    if (typeof filter.sort !== 'object' || !filter.sort.field) {
      this.sendClosed(session.webSocket, subscriptionId,
        `invalid: sort must be object with 'field' property`);
      return;
    }

    if (!ALLOWED_SORT_FIELDS.includes(filter.sort.field)) {
      this.sendClosed(session.webSocket, subscriptionId,
        `invalid: unsupported sort field: ${filter.sort.field}`);
      return;
    }

    if (filter.sort.dir && !['asc', 'desc'].includes(filter.sort.dir)) {
      this.sendClosed(session.webSocket, subscriptionId,
        `invalid: sort dir must be 'asc' or 'desc'`);
      return;
    }
  }

  // Validate cursor
  if (filter.cursor) {
    if (typeof filter.cursor !== 'string') {
      this.sendClosed(session.webSocket, subscriptionId,
        `invalid: cursor must be string`);
      return;
    }

    // Cursor will be verified via HMAC in decodeCursor()
  }

  // Hard cap on limit
  if (filter.limit && filter.limit > MAX_LIMIT) {
    this.sendClosed(session.webSocket, subscriptionId,
      `invalid: limit too high (max ${MAX_LIMIT})`);
    return;
  }
}
```

**File**: `src/relay-worker.ts`

**queryEvents() modification** (around line 1800+):
```typescript
export async function queryEvents(
  filters: NostrFilter[],
  bookmark: string | null,
  env: Env
): Promise<{ events: NostrEvent[]; bookmark: string | null }> {

  // Check if any filter needs videos table
  const needsVideosTable = filters.some(f => shouldUseVideosTable(f));

  if (needsVideosTable) {
    return queryVideosWithMetrics(filters, bookmark, env);
  }

  // Existing events table query logic...
  const d1Result = await queryEvents(filters, bookmark, env);
  // ...
}
```

### 7. Response Format

**Events response** (unchanged):
```json
["EVENT", "sub-id", {...event}]
```

**CRITICAL: Don't extend EOSE** - NIP-01 EOSE is a 2-item array, adding 3rd param breaks clients.

**Cursor via NOTICE** (recommended):
```json
["NOTICE", "sub-id:cursor:<base64url+hmac>"]
```

**Or vendor message** (cleaner separation):
```json
["VCURSOR", "sub-id", "<base64url+hmac>"]
```

**Recommendation**: NOTICE format - works everywhere, doesn't require client changes

### 8. NIP-11 Relay Info Update

**CRITICAL: Vendor-scoped extensions** (no standard for extensions, use vendor prefix)

**File**: `src/config.ts` or `src/relay-worker.ts`

```typescript
export const relayInfo: RelayInfo = {
  // ... existing fields ...

  // Vendor-scoped extensions (divine_extensions not extensions)
  divine_extensions: {
    int_filters: true,
    sort_fields: ["loop_count", "likes", "views", "comments", "reposts", "avg_completion", "created_at"],
    cursor_format: "base64url+hmac",
    videos_kind: 34236,  // Kind consistency: use 34236 throughout
    metrics_ttl: 900,    // Metrics refreshed every 15 minutes
    video_metrics: {
      description: "Filter and sort kind 34236 video events by engagement metrics",
      supported_metrics: ["loop_count", "likes", "views", "comments", "reposts", "avg_completion"],
      eventual_consistency: true
    }
  }
};
```

---

## Part B: Ranked Lists (Kind 30000)

### 9. Ranked List Event Format

**Spec**: Parameterized replaceable events (kind 30000-30039)

```json
{
  "kind": 30000,
  "pubkey": "<relay-publisher-key>",
  "created_at": 1735600123,
  "tags": [
    ["d", "divine.video:rank:loops:hourly:#music"],
    ["metric", "loop_count"],
    ["window", "hourly"],
    ["t", "music"],
    ["ttl", "3600"],
    ["v", "1"],   // Version tag for schema evolution
    ["e", "<top-video-1-id>"],
    ["e", "<top-video-2-id>"],
    ["e", "<top-video-3-id>"],
    // ... up to 500 events
  ],
  "content": "",
  "sig": "..."
}
```

**CRITICAL additions:**
- `["v", "1"]` - Version tag so you can evolve tag set later
- `["ttl", "..."]` - Receivers can drop stale lists automatically
- Keep ≤ 500 e tags per list
- Use dedicated publisher key (not relay infra keys)

**d-tag structure**: `{relay-domain}:rank:{metric}:{window}:{scope}`
- `relay-domain`: e.g., `divine.video`
- `metric`: `loops`, `likes`, `views`
- `window`: `hourly`, `daily`, `weekly`, `monthly`
- `scope`: `#hashtag`, `global`, or `@pubkey`

### 10. List Publisher Implementation

**File**: `src/list-publisher.ts` (new file)

```typescript
import { NostrEvent } from './types';
import { getPublicKey, finalizeEvent, generateSecretKey } from 'nostr-tools';

export async function publishRankedLists(env: Env): Promise<void> {
  console.log('Publishing ranked lists...');

  const windows = [
    { name: 'hourly', seconds: 3600 },
    { name: 'daily', seconds: 86400 },
    { name: 'weekly', seconds: 604800 }
  ];

  const metrics = ['loop_count', 'likes', 'views'];

  // Get top hashtags
  const topHashtags = await getTopHashtags(env.RELAY_DATABASE, 20);

  for (const window of windows) {
    const cutoff = Math.floor(Date.now() / 1000) - window.seconds;

    for (const metric of metrics) {
      // Global top
      await publishRankedList(
        env,
        `divine.video:rank:${metric}:${window.name}:global`,
        metric,
        window.name,
        null, // no hashtag filter
        cutoff
      );

      // Per-hashtag top
      for (const hashtag of topHashtags) {
        await publishRankedList(
          env,
          `divine.video:rank:${metric}:${window.name}:#${hashtag}`,
          metric,
          window.name,
          hashtag,
          cutoff
        );
      }
    }
  }
}

async function publishRankedList(
  env: Env,
  dTag: string,
  metric: string,
  window: string,
  hashtag: string | null,
  cutoffTime: number
): Promise<void> {
  // Query top videos
  const query = `
    SELECT event_id
    FROM videos
    WHERE created_at >= ?
    ${hashtag ? 'AND hashtag = ?' : ''}
    ORDER BY ${metric} DESC, created_at DESC
    LIMIT 500
  `;

  const args = hashtag ? [cutoffTime, hashtag] : [cutoffTime];
  const results = await env.RELAY_DATABASE.prepare(query).bind(...args).all();

  if (!results.results || results.results.length === 0) {
    console.log(`No results for ${dTag}`);
    return;
  }

  // Build event
  const tags: string[][] = [
    ['d', dTag],
    ['metric', metric],
    ['window', window],
    ['ttl', window === 'hourly' ? '3600' : window === 'daily' ? '86400' : '604800']
  ];

  if (hashtag) {
    tags.push(['t', hashtag]);
  }

  for (const row of results.results) {
    tags.push(['e', row.event_id as string]);
  }

  // Get publisher key from env or generate
  const publisherSk = env.PUBLISHER_SECRET_KEY || generateSecretKey();

  const event: NostrEvent = {
    kind: 30000,
    pubkey: getPublicKey(publisherSk),
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
    id: '', // will be set by finalizeEvent
    sig: '' // will be set by finalizeEvent
  };

  const signedEvent = finalizeEvent(event, publisherSk);

  // Publish to relay (insert into events table)
  await processEvent(signedEvent, 'list-publisher', env);

  console.log(`Published ranked list: ${dTag} (${results.results.length} videos)`);
}

async function getTopHashtags(db: D1Database, limit: number): Promise<string[]> {
  const result = await db.prepare(`
    SELECT hashtag, COUNT(*) as count
    FROM videos
    WHERE hashtag IS NOT NULL
    GROUP BY hashtag
    ORDER BY count DESC
    LIMIT ?
  `).bind(limit).all();

  return (result.results || []).map(r => r.hashtag as string);
}
```

### 11. Scheduled Cron Integration

**File**: `src/relay-worker.ts`

**Update scheduled handler**:
```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('Running scheduled maintenance...');

  try {
    // Existing: archive old events
    await archiveOldEvents(env.RELAY_DATABASE, env.EVENT_ARCHIVE);

    // NEW: publish ranked lists (every 15 min, but check TTL inside)
    await publishRankedLists(env);

    // Existing: optimize
    const session = env.RELAY_DATABASE.withSession('first-primary');
    await session.prepare('PRAGMA optimize').run();

    console.log('Scheduled tasks completed');
  } catch (error) {
    console.error('Scheduled task failed:', error);
  }
}
```

**Update wrangler.toml**:
```toml
[triggers]
crons = ["*/15 * * * *"]  # Every 15 minutes
```

---

## Implementation Phases

### Phase 1: Core Video Queries (Week 1)
- [ ] Create `src/video-queries.ts` with query builder
- [ ] Add `shouldUseVideosTable()` logic
- [ ] Integrate into `queryEvents()` with dual-path
- [ ] Test basic int# filters (loop_count, likes)
- [ ] Test basic sorting

### Phase 2: Validation & Polish (Week 1)
- [ ] Add filter validation in `handleReq()`
- [ ] Implement cursor encoding/decoding
- [ ] Add keyset pagination
- [ ] Extended EOSE with cursor metadata
- [ ] Update NIP-11 with extensions

### Phase 3: Ranked Lists (Week 2)
- [ ] Implement `list-publisher.ts`
- [ ] Add nostr-tools dependency for signing
- [ ] Configure publisher secret key (env var)
- [ ] Integrate into scheduled() handler
- [ ] Test list publication

### Phase 4: Multi-Hashtag Support (Week 2)
- [ ] Create `video_hashtags` junction table
- [ ] Update backfill script for multiple hashtags
- [ ] Update query builder for hashtag joins
- [ ] Update event insertion to populate hashtags

### Phase 5: Analytics Pipeline (Week 3+)
- [ ] Design views/completion event format (kind 72xx?)
- [ ] Build aggregator worker
- [ ] Periodic upsert into videos table
- [ ] Real-time vs batch trade-offs

---

## Edge Cases & Considerations

### Performance
- **Index coverage**: All sort fields must have indexes (already done)
- **Query limits**: Cap at 500 events max per query
- **Cursor expiry**: Cursors don't expire, but results may change
- **Cache invalidation**: videos table changes invalidate cached queries

### Data Consistency
- **Eventual consistency**: videos table updated async from analytics
- **Stale data**: Document TTL in NIP-11
- **Missing videos**: New videos may not have metrics yet (default 0)

### Security
- **SQL injection**: Use prepared statements (already doing)
- **DoS via complex queries**: Validate all int# operators, limit combinations
- **Rate limiting**: Apply same REQ rate limits to video queries

### Backward Compatibility
- **Standard clients**: Unaware of extensions, get normal events
- **Unknown fields**: Ignored by standard parsers (JSON tolerance)
- **Fallback**: If videos table query fails, fall back to events table

### Multi-Hashtag Strategy
**Current**: `videos.hashtag` stores first hashtag only (explicit limitation)
**Phase 4**:
```sql
CREATE TABLE video_hashtags (
  event_id TEXT NOT NULL,
  hashtag TEXT NOT NULL,
  PRIMARY KEY (event_id, hashtag),
  FOREIGN KEY (event_id) REFERENCES videos(event_id) ON DELETE CASCADE
);

-- Index for hashtag lookups
CREATE INDEX idx_vh_hashtag_event ON video_hashtags(hashtag, event_id);
```

**Query shape with hashtag filter**:
```sql
SELECT v.*
FROM videos v
JOIN video_hashtags h ON h.event_id = v.event_id
WHERE h.hashtag IN (?, ...)
  AND v.created_at >= ?
ORDER BY v.loop_count DESC, v.created_at DESC, v.event_id ASC
LIMIT ?;
```

**Document in README**: "Phase 1-3 match primary hashtag only. Multi-hashtag filtering coming in Phase 4."

---

## Testing Strategy

### Unit Tests
- Cursor encode/decode round-trip
- Query builder with various filter combinations
- Int# operator validation
- Sort field validation

### Integration Tests
1. **Basic video query**: `kinds: [34236], limit: 10`
2. **Int filter**: `int#loop_count: {gte: 1000}`
3. **Sort by loops**: `sort: {field: "loop_count", dir: "desc"}`
4. **Combined**: hashtag + int filter + sort + cursor
5. **Ranked list fetch**: Query kind 30000 with d-tag

### Load Tests
- 1000 concurrent video queries
- Cursor pagination through 10k results
- Ranked list generation on 100k videos

---

## Rollout Plan

1. **Deploy schema** (videos table) ✅ DONE
2. **Backfill existing videos** ✅ DONE
3. **Deploy query infrastructure** (dual-path, validation)
4. **Test with curl/websocat**: Manual REQ messages
5. **Update NIP-11**
6. **Deploy ranked list publisher**
7. **Document in README**: Usage examples
8. **Client adoption**: Work with Openvine/Divine.video frontend

---

## Open Questions

1. **Publisher key management**: Env var vs. Durable Object storage?
2. **Ranked list retention**: How many historical versions to keep?
3. **Analytics event schema**: What kind # for view/completion events?
4. **Real-time updates**: Should ranked lists push via EVENT to subscriptions?
5. **Multi-relay**: How to federate ranked lists across relays?

---

## Success Metrics

- [ ] Video queries 10x faster than tag-based filtering
- [ ] Cursor pagination enables infinite scroll
- [ ] Ranked lists updated within 15 min of new data
- [ ] 95% of queries use videos table when available
- [ ] Zero SQL injection vulnerabilities
- [ ] Backward compatible with 100% of existing clients

---

## Files to Create/Modify

**New files**:
- `src/video-queries.ts` - Query builder and cursor logic
- `src/list-publisher.ts` - Ranked list generation
- `VIDEO_FILTERS_IMPLEMENTATION_PLAN.md` - This document

**Modified files**:
- `src/relay-worker.ts` - queryEvents() dual-path, scheduled()
- `src/durable-object.ts` - handleReq() validation
- `src/config.ts` - NIP-11 extensions
- `wrangler.toml` - Cron schedule, env vars
- `package.json` - Add nostr-tools dependency

---

**Total estimated effort**: 2-3 weeks for full implementation
**Minimal viable version**: 3-5 days (Phase 1 + 2 only)
