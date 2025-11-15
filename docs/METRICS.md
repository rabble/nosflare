# Prometheus Metrics for Nosflare

Nosflare includes built-in Prometheus metrics tracking for monitoring relay performance and usage patterns.

## Overview

The metrics system tracks three main categories:
1. **Client Messages** - Messages sent by clients (REQ, EVENT, CLOSE)
2. **Relay Messages** - Messages sent by the relay (EVENT, EOSE, OK, NOTICE, CLOSED)
3. **Events by Kind** - Count of events stored, categorized by Nostr event kind

## Architecture

Since Cloudflare Workers are stateless, metrics are stored in a **Durable Object** (MetricsDO) which provides:
- Persistent state across requests
- Atomic counter increments
- Single source of truth for metrics

The `prom-client` library is used only for safely converting the stored metrics into Prometheus exposition format.

## Configuration

### 1. Environment Variables

Set these in your `wrangler.toml` or Cloudflare dashboard:

```toml
[vars]
METRICS_USERNAME = "metrics"
METRICS_PASSWORD = "your-secure-password-here"
```

**Important:** The `/metrics` endpoint will return a 503 error if `METRICS_PASSWORD` is not set, preventing unauthorized access.

### 2. Staging Environment

```toml
[env.staging.vars]
METRICS_USERNAME = "metrics"
METRICS_PASSWORD = "staging-password"
```

## Accessing Metrics

### HTTP Basic Authentication

The `/metrics` endpoint requires HTTP Basic Authentication:

```bash
curl -u metrics:your-password https://relay.divine.video/metrics
```

### Prometheus Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'nosflare'
    scrape_interval: 30s
    static_configs:
      - targets: ['relay.divine.video']
    metrics_path: /metrics
    scheme: https
    basic_auth:
      username: metrics
      password: your-password
```

## Metrics Exposed

### Client Messages

Tracks messages received from Nostr clients:

```
# HELP divine_nostr_client_messages_total Total number of client messages by verb
# TYPE divine_nostr_client_messages_total counter
divine_nostr_client_messages_total{verb="REQ"} 1523
divine_nostr_client_messages_total{verb="EVENT"} 842
divine_nostr_client_messages_total{verb="CLOSE"} 456
```

**Verbs tracked:**
- `REQ` - Client subscription requests
- `EVENT` - Events published by clients
- `CLOSE` - Subscription closures

### Relay Messages

Tracks messages sent to clients by the relay:

```
# HELP divine_nostr_relay_messages_total Total number of relay messages by verb
# TYPE divine_nostr_relay_messages_total counter
divine_nostr_relay_messages_total{verb="EVENT"} 5234
divine_nostr_relay_messages_total{verb="EOSE"} 1523
divine_nostr_relay_messages_total{verb="OK"} 842
divine_nostr_relay_messages_total{verb="NOTICE"} 23
divine_nostr_relay_messages_total{verb="CLOSED"} 12
```

**Verbs tracked:**
- `EVENT` - Events sent to subscribed clients
- `EOSE` - End of stored events markers
- `OK` - Event acceptance/rejection responses
- `NOTICE` - Error/info notices
- `CLOSED` - Subscription closed notifications

### Events by Kind

Tracks successfully stored events by their Nostr kind:

```
# HELP divine_nostr_events_total Total number of events by kind
# TYPE divine_nostr_events_total counter
divine_nostr_events_total{kind="0"} 142    # User metadata
divine_nostr_events_total{kind="1"} 523    # Text notes
divine_nostr_events_total{kind="3"} 89     # Contact lists
divine_nostr_events_total{kind="34236"} 1834  # Videos
divine_nostr_events_total{kind="30023"} 45    # Long-form articles
```

**Common kinds:**
- `0` - User metadata (profiles)
- `1` - Short text notes
- `3` - Contact lists
- `6` - Reposts
- `7` - Reactions
- `30023` - Long-form articles
- `34236` - Videos (Divine Video)

See [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) for complete kind list.

### Metadata

```
# HELP divine_nostr_metrics_last_update_timestamp Unix timestamp of last metrics update
# TYPE divine_nostr_metrics_last_update_timestamp gauge
divine_nostr_metrics_last_update_timestamp 1700000000
```

## Implementation Details

### Fire-and-Forget Tracking

Metrics are tracked asynchronously using `trackMetricAsync()` to avoid blocking relay operations:

```typescript
// From durable-object.ts
trackMetricAsync(this.env, 'client', 'REQ');
trackMetricAsync(this.env, 'relay', 'EVENT');
trackMetricAsync(this.env, 'event', event.kind);
```

This ensures:
- No performance impact on message processing
- Failed metric updates don't affect relay functionality
- Metrics are eventually consistent

### Storage

Metrics are stored in the MetricsDO's Durable Object storage:

```typescript
interface MetricData {
  clientMessages: Record<string, number>;
  relayMessages: Record<string, number>;
  eventsByKind: Record<number, number>;
  lastUpdate: number;
}
```

### Atomicity

All counter increments are atomic within the Durable Object, preventing race conditions.

## Monitoring Examples

### Grafana Dashboard

Example PromQL queries:

**Request rate:**
```promql
rate(divine_nostr_client_messages_total{verb="REQ"}[5m])
```

**Event publication rate:**
```promql
rate(divine_nostr_events_total[5m])
```

**Most common event kinds:**
```promql
topk(10, divine_nostr_events_total)
```

**Relay response rate:**
```promql
sum(rate(divine_nostr_relay_messages_total[5m])) by (verb)
```

### Alerting

Example alert rules:

```yaml
groups:
  - name: nosflare
    rules:
      - alert: HighErrorRate
        expr: rate(divine_nostr_relay_messages_total{verb="NOTICE"}[5m]) > 10
        for: 5m
        annotations:
          summary: "High error rate on relay"
          
      - alert: NoMetricsUpdate
        expr: time() - divine_nostr_metrics_last_update_timestamp > 300
        for: 5m
        annotations:
          summary: "Metrics not updating"
```

## Security Considerations

1. **Never commit passwords** - Use environment variables
2. **Use strong passwords** - Metrics can reveal usage patterns
3. **HTTPS only** - Basic auth credentials are base64-encoded, not encrypted
4. **Rotate credentials** - Update passwords periodically
5. **Restrict access** - Use firewall rules to limit scraper IPs if possible

## Troubleshooting

### 503 Service Unavailable

```
Metrics endpoint not configured. Set METRICS_PASSWORD environment variable.
```

**Solution:** Set `METRICS_PASSWORD` in wrangler.toml or Cloudflare dashboard.

### 401 Unauthorized

```
Unauthorized
```

**Solution:** Check username/password. Default username is `metrics`.

### Empty Metrics

```
# No metrics available
```

**Solution:** 
- Wait for traffic - metrics are only created when events occur
- Check that MetricsDO is properly deployed
- Verify Durable Object bindings in wrangler.toml

### Metrics Not Updating

Check the `nostr_metrics_last_update_timestamp` value. If it's stale:
- Verify the relay is receiving traffic
- Check Worker logs for errors
- Ensure MetricsDO is accessible

## Development

### Testing Locally

```bash
# Start local dev server
npm run dev

# Access metrics (will prompt for auth)
curl -u metrics:test http://localhost:8787/metrics
```

### Resetting Metrics

Metrics can be reset via the MetricsDO (useful for testing):

```typescript
const tracker = new MetricsTracker(env);
await tracker.resetMetrics();
```

## Performance Impact

The metrics system is designed for minimal overhead:
- **Async tracking** - Fire-and-forget, doesn't block requests
- **Single DO** - One global MetricsDO instance
- **No database queries** - All state in DO storage
- **Efficient format conversion** - Prometheus format generated on-demand

Expected overhead: **< 1ms per tracked event**

## Future Enhancements

Potential additions:
- Histogram metrics for latency tracking
- Gauge metrics for active connections
- Summary metrics for event sizes
- Custom labels (region, DO location, etc.)
- Metrics retention/rollup for long-term storage

## References

- [Prometheus Exposition Format](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Nostr Protocol](https://github.com/nostr-protocol/nips)
- [prom-client Documentation](https://github.com/siimon/prom-client)
