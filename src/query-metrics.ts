// ABOUTME: Query metrics collection for observability and performance monitoring
// ABOUTME: Tracks latency, index usage, cursor rejections - logs to Cloudflare analytics

/**
 * Metrics for a single query execution
 */
export interface QueryMetrics {
  queryType: 'vendor' | 'standard';  // Vendor = uses int# or custom sort
  sortField: string;                  // Column being sorted by
  hasHashtag: boolean;                // Query filters by hashtag
  hasIntFilters: boolean;             // Query uses int# filters
  hasCursor: boolean;                 // Query uses pagination cursor
  latencyMs: number;                  // Total query execution time
  rowsReturned: number;               // Number of events returned
  cursorRejected: boolean;            // Was cursor rejected (HMAC/query hash fail)
  cursorRejectReason?: string;        // Why cursor was rejected
  timestamp: number;                  // When query executed (unix timestamp)
}

/**
 * Metrics collector singleton
 * Tracks metrics in memory and logs to console for Cloudflare analytics
 */
export class MetricsCollector {
  private metrics: QueryMetrics[] = [];
  private readonly maxMetrics = 1000;  // Keep last 1000 metrics in memory

  /**
   * Record a query execution
   */
  recordQuery(m: QueryMetrics): void {
    this.metrics.push(m);

    // Trim old metrics if buffer full
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift();
    }

    // Log to console (Cloudflare collects these for analytics)
    console.log(JSON.stringify({
      type: 'query_metrics',
      ...m
    }));
  }

  /**
   * Record a cursor rejection
   */
  recordCursorRejection(reason: string, filter: any): void {
    console.log(JSON.stringify({
      type: 'cursor_rejected',
      reason,
      hasHashtag: !!filter['#t'],
      hasIntFilters: Object.keys(filter).some(k => k.startsWith('int#')),
      timestamp: Math.floor(Date.now() / 1000)
    }));
  }

  /**
   * Get p50 latency (median) in milliseconds
   */
  getP50Latency(queryType?: 'vendor' | 'standard'): number {
    const filtered = queryType
      ? this.metrics.filter(m => m.queryType === queryType)
      : this.metrics;

    if (filtered.length === 0) return 0;

    const sorted = filtered.map(m => m.latencyMs).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.5);
    return sorted[idx] || 0;
  }

  /**
   * Get p95 latency in milliseconds
   */
  getP95Latency(queryType?: 'vendor' | 'standard'): number {
    const filtered = queryType
      ? this.metrics.filter(m => m.queryType === queryType)
      : this.metrics;

    if (filtered.length === 0) return 0;

    const sorted = filtered.map(m => m.latencyMs).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] || 0;
  }

  /**
   * Get p99 latency in milliseconds
   */
  getP99Latency(queryType?: 'vendor' | 'standard'): number {
    const filtered = queryType
      ? this.metrics.filter(m => m.queryType === queryType)
      : this.metrics;

    if (filtered.length === 0) return 0;

    const sorted = filtered.map(m => m.latencyMs).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.99);
    return sorted[idx] || 0;
  }

  /**
   * Get cursor rejection rate (0-1)
   */
  getCursorRejectionRate(): number {
    const withCursor = this.metrics.filter(m => m.hasCursor);
    if (withCursor.length === 0) return 0;

    const rejected = withCursor.filter(m => m.cursorRejected).length;
    return rejected / withCursor.length;
  }

  /**
   * Get query type distribution
   */
  getQueryTypeDistribution(): { vendor: number; standard: number } {
    const vendor = this.metrics.filter(m => m.queryType === 'vendor').length;
    const standard = this.metrics.filter(m => m.queryType === 'standard').length;
    return { vendor, standard };
  }

  /**
   * Get summary statistics for monitoring dashboard
   */
  getSummary(): {
    totalQueries: number;
    vendorQueries: number;
    standardQueries: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    cursorRejectionRate: number;
  } {
    const dist = this.getQueryTypeDistribution();

    return {
      totalQueries: this.metrics.length,
      vendorQueries: dist.vendor,
      standardQueries: dist.standard,
      p50LatencyMs: this.getP50Latency(),
      p95LatencyMs: this.getP95Latency(),
      p99LatencyMs: this.getP99Latency(),
      cursorRejectionRate: this.getCursorRejectionRate()
    };
  }

  /**
   * Clear all metrics (for testing)
   */
  clear(): void {
    this.metrics = [];
  }
}

/**
 * Global metrics collector instance
 * Import and use this in query handlers
 */
export const metricsCollector = new MetricsCollector();
