# NIP-50 Search Documentation

Nosflare implements comprehensive full-text search capabilities following [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md) with custom extensions for enhanced entity-specific search.

## Overview

The search system uses SQLite's FTS5 (Full-Text Search 5) engine with BM25 relevance ranking to provide fast, accurate search across multiple Nostr event types. All searches support prefix matching, snippet generation with highlighted matches, and relevance-based scoring.

## Supported Entity Types

Nosflare supports search across 7 different entity types:

| Entity Type | Nostr Kind(s) | Search Fields | Special Features |
|-------------|---------------|---------------|------------------|
| **Users** | 0 (profiles) | name, display_name, about, nip05 | Profile metadata search |
| **Notes** | 1 (short-form) | content | Full-text content search |
| **Videos** | 34236 | title, summary, content | Engagement boosting (likes, loops) |
| **Lists** | 30000-30003 | name, description | List metadata search |
| **Articles** | 30023 (long-form) | title, summary, content | Long-form content search |
| **Communities** | 34550 | name, description | Community metadata search |
| **Hashtags** | All kinds | hashtag values | Prefix matching, autocomplete, trending |

## Query Syntax

### Basic Search

Simple text search across default fields:

```json
{
  "kinds": [1],
  "search": "bitcoin privacy"
}
```

This searches for notes containing "bitcoin" OR "privacy" (prefix matching enabled).

### Structured Queries

Use filters to narrow search results:

#### Entity Type Filter

```json
{
  "search": "type:video freedom tech"
}
```

Supported types: `user`, `video`, `list`, `hashtag`, `note`, `article`, `community`, `all`

#### Author Filter

```json
{
  "search": "author:npub1... decentralization"
}
```

Search only events from a specific author.

#### Hashtag Filter

```json
{
  "search": "#bitcoin #lightning"
}
```

Find events tagged with specific hashtags.

#### Engagement Filters (Videos)

```json
{
  "search": "min_likes:100 documentary"
}
```

```json
{
  "search": "min_loops:1000 tutorial"
}
```

Filter videos by minimum engagement metrics.

#### Time Range Filters

```json
{
  "search": "since:1704067200 bitcoin"
}
```

```json
{
  "search": "until:1704153600 announcement"
}
```

Use Unix timestamps to filter by time range.

#### Kind Filter

```json
{
  "search": "kind:30023 long-form content"
}
```

Search specific event kinds (can also use standard `kinds` array).

### Combined Filters

Combine multiple filters for precise searches:

```json
{
  "search": "type:video #bitcoin min_likes:50 since:1704067200"
}
```

## Search Response Format

Each search result includes:

```typescript
{
  type: 'user' | 'video' | 'list' | 'hashtag' | 'note' | 'article' | 'community',
  event: NostrEvent,           // Full Nostr event
  relevance_score: number,     // BM25 score (higher = more relevant)
  snippet?: string,            // Highlighted excerpt with <mark> tags
  match_fields: string[]       // Which fields matched the query
}
```

### Hashtag Search Response

Hashtag searches return aggregated results with trending information:

```typescript
{
  type: 'hashtag',
  hashtag: string,
  total_usage: number,         // Total times hashtag was used
  unique_authors: number,      // Number of unique authors using it
  recent_usage: number,        // Usage in last 24 hours
  first_seen: number,          // Unix timestamp of first usage
  last_seen: number,           // Unix timestamp of most recent usage
  trending_score: number,      // Trending algorithm score
  sample_events: NostrEvent[]  // Recent events with this hashtag
}
```

## Entity-Specific Search Examples

### User Profile Search

Search for users by name, display name, about text, or NIP-05 address:

```json
{
  "kinds": [0],
  "search": "bitcoin developer",
  "limit": 20
}
```

**Matches:**
- Users with "bitcoin" or "developer" in their name
- Users with those terms in their about/bio
- NIP-05 addresses containing those terms

### Video Search

Search video content with engagement boosting:

```json
{
  "kinds": [34236],
  "search": "tutorial #nostr min_likes:10",
  "limit": 50
}
```

**Relevance Scoring:**
Videos are ranked using: `BM25_score × (1 + log(loop_count + 1) × 0.1) × (1 + log(likes + 1) × 0.05)`

This ensures popular, engaging videos rank higher while still respecting text relevance.

### Note Search

Full-text search across short-form notes:

```json
{
  "kinds": [1],
  "search": "decentralization freedom",
  "limit": 100
}
```

### List Search

Find curated lists by name or description:

```json
{
  "kinds": [30000, 30001, 30002, 30003],
  "search": "bitcoin podcasts",
  "limit": 20
}
```

### Article Search

Search long-form content:

```json
{
  "kinds": [30023],
  "search": "cryptography privacy since:1704067200",
  "limit": 25
}
```

### Community Search

Find communities by name or description:

```json
{
  "kinds": [34550],
  "search": "bitcoin developers",
  "limit": 30
}
```

### Hashtag Autocomplete

Prefix matching for hashtag suggestions:

```json
{
  "search": "hashtag:bitc"
}
```

Returns hashtags starting with "bitc" (bitcoin, bitcoiner, etc.), sorted by trending score.

## Unified Multi-Type Search

Search across all entity types simultaneously:

```json
{
  "search": "nostr protocol"
}
```

When no `kinds` filter or `type:` prefix is specified, the relay searches all entity types in parallel and merges results by relevance score.

**Default distribution** (adjustable):
- Videos: 35%
- Notes: 25%
- Users: 15%
- Lists: 10%
- Articles: 10%
- Communities: 5%

Results are merged and sorted by relevance score, then truncated to the specified limit.

## Custom Extensions

Nosflare extends NIP-50 with additional capabilities advertised in relay info:

### `search_types` Filter Extension

```json
{
  "search": "bitcoin",
  "search_types": ["video", "article"]
}
```

Explicitly specify which entity types to search (alternative to `type:` in query string).

## Performance Characteristics

### Indexing

- **Automatic**: All events are automatically indexed when stored
- **FTS5 Tables**: Separate virtual tables for each entity type
- **Tokenization**: Porter stemming for natural language, trigram for hashtags
- **Updates**: Uses DELETE+INSERT pattern (FTS5 doesn't support UPSERT)

### Query Performance

- **BM25 Ranking**: Built-in probabilistic ranking algorithm
- **Prefix Matching**: All text terms support prefix matching (`term*`)
- **Snippet Generation**: Highlighted excerpts with configurable length
- **Parallel Search**: Multi-type searches run concurrently
- **Engagement Boosting**: Logarithmic scaling prevents domination by viral content

### Limitations

- **Max Results**: 200 results per query (configurable)
- **Snippet Length**: 32 tokens per snippet (configurable)
- **Prefix Only**: Suffix/infix matching not supported (use prefix matching)

## Technical Implementation

### FTS5 Virtual Tables

Each entity type has a dedicated FTS5 virtual table:

```sql
CREATE VIRTUAL TABLE users_fts USING fts5(
  event_id UNINDEXED,
  pubkey UNINDEXED,
  name,
  display_name,
  about,
  nip05,
  tokenize='porter unicode61 remove_diacritics 1'
);
```

### Relevance Scoring

Base BM25 score with optional engagement boosting:

```typescript
// Video example with engagement boosting
const score = bm25_rank *
  (1 + Math.log(loop_count + 1) * 0.1) *
  (1 + Math.log(likes + 1) * 0.05);
```

### Hashtag Trending Algorithm

```typescript
const trending_score = total_usage / (days_since_first_seen + 1);
```

Recent hashtags with high usage rank higher than old hashtags with similar usage.

## Migration

Search functionality requires migration 7, which creates all FTS5 tables. This migration runs automatically on first relay startup after deploying the updated code.

**Migration includes:**
- 7 FTS5 virtual tables (one per entity type)
- 1 hashtag statistics table
- Automatic indexing triggers (handled in application code)

## Relay Info Advertisement

The relay advertises NIP-50 support and extensions in relay info:

```json
{
  "supported_nips": [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40, 50],
  "search": {
    "enabled": true,
    "entity_types": ["user", "video", "list", "hashtag", "note", "article", "community", "all"],
    "extensions": ["type:", "author:", "kind:", "hashtag:", "min_likes:", "min_loops:", "since:", "until:"],
    "max_results": 200,
    "ranking_algorithm": "bm25",
    "features": ["prefix_matching", "autocomplete", "snippet_generation", "relevance_scoring"]
  }
}
```

## Best Practices

### For Client Developers

1. **Use Prefix Matching**: Queries automatically append `*` to terms for autocomplete-style matching
2. **Check Relevance Scores**: Higher scores indicate better matches
3. **Parse Snippets**: Snippets contain `<mark>` tags highlighting matched terms
4. **Combine Filters**: Use structured queries for precise results
5. **Limit Results**: Request only what you need to reduce latency

### For Relay Operators

1. **Monitor Index Size**: FTS5 tables grow with event volume
2. **Tune Engagement Weights**: Adjust logarithmic coefficients for your community
3. **Configure Max Results**: Balance between completeness and performance
4. **Test Migration**: Verify migration 7 completes successfully
5. **Archive Strategy**: Consider archiving old events to R2 (search won't include archived events)

## Troubleshooting

### No Results Returned

- Verify migration 7 completed successfully
- Check that events are being indexed (look for FTS5 INSERT operations)
- Ensure search terms are meaningful (single-letter searches may not match)
- Try simpler queries without filters

### Slow Queries

- Reduce result limit
- Use more specific filters (kinds, time ranges, authors)
- Check D1 database performance metrics
- Consider upgrading Cloudflare plan for better performance

### Missing Recent Events

- FTS5 indexing happens during event storage
- Check relay worker logs for indexing errors
- Verify D1 session mode is correctly configured

## API Examples

### WebSocket Query (Nostr Protocol)

```javascript
// Search for videos about bitcoin
ws.send(JSON.stringify([
  "REQ",
  "search-sub-1",
  {
    "kinds": [34236],
    "search": "bitcoin tutorial min_likes:10",
    "limit": 20
  }
]));
```

### Using nostr-tools

```javascript
import { relayInit } from 'nostr-tools';

const relay = relayInit('wss://relay.nosflare.com');
await relay.connect();

const sub = relay.sub([
  {
    kinds: [1],
    search: 'decentralization #bitcoin',
    limit: 50
  }
]);

sub.on('event', event => {
  console.log('Search result:', event);
});

sub.on('eose', () => {
  console.log('End of search results');
});
```

### Hashtag Autocomplete

```javascript
// Search for hashtags starting with "bitc"
const sub = relay.sub([
  {
    search: 'hashtag:bitc'
  }
]);

sub.on('event', event => {
  // Returns hashtag metadata with trending scores
  console.log('Hashtag suggestion:', event);
});
```

## Future Enhancements

Potential future improvements to search functionality:

- **Semantic Search**: Integration with Cloudflare AI Search for meaning-based queries
- **Fuzzy Matching**: Handle typos and misspellings
- **Phrase Matching**: Exact phrase search with quotes
- **Boolean Operators**: Explicit AND/OR/NOT operators
- **Field-Specific Search**: Target specific fields (e.g., `name:alice`)
- **Faceted Search**: Aggregate results by category
- **Search Analytics**: Track popular queries and zero-result searches

## Resources

- [NIP-50 Specification](https://github.com/nostr-protocol/nips/blob/master/50.md)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [BM25 Algorithm](https://en.wikipedia.org/wiki/Okapi_BM25)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Nosflare Repository](https://github.com/sandwichfarm/nosflare)
