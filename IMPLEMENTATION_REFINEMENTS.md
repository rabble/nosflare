# Video Discovery: Implementation Refinements

## Critical Fixes Applied

### 1. ✅ Don't Extend EOSE
**Problem**: Extended EOSE breaks NIP-01 clients
**Fix**: Use `["NOTICE", "sub:cursor:<base64url+hmac>"]` instead
**Status**: Updated in plan

### 2. ✅ Vendor-Scoped NIP-11
**Problem**: Generic `extensions` block may collide
**Fix**: Use `divine_extensions` vendor namespace
**Status**: Updated in plan

### 3. ✅ Composite Indexes Matching ORDER BY
**Problem**: SQLite only uses indexes when WHERE + ORDER BY align
**Fix**: Added comprehensive composite indexes:
- `idx_videos_loops_created_id` (loop_count DESC, created_at DESC, event_id ASC)
- `idx_videos_hashtag_loops_created_id` (hashtag, loop_count DESC, created_at DESC, event_id ASC)
- Plus views, likes, comments, reposts variations
**Status**: Updated in plan, **needs schema deployment**

### 4. ✅ Cursor HMAC Authentication
**Problem**: Tampered cursors → pathological scans
**Fix**: HMAC-SHA256 signed cursors with verification
**Status**: Updated in plan

### 5. ✅ Keyset Clause Mirrors ORDER BY
**Problem**: Must match exact ORDER BY precedence
**Fix**: Explicit DESC,DESC,ASC operators for field, created_at, event_id
**Status**: Updated in plan

### 6. ✅ Whitelist Validation
**Problem**: SQL injection, DoS risks
**Fix**:
- Hard caps: MAX_LIMIT=500, MAX_INT_FILTERS=3
- Whitelist all sort fields and int# columns
- Reject unknown fields, Infinity, NaN
**Status**: Updated in plan

### 7. ✅ Ranked List Improvements
**Problem**: No versioning, size limits unclear
**Fix**:
- Add `["v", "1"]` version tag
- Keep ≤ 500 e tags per list
- Use dedicated publisher key (not relay infra keys)
**Status**: Updated in plan

### 8. ✅ Multi-Hashtag Documentation
**Problem**: Current limitation unclear
**Fix**: Explicit README note: "Phase 1-3 match primary hashtag only"
**Status**: Updated in plan

---

## Remaining TODO Before Shipping

### Schema Updates Needed
```typescript
// Add to relay-worker.ts schema initialization:

// Replace existing idx_videos_* indexes with:
const VIDEO_INDEXES = [
  // Global sorts
  `CREATE INDEX IF NOT EXISTS idx_videos_loops_created_id
    ON videos(loop_count DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_likes_created_id
    ON videos(likes DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_views_created_id
    ON videos(views DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_comments_created_id
    ON videos(comments DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_reposts_created_id
    ON videos(reposts DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_avg_completion_created_id
    ON videos(avg_completion DESC, created_at DESC, event_id ASC)`,

  // With hashtag constraint
  `CREATE INDEX IF NOT EXISTS idx_videos_hashtag_loops_created_id
    ON videos(hashtag, loop_count DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_hashtag_likes_created_id
    ON videos(hashtag, likes DESC, created_at DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_hashtag_views_created_id
    ON videos(hashtag, views DESC, created_at DESC, event_id ASC)`,

  // Time window queries
  `CREATE INDEX IF NOT EXISTS idx_videos_time_loops_id
    ON videos(created_at DESC, loop_count DESC, event_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_time_likes_id
    ON videos(created_at DESC, likes DESC, event_id ASC)`
];
```

### Code Additions Needed

**1. Cursor Secret** (env var):
```toml
# wrangler.toml
[vars]
CURSOR_SECRET = "generate-random-256-bit-secret-here"
```

**2. Publisher Key** (env var):
```toml
# wrangler.toml (secrets)
# Run: wrangler secret put PUBLISHER_SECRET_KEY
# Value: hex-encoded nostr private key for signing ranked lists
```

### Testing Requirements

**CI checks**:
```bash
# Add to .github/workflows/test.yml
- name: Check index usage
  run: |
    sqlite3 test.db "EXPLAIN QUERY PLAN SELECT * FROM videos
      WHERE hashtag = 'music'
      ORDER BY loop_count DESC, created_at DESC, event_id ASC
      LIMIT 50" | grep -q "USING INDEX"
```

**Cursor fuzzing**:
- Invalid base64 → CLOSED with error
- Wrong HMAC → CLOSED with "cursor tampering"
- Mismatched sortDir → safe handling

---

## Success Metrics (Testable)

- [ ] p95 vendor-sorted query latency < 60ms at edge
- [ ] p95 cursor page advance < 40ms
- [ ] Ranked lists republished within ≤ 15 min
- [ ] 0 extended-EOSE usage (lint in tests)
- [ ] < 1% queries hitting fallback when videos path intended
- [ ] All queries use intended indexes (EXPLAIN QUERY PLAN snapshots)

---

## Shipping Checklist

### Phase 1 (Core Queries)
- [ ] Deploy updated schema with composite indexes
- [ ] Implement `shouldUseVideosTable()` decision logic
- [ ] Build query builder with int# filters
- [ ] Add sorting with whitelist validation
- [ ] Test with curl/websocat

### Phase 2 (Security & Polish)
- [ ] Add HMAC cursor encoding/decoding
- [ ] Implement keyset pagination
- [ ] Add NOTICE cursor messages
- [ ] Update NIP-11 with divine_extensions
- [ ] Add EXPLAIN QUERY PLAN tests to CI

### Phase 3 (Ranked Lists)
- [ ] Generate publisher keypair
- [ ] Implement list-publisher.ts
- [ ] Add version tags and TTL
- [ ] Wire into scheduled() handler
- [ ] Test list consumption

### Phase 4 (Multi-Hashtag)
- [ ] Create video_hashtags junction table
- [ ] Update backfill for multiple hashtags
- [ ] Add JOIN queries for hashtag filters
- [ ] Update README with feature availability

---

## Kind Consistency

**Standardize on 34236** throughout:
- Events table filter
- NIP-11 divine_extensions.videos_kind
- Documentation examples
- Client code

---

## Rate Limiting Strategy

```typescript
// Per-connection quotas for vendor queries
const VENDOR_QUERY_QUOTA = {
  perMinute: 20,  // max 20 vendor-sorted queries per minute per connection
  burstSize: 5    // allow 5 immediate queries
};

// Enforce in handleReq():
if (hasVendorExtensions(filter)) {
  if (!session.vendorQueryLimiter.removeToken()) {
    this.sendClosed(session.webSocket, subscriptionId,
      'rate-limited: vendor query quota exceeded');
    return;
  }
}
```

---

## Documentation Updates

**README.md additions**:
```markdown
## Video Discovery Extensions

This relay supports vendor extensions for filtering and sorting video events (kind 34236) by engagement metrics.

### Metrics Freshness
- Metrics updated every 15 minutes
- Eventually consistent (not real-time)
- TTL documented in NIP-11

### Current Limitations
- Phase 1-3: Hashtag filters match primary hashtag only
- Phase 4+: Multi-hashtag filtering via junction table

### Ranked Lists
- Published as kind 30000 events
- Updated every 15 minutes
- d-tag format: `divine.video:rank:{metric}:{window}:{scope}`
- Scopes: global, #hashtag
- Windows: hourly, daily, weekly
```

---

## Files Modified Summary

**Updated**:
- `VIDEO_FILTERS_IMPLEMENTATION_PLAN.md` - All critical fixes applied

**To Create**:
- `src/video-queries.ts` - Query builder
- `src/list-publisher.ts` - Ranked list generation
- `src/cursor-auth.ts` - HMAC signing/verification

**To Modify**:
- `src/relay-worker.ts` - Schema indexes, dual-path queries, scheduled()
- `src/durable-object.ts` - Validation, NOTICE cursor messages
- `src/config.ts` - divine_extensions in NIP-11
- `wrangler.toml` - Env vars for secrets

---

## Review Status

✅ **All critical redlines addressed**:
1. EOSE not extended
2. Vendor-scoped NIP-11
3. Composite indexes designed
4. Cursor HMAC planned
5. Keyset clause corrected
6. Whitelisting enforced
7. Ranked lists improved
8. Multi-hashtag documented

**Ready for Phase 1 implementation.**
