# Flutter Client Integration Guide
## Divine Video Relay - Sorted Video Queries

### Overview
The Divine Video relay (relay.divine.video) supports custom vendor extensions for discovering and sorting videos by engagement metrics.

### Relay Information
- **URL**: `wss://relay.divine.video`
- **Video Event Kind**: `34236` (vertical video)
- **Supported Metrics**: `loop_count`, `likes`, `views`, `comments`, `avg_completion`

---

## Basic Query Structure

All queries follow standard Nostr REQ format with added vendor extensions:

```dart
['REQ', subscriptionId, {
  'kinds': [34236],
  'sort': {
    'field': 'loop_count',  // or 'likes', 'views', 'comments', 'avg_completion', 'created_at'
    'dir': 'desc'           // or 'asc'
  },
  'limit': 20
}]
```

---

## Common Query Examples

### 1. Most Looped Videos (Trending)
Get videos with the most loops (plays):

```dart
final filter = {
  'kinds': [34236],
  'sort': {
    'field': 'loop_count',
    'dir': 'desc'
  },
  'limit': 50
};

relay.send(['REQ', 'trending', filter]);
```

### 2. Most Liked Videos
Get videos sorted by number of likes:

```dart
final filter = {
  'kinds': [34236],
  'sort': {
    'field': 'likes',
    'dir': 'desc'
  },
  'limit': 50
};

relay.send(['REQ', 'most-liked', filter]);
```

### 3. Most Viewed Videos
Get videos sorted by view count:

```dart
final filter = {
  'kinds': [34236],
  'sort': {
    'field': 'views',
    'dir': 'desc'
  },
  'limit': 50
};

relay.send(['REQ', 'most-viewed', filter]);
```

### 4. Newest Videos First
Get most recently published videos:

```dart
final filter = {
  'kinds': [34236],
  'sort': {
    'field': 'created_at',
    'dir': 'desc'
  },
  'limit': 50
};

relay.send(['REQ', 'newest', filter]);
```

---

## Filtering by Engagement Metrics

Use `int#<metric>` filters to set thresholds:

### 5. Popular Videos (minimum threshold)
Get videos with at least 100 likes:

```dart
final filter = {
  'kinds': [34236],
  'int#likes': {'gte': 100},  // Greater than or equal to 100
  'sort': {
    'field': 'loop_count',
    'dir': 'desc'
  },
  'limit': 20
};

relay.send(['REQ', 'popular', filter]);
```

### 6. Range Queries
Get videos with 10-100 likes:

```dart
final filter = {
  'kinds': [34236],
  'int#likes': {
    'gte': 10,   // Greater than or equal to 10
    'lte': 100   // Less than or equal to 100
  },
  'sort': {
    'field': 'created_at',
    'dir': 'desc'
  },
  'limit': 50
};

relay.send(['REQ', 'moderate-engagement', filter]);
```

### 7. Highly Engaged Videos
Combine multiple metric filters:

```dart
final filter = {
  'kinds': [34236],
  'int#likes': {'gte': 50},
  'int#loop_count': {'gte': 1000},
  'sort': {
    'field': 'likes',
    'dir': 'desc'
  },
  'limit': 20
};

relay.send(['REQ', 'highly-engaged', filter]);
```

---

## Hashtag Filtering

### 8. Videos by Hashtag
Get videos tagged with specific hashtags:

```dart
final filter = {
  'kinds': [34236],
  '#t': ['music'],  // Videos tagged with #music
  'sort': {
    'field': 'likes',
    'dir': 'desc'
  },
  'limit': 20
};

relay.send(['REQ', 'music-videos', filter]);
```

### 9. Multiple Hashtags (OR logic)
```dart
final filter = {
  'kinds': [34236],
  '#t': ['music', 'dance', 'comedy'],  // Videos with ANY of these tags
  'sort': {
    'field': 'loop_count',
    'dir': 'desc'
  },
  'limit': 50
};

relay.send(['REQ', 'entertainment', filter]);
```

---

## Author Queries

### 10. Videos by Specific Author
```dart
final filter = {
  'kinds': [34236],
  'authors': ['pubkey_hex_here'],
  'sort': {
    'field': 'created_at',
    'dir': 'desc'
  },
  'limit': 20
};

relay.send(['REQ', 'author-videos', filter]);
```

### 11. Top Videos by Author
```dart
final filter = {
  'kinds': [34236],
  'authors': ['pubkey_hex_here'],
  'sort': {
    'field': 'loop_count',
    'dir': 'desc'
  },
  'limit': 10
};

relay.send(['REQ', 'author-top-videos', filter]);
```

---

## Pagination

### 12. Using Cursors for Infinite Scroll
The relay returns a cursor in the EOSE message for pagination:

```dart
// Initial query
relay.send(['REQ', 'feed', {
  'kinds': [34236],
  'sort': {'field': 'loop_count', 'dir': 'desc'},
  'limit': 20
}]);

// Listen for EOSE with cursor
relay.on('message', (message) {
  if (message[0] == 'EOSE') {
    final subscriptionId = message[1];
    final cursor = message.length > 2 ? message[2] : null;

    // Store cursor for next page
    if (cursor != null) {
      // Next page query
      relay.send(['REQ', 'feed-page-2', {
        'kinds': [34236],
        'sort': {'field': 'loop_count', 'dir': 'desc'},
        'limit': 20,
        'cursor': cursor  // Include cursor from previous EOSE
      }]);
    }
  }
});
```

---

## Available Metrics

| Metric | Description | Tag Name |
|--------|-------------|----------|
| `loop_count` | Number of times video was looped/replayed | `loops` |
| `likes` | Number of likes | `likes` |
| `views` | Number of views | `views` |
| `comments` | Number of comments | `comments` |
| `avg_completion` | Average completion rate (0-100) | Not in tags yet |
| `created_at` | Unix timestamp of publication | Event's `created_at` |

---

## Reading Metrics from Events

When you receive an EVENT, metrics are in the tags array:

```dart
void handleEvent(dynamic event) {
  final tags = event['tags'] as List;

  // Extract metrics
  final loops = _getTagValue(tags, 'loops');
  final likes = _getTagValue(tags, 'likes');
  final views = _getTagValue(tags, 'views');
  final comments = _getTagValue(tags, 'comments');
  final vineId = _getTagValue(tags, 'd');  // Original Vine ID

  print('Video $vineId: $loops loops, $likes likes');
}

int _getTagValue(List tags, String tagName) {
  final tag = tags.firstWhere(
    (t) => t is List && t.isNotEmpty && t[0] == tagName,
    orElse: () => null,
  );
  return tag != null && tag.length > 1 ? int.tryParse(tag[1]) ?? 0 : 0;
}
```

---

## Feed Recommendations

### For You Feed
```dart
// Trending content (most looped in last 24h)
final filter = {
  'kinds': [34236],
  'since': DateTime.now().subtract(Duration(days: 1)).millisecondsSinceEpoch ~/ 1000,
  'sort': {'field': 'loop_count', 'dir': 'desc'},
  'limit': 50
};
```

### Discover Feed
```dart
// High engagement, diverse content
final filter = {
  'kinds': [34236],
  'int#likes': {'gte': 20},
  'int#loop_count': {'gte': 500},
  'sort': {'field': 'created_at', 'dir': 'desc'},
  'limit': 100
};
```

### Trending Feed
```dart
// Pure virality - most loops
final filter = {
  'kinds': [34236],
  'sort': {'field': 'loop_count', 'dir': 'desc'},
  'limit': 50
};
```

---

## Rate Limits

- **Maximum limit per query**: 200 events
- **Query rate**: Up to 50 REQ messages per minute per connection
- **Publish rate**: Up to 10 EVENT messages per minute per pubkey

---

## Error Handling

The relay will send a CLOSED message if a query is invalid:

```dart
relay.on('message', (message) {
  if (message[0] == 'CLOSED') {
    final subscriptionId = message[1];
    final reason = message[2];
    print('Subscription $subscriptionId closed: $reason');

    // Common reasons:
    // - 'invalid: unsupported sort field'
    // - 'invalid: limit exceeds maximum (200)'
    // - 'blocked: kinds [...] not allowed'
  }
});
```

---

## Testing

You can test queries using websocat or wscat:

```bash
# Connect to relay
wscat -c wss://relay.divine.video

# Send query
["REQ", "test", {"kinds": [34236], "sort": {"field": "loop_count", "dir": "desc"}, "limit": 5}]
```

---

## NIP-11 Relay Information (Discovery)

### How to Check if a Relay Supports Video Discovery

Before using vendor extensions, check the relay's NIP-11 document:

```dart
import 'package:http/http.dart' as http;
import 'dart:convert';

Future<Map<String, dynamic>?> getRelayCapabilities(String relayUrl) async {
  try {
    // Convert wss:// to https://
    final httpUrl = relayUrl.replaceFirst('wss://', 'https://').replaceFirst('ws://', 'http://');

    final response = await http.get(
      Uri.parse(httpUrl),
      headers: {'Accept': 'application/nostr+json'},
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    }
  } catch (e) {
    print('Error fetching relay info: $e');
  }
  return null;
}

// Usage
final relayInfo = await getRelayCapabilities('wss://relay.divine.video');

if (relayInfo != null && relayInfo.containsKey('divine_extensions')) {
  // Relay supports Divine Video extensions!
  final extensions = relayInfo['divine_extensions'];

  print('Supported sort fields: ${extensions['sort_fields']}');
  print('Supported int filters: ${extensions['int_filters']}');
  print('Max limit: ${extensions['limit_max']}');
}
```

### Relay Capability Detection

```dart
class RelayCapabilities {
  final bool supportsVideoDiscovery;
  final List<String> sortFields;
  final List<String> intFilters;
  final int maxLimit;

  RelayCapabilities({
    required this.supportsVideoDiscovery,
    required this.sortFields,
    required this.intFilters,
    required this.maxLimit,
  });

  factory RelayCapabilities.fromRelayInfo(Map<String, dynamic> relayInfo) {
    final extensions = relayInfo['divine_extensions'];

    if (extensions == null) {
      return RelayCapabilities(
        supportsVideoDiscovery: false,
        sortFields: [],
        intFilters: [],
        maxLimit: 100, // Default Nostr limit
      );
    }

    return RelayCapabilities(
      supportsVideoDiscovery: true,
      sortFields: List<String>.from(extensions['sort_fields'] ?? []),
      intFilters: List<String>.from(extensions['int_filters'] ?? []),
      maxLimit: extensions['limit_max'] ?? 100,
    );
  }

  bool canSortBy(String field) => sortFields.contains(field);
  bool canFilterBy(String metric) => intFilters.contains(metric);
}

// Usage
final capabilities = RelayCapabilities.fromRelayInfo(relayInfo);

if (capabilities.supportsVideoDiscovery) {
  if (capabilities.canSortBy('loop_count')) {
    // Build trending feed with sort
  }

  if (capabilities.canFilterBy('likes')) {
    // Build popular videos filter
  }
}
```

### Fallback for Non-Supporting Relays

If a relay doesn't support `divine_extensions`, fall back to standard Nostr queries:

```dart
Map<String, dynamic> buildQuery({
  required RelayCapabilities capabilities,
  String? sortField,
  String? sortDir,
  Map<String, dynamic>? intFilter,
}) {
  final filter = <String, dynamic>{'kinds': [34236]};

  if (capabilities.supportsVideoDiscovery) {
    // Use vendor extensions
    if (sortField != null && capabilities.canSortBy(sortField)) {
      filter['sort'] = {'field': sortField, 'dir': sortDir ?? 'desc'};
    }
    if (intFilter != null) {
      intFilter.forEach((metric, value) {
        if (capabilities.canFilterBy(metric)) {
          filter['int#$metric'] = value;
        }
      });
    }
  } else {
    // Fallback: just sort by created_at (standard Nostr)
    // Client-side sorting/filtering would be needed
    filter['limit'] = 100;
  }

  return filter;
}
```

### Example NIP-11 Response

```bash
curl -H "Accept: application/nostr+json" https://relay.divine.video
```

Returns:

```json
{
  "name": "Divine Video Relay",
  "description": "A specialized Nostr relay for Divine Video's 6-second short-form videos",
  "supported_nips": [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40],
  "divine_extensions": {
    "int_filters": ["loop_count", "likes", "views", "comments", "avg_completion"],
    "sort_fields": ["loop_count", "likes", "views", "comments", "avg_completion", "created_at"],
    "cursor_format": "base64url-encoded HMAC-SHA256 with query hash binding",
    "videos_kind": 34236,
    "metrics_freshness_sec": 3600,
    "limit_max": 200
  }
}
```

### What Each Field Means

- **`int_filters`**: Metrics you can use with `int#<metric>` filters (e.g., `int#likes`)
- **`sort_fields`**: Fields you can use in the `sort` parameter
- **`cursor_format`**: How pagination cursors are generated (for security)
- **`videos_kind`**: The Nostr event kind for videos (34236)
- **`metrics_freshness_sec`**: How often metrics are updated (hourly = 3600 seconds)
- **`limit_max`**: Maximum events you can request in a single query (200)

---

## Support

For questions or issues:
- GitHub: https://github.com/rabble/nosflare
- Relay Maintainer: relay@divine.video
