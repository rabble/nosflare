# Video Discovery Testing Guide

## Quick Smoke Test

```bash
# Test vendor extensions are working
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://nosflare.protestnet.workers.dev');

ws.on('open', () => {
  ws.send(JSON.stringify(['REQ', 'test', {
    kinds: [34236],
    sort: { field: 'loop_count', dir: 'desc' },
    limit: 5
  }]));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 'EVENT') {
    const loops = msg[2].tags.find(t => t[0] === 'loops')?.[1];
    console.log(\`Event: \${msg[2].id.substring(0,8)} loops=\${loops}\`);
  } else if (msg[0] === 'EOSE') {
    console.log('✓ Test complete');
    ws.close();
  }
});

setTimeout(() => process.exit(0), 3000);
"
```

## Check NIP-11 Vendor Extensions

```bash
curl -H "Accept: application/nostr+json" https://nosflare.protestnet.workers.dev | jq '.divine_extensions'
```

Expected response:
```json
{
  "int_filters": ["loop_count", "likes", "views", "comments", "avg_completion"],
  "sort_fields": ["loop_count", "likes", "views", "comments", "avg_completion", "created_at"],
  "cursor_format": "base64url-encoded HMAC-SHA256 with query hash binding",
  "videos_kind": 34236,
  "metrics_freshness_sec": 3600,
  "limit_max": 200
}
```

## Query Examples

### Top videos by loops
```json
["REQ", "top-loops", {
  "kinds": [34236],
  "sort": { "field": "loop_count", "dir": "desc" },
  "limit": 50
}]
```

### Popular videos (with threshold)
```json
["REQ", "popular", {
  "kinds": [34236],
  "int#likes": { "gte": 100 },
  "sort": { "field": "loop_count", "dir": "desc" },
  "limit": 20
}]
```

### Videos by hashtag
```json
["REQ", "music", {
  "kinds": [34236],
  "#t": ["music"],
  "sort": { "field": "likes", "dir": "desc" },
  "limit": 20
}]
```

### Range query
```json
["REQ", "moderate", {
  "kinds": [34236],
  "int#likes": { "gte": 10, "lte": 100 },
  "sort": { "field": "loop_count", "dir": "desc" },
  "limit": 50
}]
```

## Check Database State

```bash
# Check videos table
curl -s https://check-videos.protestnet.workers.dev | jq

# Expected output:
# {
#   "count": <number>,
#   "stats": { "total": <number>, "has_loops": <number>, ... },
#   "sample": [ ... top 10 videos by loop_count ... ]
# }
```

## Integration Tests Passed

✅ Sort order correctness (DESC/ASC)
✅ Multiple sort fields (loop_count, likes, views)  
✅ int# filters with sorting
✅ Auto-population on event insert
✅ HMAC-authenticated cursors
✅ Query hash binding prevents cursor reuse

## Test Results (Last Run)

With 2 events:
- ✓ loop_count DESC: [3992, 2478] - correct descending
- ✓ loop_count ASC: [2478, 3992] - correct ascending
- ✓ likes DESC: [51, 15] - correct descending
- ✓ int# filter + sort: working correctly

All vendor extension features verified working.
