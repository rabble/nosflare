import { Env } from './types';

/**
 * Metrics Tracker - Helper functions to track metrics in the MetricsDO
 * 
 * These functions are called from the relay worker and durable object
 * to increment counters in the centralized MetricsDO.
 */

export class MetricsTracker {
  private env: Env;
  private metricsStub: DurableObjectStub | null = null;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get or create the metrics DO stub
   */
  private getMetricsStub(): DurableObjectStub {
    if (!this.metricsStub) {
      // Use a single named DO for all metrics
      const id = this.env.METRICS_DO.idFromName('global-metrics');
      this.metricsStub = this.env.METRICS_DO.get(id);
    }
    return this.metricsStub;
  }

  /**
   * Track a client message (REQ, EVENT, CLOSE, etc.)
   */
  async trackClientMessage(verb: string, count: number = 1): Promise<void> {
    try {
      const stub = this.getMetricsStub();
      await stub.fetch('https://metrics-do/increment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client',
          label: verb,
          value: count
        })
      });
    } catch (error) {
      // Don't fail the request if metrics tracking fails
      console.error('Failed to track client message:', error);
    }
  }

  /**
   * Track a relay message (EVENT, EOSE, OK, NOTICE, CLOSED)
   */
  async trackRelayMessage(verb: string, count: number = 1): Promise<void> {
    try {
      const stub = this.getMetricsStub();
      await stub.fetch('https://metrics-do/increment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'relay',
          label: verb,
          value: count
        })
      });
    } catch (error) {
      console.error('Failed to track relay message:', error);
    }
  }

  /**
   * Track an event by kind
   */
  async trackEvent(kind: number, count: number = 1): Promise<void> {
    try {
      const stub = this.getMetricsStub();
      await stub.fetch('https://metrics-do/increment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'event',
          label: kind,
          value: count
        })
      });
    } catch (error) {
      console.error('Failed to track event:', error);
    }
  }

  /**
   * Get current metrics data
   */
  async getMetrics(): Promise<any> {
    try {
      const stub = this.getMetricsStub();
      const response = await stub.fetch('https://metrics-do/get');
      return await response.json();
    } catch (error) {
      console.error('Failed to get metrics:', error);
      return null;
    }
  }

  /**
   * Reset all metrics (useful for testing)
   */
  async resetMetrics(): Promise<void> {
    try {
      const stub = this.getMetricsStub();
      await stub.fetch('https://metrics-do/reset', {
        method: 'POST'
      });
    } catch (error) {
      console.error('Failed to reset metrics:', error);
    }
  }
}

/**
 * Fire-and-forget metrics tracking
 * Use this when you don't want to await the metrics call
 */
export function trackMetricAsync(
  env: Env,
  type: 'client' | 'relay' | 'event',
  label: string | number,
  count: number = 1
): void {
  // Create tracker and track in background
  const tracker = new MetricsTracker(env);
  
  switch (type) {
    case 'client':
      tracker.trackClientMessage(label as string, count).catch(e => 
        console.error('Async client metric failed:', e)
      );
      break;
    case 'relay':
      tracker.trackRelayMessage(label as string, count).catch(e => 
        console.error('Async relay metric failed:', e)
      );
      break;
    case 'event':
      tracker.trackEvent(label as number, count).catch(e => 
        console.error('Async event metric failed:', e)
      );
      break;
  }
}
