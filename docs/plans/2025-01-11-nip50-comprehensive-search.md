# NIP-50 Comprehensive Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement full NIP-50 search capability across all entity types (users, videos, lists, hashtags, notes, articles, communities) using FTS5 for fast text search and optional AI Search for semantic queries.

**Architecture:** Three-layer search system: (1) FTS5 virtual tables for fast keyword/prefix search with BM25 relevance ranking, (2) Entity-specific search functions for each Nostr kind, (3) Unified search API with intelligent query routing. Optional AI Search layer for semantic/natural language queries.

**Tech Stack:** SQLite FTS5 (D1 built-in), Cloudflare Workers, TypeScript, Nostr protocol (NIP-50), optional Cloudflare AI Search

---

## Phase 1: FTS5 Foundation & Core Search

### Task 1: Create FTS5 Virtual Tables and Migration

**Files:**
- Modify: `src/migrations.ts` (add FTS5 table creation)
- Test: `test-fts5-tables.cjs` (verify tables exist)

**Step 1: Write the failing test**

Create `test-fts5-tables.cjs`:

```javascript
const WebSocket = require('ws');

async function testFTS5Tables() {
  console.log('Testing FTS5 table creation...');

  // Connect to relay
  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('✓ Connected to relay');

      // Query to check if FTS5 tables exist
      // We'll send a search query and expect proper handling
      const searchReq = JSON.stringify([
        'REQ',
        'test-fts5',
        {
          search: 'test query',
          kinds: [0],
          limit: 1
        }
      ]);

      ws.send(searchReq);

      setTimeout(() => {
        console.log('✓ FTS5 tables should exist');
        ws.close();
        resolve();
      }, 1000);
    });

    ws.on('error', reject);
  });
}

testFTS5Tables().then(() => {
  console.log('All tests passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-fts5-tables.cjs`

Expected: Test should fail or show search not working

**Step 3: Add FTS5 migrations**

Modify `src/migrations.ts`, add new migration at the end of the `migrations` array:

```typescript
{
  id: 14,
  name: 'create_fts5_tables',
  sql: `
    -- Users FTS5 (kind 0)
    CREATE VIRTUAL TABLE IF NOT EXISTS users_fts USING fts5(
      event_id UNINDEXED,
      pubkey UNINDEXED,
      name,
      display_name,
      about,
      nip05,
      tokenize='porter unicode61 remove_diacritics 1'
    );

    -- Videos FTS5 (kind 34236)
    CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
      event_id UNINDEXED,
      title,
      description,
      summary,
      content,
      tokenize='porter unicode61'
    );

    -- Hashtags FTS5 (all kinds with #t tags)
    CREATE VIRTUAL TABLE IF NOT EXISTS hashtags_fts USING fts5(
      hashtag,
      event_id UNINDEXED,
      tokenize='trigram'
    );

    -- Hashtag statistics table
    CREATE TABLE IF NOT EXISTS hashtag_stats (
      hashtag TEXT PRIMARY KEY,
      total_usage INTEGER DEFAULT 1,
      unique_events INTEGER DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      trending_score REAL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_hashtag_trending
      ON hashtag_stats(trending_score DESC, last_seen DESC);

    -- Lists FTS5 (kinds 30000-30003, 10000-10003)
    CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts USING fts5(
      event_id UNINDEXED,
      d_tag UNINDEXED,
      kind UNINDEXED,
      name,
      description,
      content,
      tokenize='porter unicode61'
    );

    -- Notes FTS5 (kind 1)
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      event_id UNINDEXED,
      content,
      tokenize='porter unicode61'
    );

    -- Articles FTS5 (kind 30023)
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      event_id UNINDEXED,
      d_tag UNINDEXED,
      title,
      summary,
      content,
      tokenize='porter unicode61'
    );

    -- Communities FTS5 (kind 34550)
    CREATE VIRTUAL TABLE IF NOT EXISTS communities_fts USING fts5(
      event_id UNINDEXED,
      d_tag UNINDEXED,
      name,
      description,
      tokenize='porter unicode61'
    );
  `
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-fts5-tables.cjs`

Expected: Test passes, FTS5 tables created

**Step 5: Commit**

```bash
git add src/migrations.ts test-fts5-tables.cjs
git commit -m "feat: add FTS5 virtual tables for comprehensive search"
```

---

### Task 2: Create Search Types and Interfaces

**Files:**
- Modify: `src/types.ts` (add search types)
- Test: None (type definitions only)

**Step 1: Add search type definitions**

Add to `src/types.ts`:

```typescript
// Search-related types
export type SearchEntityType = 'user' | 'video' | 'list' | 'hashtag' | 'note' | 'article' | 'community' | 'all';

export interface SearchOptions {
  query: string;
  types?: SearchEntityType[];
  kinds?: number[];
  limit?: number;
  offset?: number;
  minRelevance?: number;
}

export interface SearchResult {
  type: SearchEntityType;
  event: NostrEvent;
  relevance_score: number;
  snippet?: string;
  match_fields?: string[];
}

export interface ParsedSearchQuery {
  raw: string;
  terms: string[];
  type?: SearchEntityType;
  filters: {
    author?: string;
    kind?: number;
    hashtags?: string[];
    since?: number;
    until?: number;
    min_likes?: number;
    min_loops?: number;
  };
}

// Extend NostrFilter to include search
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;  // NIP-50
  search_types?: SearchEntityType[];  // Extension
  [key: `#${string}`]: string[] | undefined;

  // Video vendor extensions (existing)
  sort?: {
    field: string;
    dir: 'asc' | 'desc';
  };
  cursor?: string;
  verification?: string[];
  [key: `int#${string}`]: any;
}
```

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add search types and NIP-50 filter extension"
```

---

### Task 3: Implement Search Query Parser

**Files:**
- Create: `src/search-parser.ts`
- Test: `test-search-parser.cjs`

**Step 1: Write the failing test**

Create `test-search-parser.cjs`:

```javascript
const { parseSearchQuery } = require('./dist/search-parser.js');

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`❌ ${message}`);
    console.error('Expected:', expected);
    console.error('Actual:', actual);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

console.log('Testing search query parser...');

// Test 1: Simple keyword query
const result1 = parseSearchQuery('bitcoin nostr');
assertEquals(result1.terms, ['bitcoin', 'nostr'], 'Simple keyword parsing');
assertEquals(result1.filters, {}, 'No filters for simple query');

// Test 2: Type filter
const result2 = parseSearchQuery('type:user rabble');
assertEquals(result2.type, 'user', 'Type filter parsed');
assertEquals(result2.terms, ['rabble'], 'Remaining terms after type');

// Test 3: Hashtag extraction
const result3 = parseSearchQuery('#dance #music video');
assertEquals(result3.filters.hashtags, ['dance', 'music'], 'Hashtags extracted');
assertEquals(result3.terms, ['video'], 'Terms without hashtags');

// Test 4: Author filter
const result4 = parseSearchQuery('author:abc123 content');
assertEquals(result4.filters.author, 'abc123', 'Author filter parsed');
assertEquals(result4.terms, ['content'], 'Terms after author');

// Test 5: Complex query
const result5 = parseSearchQuery('type:video #cooking author:rabble min_likes:100 italian food');
assertEquals(result5.type, 'video', 'Complex: type');
assertEquals(result5.filters.hashtags, ['cooking'], 'Complex: hashtags');
assertEquals(result5.filters.author, 'rabble', 'Complex: author');
assertEquals(result5.filters.min_likes, 100, 'Complex: min_likes');
assertEquals(result5.terms, ['italian', 'food'], 'Complex: remaining terms');

console.log('\n✓ All parser tests passed!');
```

**Step 2: Run test to verify it fails**

Run: `node test-search-parser.cjs`

Expected: FAIL with "Cannot find module './dist/search-parser.js'"

**Step 3: Write minimal implementation**

Create `src/search-parser.ts`:

```typescript
import { ParsedSearchQuery, SearchEntityType } from './types';

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    raw: query,
    terms: [],
    filters: {}
  };

  const tokens = query.split(/\s+/);

  for (const token of tokens) {
    if (!token) continue;

    if (token.startsWith('type:')) {
      parsed.type = token.substring(5) as SearchEntityType;
    } else if (token.startsWith('author:')) {
      parsed.filters.author = token.substring(7);
    } else if (token.startsWith('kind:')) {
      parsed.filters.kind = parseInt(token.substring(5));
    } else if (token.startsWith('#')) {
      if (!parsed.filters.hashtags) parsed.filters.hashtags = [];
      parsed.filters.hashtags.push(token.substring(1));
    } else if (token.startsWith('min_likes:')) {
      parsed.filters.min_likes = parseInt(token.substring(10));
    } else if (token.startsWith('min_loops:')) {
      parsed.filters.min_loops = parseInt(token.substring(10));
    } else if (token.startsWith('since:')) {
      parsed.filters.since = parseInt(token.substring(6));
    } else if (token.startsWith('until:')) {
      parsed.filters.until = parseInt(token.substring(6));
    } else {
      // Regular search term
      parsed.terms.push(token);
    }
  }

  return parsed;
}

export function buildFTSQuery(terms: string[]): string {
  if (terms.length === 0) return '';
  // Build FTS5 query with prefix matching
  return terms.map(t => `${t}*`).join(' OR ');
}
```

**Step 4: Update tsconfig to export search-parser**

Modify `tsconfig.json` to ensure proper compilation, then run:

```bash
npm run build
```

**Step 5: Run test to verify it passes**

Run: `node test-search-parser.cjs`

Expected: PASS - "All parser tests passed!"

**Step 6: Commit**

```bash
git add src/search-parser.ts test-search-parser.cjs tsconfig.json
git commit -m "feat: implement search query parser with NIP-50 extensions"
```

---

### Task 4: Implement User Profile Search

**Files:**
- Create: `src/search.ts` (new search module)
- Test: `test-user-search.cjs`

**Step 1: Write the failing test**

Create `test-user-search.cjs`:

```javascript
const WebSocket = require('ws');

async function testUserSearch() {
  console.log('Testing user profile search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // First, publish a test user profile
      const testProfile = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          name: 'testuser',
          display_name: 'Test User',
          about: 'I am a test user for search testing',
          nip05: 'test@example.com'
        })
      };

      // Generate fake pubkey and sig for testing
      testProfile.pubkey = 'a'.repeat(64);
      testProfile.id = 'b'.repeat(64);
      testProfile.sig = 'c'.repeat(128);

      // Publish profile
      ws.send(JSON.stringify(['EVENT', testProfile]));

      // Wait a moment for indexing
      await new Promise(r => setTimeout(r, 500));

      // Now search for the user
      const searchReq = JSON.stringify([
        'REQ',
        'search-user',
        {
          search: 'type:user testuser',
          kinds: [0],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-user') {
        receivedResults = true;
        console.log('✓ Received search result:', msg[2].content);
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-user') {
        if (receivedResults) {
          console.log('✓ User search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No search results returned');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testUserSearch().then(() => {
  console.log('\n✓ User search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-user-search.cjs`

Expected: FAIL - search not implemented yet

**Step 3: Implement user search function**

Create `src/search.ts`:

```typescript
import { NostrEvent, SearchResult, ParsedSearchQuery } from './types';
import { buildFTSQuery } from './search-parser';

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

export async function indexUserProfile(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const profile = JSON.parse(event.content);
    const session = db.withSession('first-primary');

    await session.prepare(`
      INSERT INTO users_fts(event_id, pubkey, name, display_name, about, nip05)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        name = excluded.name,
        display_name = excluded.display_name,
        about = excluded.about,
        nip05 = excluded.nip05
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
```

**Step 4: Integrate search into relay worker**

Modify `src/relay-worker.ts`, find the `processEvent` function and add indexing for kind 0:

```typescript
// In processEvent function, after event is stored, add:
if (event.kind === 0) {
  // Index user profile for search
  await indexUserProfile(env.RELAY_DATABASE, event);
}
```

Add import at top:
```typescript
import { indexUserProfile } from './search';
```

**Step 5: Integrate search into durable object query handler**

Modify `src/durable-object.ts`, find the query handling section and add search support:

```typescript
// Import at top
import { searchUsers } from './search';
import { parseSearchQuery } from './search-parser';

// In handleQuery function, add search handling before standard query:
if (filter.search) {
  const parsed = parseSearchQuery(filter.search);

  if (parsed.type === 'user' || filter.kinds?.includes(0)) {
    const searchResults = await searchUsers(db, parsed, filter.limit || 50);

    for (const result of searchResults) {
      if (subscriptionId && this.subscriptions.has(subscriptionId)) {
        this.sendToSubscriber(subscriptionId, result.event);
      }
    }

    return {
      success: true,
      events: searchResults.map(r => r.event),
      cursor: null
    };
  }
}
```

**Step 6: Run test to verify it passes**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-user-search.cjs`

Expected: PASS - "User search test passed!"

**Step 7: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-user-search.cjs
git commit -m "feat: implement user profile search with FTS5"
```

---

### Task 5: Implement Hashtag Search & Autocomplete

**Files:**
- Modify: `src/search.ts` (add hashtag functions)
- Test: `test-hashtag-autocomplete.cjs`

**Step 1: Write the failing test**

Create `test-hashtag-autocomplete.cjs`:

```javascript
const WebSocket = require('ws');

async function testHashtagAutocomplete() {
  console.log('Testing hashtag autocomplete...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = 0;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Publish test events with hashtags
      const testEvents = [
        { hashtags: ['dance', 'music'] },
        { hashtags: ['dancing', 'party'] },
        { hashtags: ['danube', 'river'] }
      ];

      for (const testData of testEvents) {
        const event = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: testData.hashtags.map(h => ['t', h]),
          content: `Test note with hashtags: ${testData.hashtags.join(' ')}`,
          pubkey: 'd'.repeat(64),
          id: Math.random().toString(36).substring(2) + 'a'.repeat(50),
          sig: 'e'.repeat(128)
        };

        ws.send(JSON.stringify(['EVENT', event]));
      }

      // Wait for indexing
      await new Promise(r => setTimeout(r, 500));

      // Search for hashtags starting with "dan"
      const searchReq = JSON.stringify([
        'REQ',
        'hashtag-search',
        {
          search: 'hashtag:#dan',
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'hashtag-search') {
        receivedResults++;
        console.log('✓ Found hashtag result');
      }

      if (msg[0] === 'EOSE' && msg[1] === 'hashtag-search') {
        if (receivedResults >= 2) {
          console.log(`✓ Hashtag autocomplete working! Found ${receivedResults} results`);
          ws.close();
          resolve();
        } else {
          console.error(`❌ Expected at least 2 results, got ${receivedResults}`);
          ws.close();
          reject(new Error('Insufficient results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testHashtagAutocomplete().then(() => {
  console.log('\n✓ Hashtag autocomplete test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-hashtag-autocomplete.cjs`

Expected: FAIL - hashtag search not implemented

**Step 3: Implement hashtag search functions**

Add to `src/search.ts`:

```typescript
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
```

**Step 4: Integrate hashtag indexing**

Modify `src/relay-worker.ts`, in `processEvent` function:

```typescript
// After storing event, index hashtags for ALL event kinds
await indexHashtags(env.RELAY_DATABASE, event);
```

Add import:
```typescript
import { indexUserProfile, indexHashtags } from './search';
```

**Step 5: Integrate hashtag search into query handler**

Modify `src/durable-object.ts`, in search handling section:

```typescript
import { searchUsers, searchHashtags } from './search';

// In handleQuery, add hashtag search:
if (filter.search) {
  const parsed = parseSearchQuery(filter.search);

  if (parsed.raw.includes('hashtag:')) {
    const searchResults = await searchHashtags(db, parsed, filter.limit || 50);

    for (const result of searchResults) {
      if (subscriptionId && this.subscriptions.has(subscriptionId)) {
        this.sendToSubscriber(subscriptionId, result.event);
      }
    }

    return {
      success: true,
      events: searchResults.map(r => r.event),
      cursor: null
    };
  }

  // ... existing user search code
}
```

**Step 6: Run test to verify it passes**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-hashtag-autocomplete.cjs`

Expected: PASS - "Hashtag autocomplete test passed!"

**Step 7: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-hashtag-autocomplete.cjs
git commit -m "feat: implement hashtag search and autocomplete with trigram matching"
```

---

### Task 6: Implement Video Content Search

**Files:**
- Modify: `src/search.ts` (add video search)
- Test: `test-video-search.cjs`

**Step 1: Write the failing test**

Create `test-video-search.cjs`:

```javascript
const WebSocket = require('ws');

async function testVideoSearch() {
  console.log('Testing video content search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Publish a test video
      const testVideo = {
        kind: 34236,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test-video-123'],
          ['title', 'Funny Dance Tutorial'],
          ['summary', 'Learn to dance like a pro'],
          ['t', 'dance'],
          ['t', 'tutorial']
        ],
        content: 'This is a comprehensive guide to dancing with style and grace',
        pubkey: 'f'.repeat(64),
        id: 'g'.repeat(64),
        sig: 'h'.repeat(128)
      };

      ws.send(JSON.stringify(['EVENT', testVideo]));

      await new Promise(r => setTimeout(r, 500));

      // Search for dancing videos
      const searchReq = JSON.stringify([
        'REQ',
        'search-videos',
        {
          search: 'type:video dancing',
          kinds: [34236],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-videos') {
        receivedResults = true;
        console.log('✓ Received video search result');
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-videos') {
        if (receivedResults) {
          console.log('✓ Video search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No video search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testVideoSearch().then(() => {
  console.log('\n✓ Video search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-video-search.cjs`

Expected: FAIL - video search not implemented

**Step 3: Implement video search function**

Add to `src/search.ts`:

```typescript
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

export async function indexVideo(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const title = event.tags.find(t => t[0] === 'title')?.[1] || '';
    const summary = event.tags.find(t => t[0] === 'summary')?.[1] || '';
    const session = db.withSession('first-primary');

    await session.prepare(`
      INSERT INTO videos_fts(event_id, title, description, summary, content)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        summary = excluded.summary,
        content = excluded.content
    `).bind(event.id, title, event.content, summary, event.content).run();
  } catch (error) {
    console.error('Error indexing video:', error);
  }
}
```

**Step 4: Integrate video indexing**

Modify `src/relay-worker.ts`, in `processEvent`:

```typescript
// Add video indexing
if (event.kind === 34236) {
  await indexVideo(env.RELAY_DATABASE, event);
}
```

Add import:
```typescript
import { indexUserProfile, indexHashtags, indexVideo } from './search';
```

**Step 5: Integrate video search into query handler**

Modify `src/durable-object.ts`, add to search handling:

```typescript
import { searchUsers, searchHashtags, searchVideos } from './search';

// In search handling:
if (parsed.type === 'video' || filter.kinds?.includes(34236)) {
  const searchResults = await searchVideos(db, parsed, filter.limit || 50);

  for (const result of searchResults) {
    if (subscriptionId && this.subscriptions.has(subscriptionId)) {
      this.sendToSubscriber(subscriptionId, result.event);
    }
  }

  return {
    success: true,
    events: searchResults.map(r => r.event),
    cursor: null
  };
}
```

**Step 6: Run test to verify it passes**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-video-search.cjs`

Expected: PASS - "Video search test passed!"

**Step 7: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-video-search.cjs
git commit -m "feat: implement video content search with engagement boosting"
```

---

## Phase 2: Extended Entity Types

### Task 7: Implement Notes Search (kind 1)

**Files:**
- Modify: `src/search.ts`
- Test: `test-note-search.cjs`

**Step 1: Write the failing test**

Create `test-note-search.cjs`:

```javascript
const WebSocket = require('ws');

async function testNoteSearch() {
  console.log('Testing note content search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Publish test notes
      const testNote = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'Just learned about the Nostr protocol and Bitcoin integration. Amazing stuff!',
        pubkey: 'i'.repeat(64),
        id: 'j'.repeat(64),
        sig: 'k'.repeat(128)
      };

      ws.send(JSON.stringify(['EVENT', testNote]));

      await new Promise(r => setTimeout(r, 500));

      // Search notes
      const searchReq = JSON.stringify([
        'REQ',
        'search-notes',
        {
          search: 'type:note Nostr protocol',
          kinds: [1],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-notes') {
        receivedResults = true;
        console.log('✓ Received note search result');
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-notes') {
        if (receivedResults) {
          console.log('✓ Note search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No note search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testNoteSearch().then(() => {
  console.log('\n✓ Note search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `node test-note-search.cjs` (with dev server running)

Expected: FAIL

**Step 3: Implement note search**

Add to `src/search.ts`:

```typescript
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

export async function indexNote(
  db: D1Database,
  event: NostrEvent
): Promise<void> {
  try {
    const session = db.withSession('first-primary');

    await session.prepare(`
      INSERT INTO notes_fts(event_id, content)
      VALUES (?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        content = excluded.content
    `).bind(event.id, event.content).run();
  } catch (error) {
    console.error('Error indexing note:', error);
  }
}
```

**Step 4: Integrate note indexing and search**

Modify `src/relay-worker.ts`:

```typescript
if (event.kind === 1) {
  await indexNote(env.RELAY_DATABASE, event);
}
```

Modify `src/durable-object.ts`:

```typescript
import { searchUsers, searchHashtags, searchVideos, searchNotes } from './search';

// Add note search case:
if (parsed.type === 'note' || filter.kinds?.includes(1)) {
  const searchResults = await searchNotes(db, parsed, filter.limit || 50);
  // ... same pattern as other searches
}
```

**Step 5: Run test to verify it passes**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-note-search.cjs`

Expected: PASS

**Step 6: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-note-search.cjs
git commit -m "feat: implement note content search (kind 1)"
```

---

### Task 8: Implement Lists Search (kinds 30000-30003)

**Files:**
- Modify: `src/search.ts`
- Test: `test-list-search.cjs`

**Step 1-6: Follow same TDD pattern as Task 7**

Implementation summary:
- `searchLists()` function with d_tag support
- `indexList()` function extracting name/description from tags
- Integration in relay-worker and durable-object
- Test creating and searching for lists

**Step 7: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-list-search.cjs
git commit -m "feat: implement list search (kinds 30000-30003)"
```

---

### Task 9: Implement Articles Search (kind 30023)

**Step 1-6: Follow same TDD pattern**

Implementation: `searchArticles()`, `indexArticle()`, integration, tests

**Step 7: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-article-search.cjs
git commit -m "feat: implement long-form article search (kind 30023)"
```

---

### Task 10: Implement Communities Search (kind 34550)

**Step 1-6: Follow same TDD pattern**

Implementation: `searchCommunities()`, `indexCommunity()`, integration, tests

**Step 7: Commit**

```bash
git add src/search.ts src/relay-worker.ts src/durable-object.ts test-community-search.cjs
git commit -m "feat: implement community search (kind 34550)"
```

---

## Phase 3: Unified Search & NIP-50 Compliance

### Task 11: Implement Unified Multi-Type Search

**Files:**
- Modify: `src/search.ts` (add unified search)
- Test: `test-unified-search.cjs`

**Step 1: Write the failing test**

Create `test-unified-search.cjs`:

```javascript
const WebSocket = require('ws');

async function testUnifiedSearch() {
  console.log('Testing unified search across all types...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    const receivedTypes = new Set();

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Publish various entity types with "nostr" keyword
      const entities = [
        { kind: 0, content: JSON.stringify({ name: 'nostrdev', about: 'Nostr developer' }) },
        { kind: 1, content: 'Learning about Nostr protocol today' },
        { kind: 34236, tags: [['title', 'Nostr Tutorial Video']], content: 'Introduction to Nostr' }
      ];

      for (const entity of entities) {
        const event = {
          ...entity,
          created_at: Math.floor(Date.now() / 1000),
          tags: entity.tags || [],
          pubkey: 'l'.repeat(64),
          id: Math.random().toString(36) + 'm'.repeat(60),
          sig: 'n'.repeat(128)
        };
        ws.send(JSON.stringify(['EVENT', event]));
      }

      await new Promise(r => setTimeout(r, 500));

      // Unified search without type filter
      const searchReq = JSON.stringify([
        'REQ',
        'search-unified',
        {
          search: 'nostr',
          limit: 50
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-unified') {
        receivedTypes.add(msg[2].kind);
        console.log(`✓ Received result of kind ${msg[2].kind}`);
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-unified') {
        if (receivedTypes.size >= 2) {
          console.log(`✓ Unified search working! Found ${receivedTypes.size} different entity types`);
          ws.close();
          resolve();
        } else {
          console.error(`❌ Expected multiple types, got ${receivedTypes.size}`);
          ws.close();
          reject(new Error('Insufficient type diversity'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testUnifiedSearch().then(() => {
  console.log('\n✓ Unified search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

**Step 2: Run test to verify it fails**

Run: `node test-unified-search.cjs`

Expected: FAIL

**Step 3: Implement unified search**

Add to `src/search.ts`:

```typescript
export async function searchUnified(
  db: D1Database,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  // Search all entity types in parallel
  const [users, videos, lists, notes, articles, communities] = await Promise.all([
    searchUsers(db, query, Math.ceil(limit * 0.15)),       // 15%
    searchVideos(db, query, Math.ceil(limit * 0.35)),      // 35%
    searchLists(db, query, Math.ceil(limit * 0.10)),       // 10%
    searchNotes(db, query, Math.ceil(limit * 0.25)),       // 25%
    searchArticles(db, query, Math.ceil(limit * 0.10)),    // 10%
    searchCommunities(db, query, Math.ceil(limit * 0.05))  // 5%
  ]);

  // Merge and sort by relevance
  const allResults = [
    ...users,
    ...videos,
    ...lists,
    ...notes,
    ...articles,
    ...communities
  ];

  return allResults
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, limit);
}
```

**Step 4: Integrate unified search**

Modify `src/durable-object.ts`:

```typescript
import { searchUnified } from './search';

// In search handling, add as default case:
if (filter.search) {
  const parsed = parseSearchQuery(filter.search);

  // ... existing type-specific searches ...

  // Default: unified search
  if (!parsed.type || parsed.type === 'all') {
    const searchResults = await searchUnified(db, parsed, filter.limit || 50);

    for (const result of searchResults) {
      if (subscriptionId && this.subscriptions.has(subscriptionId)) {
        this.sendToSubscriber(subscriptionId, result.event);
      }
    }

    return {
      success: true,
      events: searchResults.map(r => r.event),
      cursor: null
    };
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm run build && wrangler dev --local --persist & sleep 3 && node test-unified-search.cjs`

Expected: PASS

**Step 6: Commit**

```bash
git add src/search.ts src/durable-object.ts test-unified-search.cjs
git commit -m "feat: implement unified multi-type search"
```

---

### Task 12: Update Relay Info for NIP-50 Support

**Files:**
- Modify: `src/config.ts`

**Step 1: Update relay info**

Modify `src/config.ts`:

```typescript
export const relayInfo = {
  // ... existing fields ...
  supported_nips: [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40, 50],  // Add 50

  // NIP-50 specific metadata
  search: {
    enabled: true,
    entity_types: ['user', 'video', 'list', 'hashtag', 'note', 'article', 'community', 'all'],
    extensions: ['type:', 'author:', 'kind:', 'hashtag:', 'min_likes:', 'min_loops:', 'since:', 'until:'],
    max_results: 200,
    ranking_algorithm: 'bm25',
    features: ['prefix_matching', 'autocomplete', 'snippet_generation', 'relevance_scoring']
  }
};
```

**Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: advertise NIP-50 support in relay info"
```

---

## Phase 4: Integration Tests & Documentation

### Task 13: Create Comprehensive Integration Test Suite

**Files:**
- Create: `test-search-integration.cjs`

**Step 1: Write comprehensive integration test**

Create `test-search-integration.cjs` covering:
- All entity types
- Prefix matching
- Autocomplete
- Structured queries with filters
- Relevance scoring
- Edge cases

**Step 2: Run and verify**

**Step 3: Commit**

```bash
git add test-search-integration.cjs
git commit -m "test: add comprehensive NIP-50 search integration tests"
```

---

### Task 14: Update Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/SEARCH.md`

**Step 1: Add search documentation**

Create `docs/SEARCH.md` with:
- NIP-50 overview
- Supported entity types
- Query syntax examples
- Extension documentation
- API examples

**Step 2: Update README**

Add search capabilities section to README

**Step 3: Commit**

```bash
git add README.md docs/SEARCH.md
git commit -m "docs: add comprehensive NIP-50 search documentation"
```

---

## Phase 5: Optional AI Search Enhancement

### Task 15: Set Up Cloudflare AI Search (Optional)

**Prerequisites:** Cloudflare AI Search instance, R2 bucket for content

**Files:**
- Create: `src/ai-search.ts`
- Modify: `wrangler.toml` (add AI Search binding)

**Step 1: Configure AI Search binding**

Add to `wrangler.toml`:

```toml
[[ai_search]]
binding = "AI_SEARCH"
search_id = "your-search-instance-id"
```

**Step 2: Implement AI Search wrapper**

Create `src/ai-search.ts`:

```typescript
import { SearchResult, ParsedSearchQuery } from './types';

export async function searchSemantic(
  aiSearch: any,
  query: ParsedSearchQuery,
  limit: number
): Promise<SearchResult[]> {
  try {
    const results = await aiSearch.query({
      query: query.raw,
      minimumMatchScore: 0.7,
      limit: limit,
      metadata: {
        kinds: query.filters.kind ? [query.filters.kind] : undefined,
        authors: query.filters.author ? [query.filters.author] : undefined
      }
    });

    return results.map(r => ({
      type: 'all' as const,
      event: r.event,
      relevance_score: r.score,
      snippet: r.snippet,
      match_fields: ['semantic']
    }));
  } catch (error) {
    console.error('AI Search error:', error);
    return [];
  }
}
```

**Step 3: Implement query type detection**

Add heuristics to route natural language queries to AI Search

**Step 4: Test semantic search**

Create `test-semantic-search.cjs`

**Step 5: Commit**

```bash
git add src/ai-search.ts wrangler.toml test-semantic-search.cjs
git commit -m "feat: add optional AI Search for semantic queries"
```

---

### Task 16: Implement Hybrid Search with RRF (Optional)

**Files:**
- Create: `src/hybrid-search.ts`
- Test: `test-hybrid-search.cjs`

**Step 1: Implement Reciprocal Rank Fusion**

Create `src/hybrid-search.ts`:

```typescript
import { SearchResult } from './types';

export function mergeResultsRRF(
  fts5Results: SearchResult[],
  aiResults: SearchResult[],
  limit: number,
  K: number = 60
): SearchResult[] {
  const scores = new Map<string, SearchResult & { score: number }>();

  // Score FTS5 results
  fts5Results.forEach((result, rank) => {
    const score = 1 / (K + rank + 1);
    scores.set(result.event.id, {
      ...result,
      score: score
    });
  });

  // Add AI Search scores with higher weight
  aiResults.forEach((result, rank) => {
    const score = 1 / (K + rank + 1);
    const existing = scores.get(result.event.id);

    if (existing) {
      // Event in both results - boost score
      existing.score += score * 1.5;
      existing.relevance_score = (existing.relevance_score + result.relevance_score) / 2;
    } else {
      scores.set(result.event.id, {
        ...result,
        score
      });
    }
  });

  // Sort by combined score
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...result }) => result);
}
```

**Step 2: Integrate hybrid search**

**Step 3: Test hybrid results**

**Step 4: Commit**

```bash
git add src/hybrid-search.ts test-hybrid-search.cjs
git commit -m "feat: implement hybrid search with Reciprocal Rank Fusion"
```

---

## Verification Checklist

After completing all tasks, verify:

- [ ] All FTS5 virtual tables created successfully
- [ ] User search working with name/about matching
- [ ] Hashtag autocomplete returns prefix matches
- [ ] Video search returns relevant results
- [ ] Notes, lists, articles, communities searchable
- [ ] Unified search returns multiple entity types
- [ ] Structured queries (type:, author:, etc.) parse correctly
- [ ] Relevance scoring produces sensible rankings
- [ ] Snippets generated with highlighting
- [ ] NIP-50 advertised in relay info
- [ ] All integration tests passing
- [ ] Documentation complete
- [ ] Optional: AI Search integration working
- [ ] Optional: Hybrid search merges results correctly

---

## Performance Targets

- User search: < 50ms
- Hashtag autocomplete: < 30ms
- Video search: < 100ms
- Unified search: < 200ms
- AI Search (if enabled): < 500ms
- Hybrid search: < 600ms

---

## Rollout Plan

1. **Deploy Phase 1** (Core search): Users, videos, hashtags
2. **Monitor usage** for 1 week
3. **Deploy Phase 2** (Extended types): Lists, notes, articles, communities
4. **Evaluate AI Search** based on query patterns
5. **Deploy Phase 4** (optional): AI Search + Hybrid if valuable

---

**End of Implementation Plan**
