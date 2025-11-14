# Nosflare Metrics with Cloudflare Analytics Engine

Nosflare uses **Cloudflare Analytics Engine** to track comprehensive Nostr-specific metrics for observability and performance monitoring.

## What Metrics Are Tracked

### 1. Client Messages (Incoming)
Tracks all Nostr client message types:
- `EVENT` - Event submissions
- `REQ` - Subscription requests
- `CLOSE` - Subscription closures
- `AUTH` - Authentication messages
- `COUNT` - Count requests

**Index**: `client_message`  
**Blobs**: `[message_type]`  
**Doubles**: `[1]` (count)

### 2. Relay Messages (Outgoing)
Tracks all Nostr relay response types:
- `OK` - Event acceptance/rejection responses
- `EVENT` - Events sent to clients
- `EOSE` - End of stored events
- `CLOSED` - Subscription closed notifications
- `NOTICE` - Error/info notices

**Index**: `relay_message`  
**Blobs**: `[message_type]`  
**Doubles**: `[1]` (count)

### 3. Event Kinds
Tracks event submissions by kind with acceptance status:
- Kind numbers (0, 1, 3, 30023, 34236, etc.)
- Accepted vs rejected status
- Rejection reasons

**Index**: `event_kind`  
**Blobs**: `[accepted|rejected, rejection_reason]`  
**Doubles**: `[kind_number, 1]`

**Rejection Reasons**:
- `invalid_signature` - Signature verification failed
- `payment_required` - Pay-to-relay not satisfied
- `pubkey_blocked` - Author pubkey blocked
- `kind_blocked` - Event kind not allowed
- `tag_blocked` - Tag not allowed
- `content_blocked` - Content contains blocked phrases
- `duplicate` - Event already exists
- `spam_detected` - Anti-spam filter triggered
- `nip05_invalid` - NIP-05 validation failed
- `rate_limited` - Rate limit exceeded

### 4. Subscriptions (REQ)
Tracks subscription characteristics:
- Number of filters in request
- Has author filters
- Has kind filters
- Has hashtag filters
- Has search query

**Index**: `subscription`  
**Blobs**: `[has_authors|no_authors, has_kinds|no_kinds, has_hashtags|no_hashtags, has_search|no_search]`  
**Doubles**: `[filter_count, 1]`

### 5. Query Performance
Tracks query execution metrics:
- Latency in milliseconds
- Result count
- Archive usage (D1 + R2 vs D1 only)
- Query type (standard, video, search)

**Index**: `query_performance`  
**Blobs**: `[query_type, with_archive|no_archive]`  
**Doubles**: `[latency_ms, result_count]`

**Query Types**:
- `standard` - Regular Nostr filter queries
- `video` - Video table queries with vendor extensions
- `search` - NIP-50 full-text search

### 6. Search Queries
Tracks search-specific metrics:
- Search type (user, video, note, list, article, community, hashtag, unified)
- Result count
- Latency in milliseconds

**Index**: `search`  
**Blobs**: `[search_type]`  
**Doubles**: `[result_count, latency_ms]`

### 7. Payment Checks
Tracks pay-to-relay payment status checks:
- Paid vs unpaid status
- Cache hit vs database lookup

**Index**: `payment_check`  
**Blobs**: `[paid|unpaid, cached|db_lookup]`  
**Doubles**: `[1]` (count)

### 8. Connections
Tracks WebSocket connection lifecycle:
- Connected
- Disconnected
- Error

**Index**: `connection`  
**Blobs**: `[event_type, region]`  
**Doubles**: `[1]` (count)

### 9. Broadcasts
Tracks Durable Object to Durable Object event broadcasts:
- Source region
- Target region
- Event kind

**Index**: `broadcast`  
**Blobs**: `[source_region, target_region]`  
**Doubles**: `[event_kind, 1]`

### 10. NIP-05 Validation
Tracks NIP-05 address validation:
- Valid vs invalid
- Domain

**Index**: `nip05_validation`  
**Blobs**: `[valid|invalid, domain]`  
**Doubles**: `[1]` (count)

## Querying Metrics

### Via GraphQL API

Cloudflare provides a GraphQL API to query Analytics Engine data:

```bash
curl -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { viewer { accounts(filter: { accountTag: \"YOUR_ACCOUNT_ID\" }) { analyticsEngineDatasets(filter: { datasetName: \"ANALYTICS_ENGINE\" }) { data: dimensions { blob1 blob2 } metrics { count: sum(double1) } } } } }"
  }'
```

### Example Queries

**Get event kind breakdown (last 24 hours)**:
```graphql
query {
  viewer {
    accounts(filter: { accountTag: "YOUR_ACCOUNT_ID" }) {
      analyticsEngineDatasets(
        filter: { 
          datasetName: "ANALYTICS_ENGINE"
          indexTag: "event_kind"
        }
        limit: 100
        orderBy: [sum_double2_DESC]
      ) {
        dimensions {
          blob1  # accepted/rejected
          blob2  # rejection reason
        }
        metrics {
          kind: avg(double1)
          count: sum(double2)
        }
      }
    }
  }
}
```

**Get client message breakdown**:
```graphql
query {
  viewer {
    accounts(filter: { accountTag: "YOUR_ACCOUNT_ID" }) {
      analyticsEngineDatasets(
        filter: { 
          datasetName: "ANALYTICS_ENGINE"
          indexTag: "client_message"
        }
        limit: 100
      ) {
        dimensions {
          blob1  # message type (EVENT, REQ, CLOSE)
        }
        metrics {
          count: sum(double1)
        }
      }
    }
  }
}
```

**Get search performance metrics**:
```graphql
query {
  viewer {
    accounts(filter: { accountTag: "YOUR_ACCOUNT_ID" }) {
      analyticsEngineDatasets(
        filter: { 
          datasetName: "ANALYTICS_ENGINE"
          indexTag: "search"
        }
        limit: 100
      ) {
        dimensions {
          blob1  # search type
        }
        metrics {
          avg_results: avg(double1)
          avg_latency_ms: avg(double2)
          total_searches: count
        }
      }
    }
  }
}
```

## Viewing Metrics in Dashboard

1. Go to **Cloudflare Dashboard** → **Analytics & Logs** → **Workers Analytics**
2. Select your Worker
3. Click **Analytics Engine** tab
4. Query your metrics using the GraphQL explorer

## Exporting to External Systems

### Grafana Cloud

Use the [Cloudflare Analytics Engine data source for Grafana](https://grafana.com/grafana/plugins/cloudflare-analytics-engine-datasource/)

### Prometheus

Create a custom exporter that:
1. Queries Analytics Engine GraphQL API
2. Converts to Prometheus metrics format
3. Exposes `/metrics` endpoint

Example exporter structure:
```typescript
// metrics-exporter.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Query Analytics Engine
    const data = await queryAnalyticsEngine(env);
    
    // Convert to Prometheus format
    const metrics = convertToPrometheus(data);
    
    return new Response(metrics, {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}
```

### Datadog / New Relic / Honeycomb

Use Cloudflare Logpush to stream logs (which include metric data) to these platforms:
1. Go to **Cloudflare Dashboard** → **Analytics & Logs** → **Logs**
2. Click **Add Logpush job**
3. Select destination (Datadog, S3, etc.)
4. Configure filters to include metrics logs

## Cost Analysis

Analytics Engine pricing:
- **$0.25 per million events written**
- **$1.00 per million rows queried**
- First 10 million events/month included free

For a medium-sized relay (1,000 users, 10M events/month):
- ~50M metric events/month = $10/month
- ~1M query rows/month = $1/month
- **Total: ~$11/month** for comprehensive metrics

## Metrics Overhead

Each metric write adds minimal overhead:
- **~0.1ms** per `writeDataPoint()` call
- Async, non-blocking
- No impact on client response times

## Best Practices

1. **Use indexes wisely** - Each unique index creates a separate dataset
2. **Aggregate in queries** - Don't store pre-aggregated data
3. **Use blobs for dimensions** - Store categorical data (message types, regions)
4. **Use doubles for measurements** - Store numeric data (counts, latencies)
5. **Query with time ranges** - Reduce query costs by limiting time windows

## Troubleshooting

### Metrics not appearing

1. Check Analytics Engine binding in `wrangler.toml`:
   ```toml
   [[analytics_engine_datasets]]
   binding = "ANALYTICS_ENGINE"
   ```

2. Verify binding in dashboard:
   - Go to Worker → Settings → Bindings
   - Should see "ANALYTICS_ENGINE" binding

3. Check logs for errors:
   ```bash
   wrangler tail
   ```

### High costs

1. Review metric write frequency
2. Consider sampling high-volume metrics
3. Use console.log for debugging metrics (free, but not queryable)

## Migration from console.log

If you were previously using `console.log()` for metrics:

1. Logs are still written (for debugging)
2. Analytics Engine provides structured, queryable data
3. Both can coexist during transition
4. Query Analytics Engine for dashboards/alerts
5. Use logs for debugging specific issues

## Example Dashboard Queries

Create a monitoring dashboard with these queries:

**Events per minute by kind**:
- Index: `event_kind`
- Group by: `blob1` (accepted/rejected), `double1` (kind)
- Aggregate: `sum(double2)` per minute

**Rejection rate**:
- Index: `event_kind`
- Filter: `blob1 = 'rejected'`
- Aggregate: `count / total_count`

**Search latency p95**:
- Index: `search`
- Aggregate: `percentile(double2, 0.95)`

**Active connections**:
- Index: `connection`
- Filter: `blob1 = 'connected'` - `blob1 = 'disconnected'`

## Further Reading

- [Cloudflare Analytics Engine Docs](https://developers.cloudflare.com/analytics/analytics-engine/)
- [GraphQL API Reference](https://developers.cloudflare.com/analytics/graphql-api/)
- [Analytics Engine Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
