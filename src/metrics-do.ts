import { DurableObjectState } from './types';

/**
 * MetricsDO - Durable Object for storing Prometheus metrics
 * 
 * Since Workers are stateless, we use a Durable Object to maintain
 * metric state across requests. Each metric type (counter, gauge, etc.)
 * is stored in DO storage and can be incremented atomically.
 */

interface MetricData {
  // Client message counters (REQ, EVENT, CLOSE, etc.)
  clientMessages: Record<string, number>;
  
  // Relay message counters (EVENT, EOSE, OK, NOTICE, CLOSED)
  relayMessages: Record<string, number>;
  
  // Event counters by kind
  eventsByKind: Record<number, number>;
  
  // Last update timestamp
  lastUpdate: number;
}

export class MetricsDO implements DurableObject {
  private state: DurableObjectState;
  private metrics: MetricData;
  private initialized: boolean = false;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.metrics = {
      clientMessages: {},
      relayMessages: {},
      eventsByKind: {},
      lastUpdate: Date.now()
    };
  }

  async fetch(request: Request): Promise<Response> {
    // Initialize metrics from storage on first request
    if (!this.initialized) {
      await this.loadMetrics();
      this.initialized = true;
    }

    const url = new URL(request.url);
    
    // Handle different endpoints
    if (url.pathname === '/increment') {
      return await this.handleIncrement(request);
    } else if (url.pathname === '/get') {
      return await this.handleGet(request);
    } else if (url.pathname === '/reset') {
      return await this.handleReset(request);
    } else {
      return new Response('Not found', { status: 404 });
    }
  }

  private async loadMetrics(): Promise<void> {
    const stored = await this.state.storage.get<MetricData>('metrics');
    if (stored) {
      this.metrics = stored;
    }
  }

  private async saveMetrics(): Promise<void> {
    this.metrics.lastUpdate = Date.now();
    await this.state.storage.put('metrics', this.metrics);
  }

  private async handleIncrement(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json() as {
        type: 'client' | 'relay' | 'event';
        label: string | number;
        value?: number;
      };

      const incrementValue = body.value || 1;

      switch (body.type) {
        case 'client':
          const clientLabel = body.label as string;
          this.metrics.clientMessages[clientLabel] = 
            (this.metrics.clientMessages[clientLabel] || 0) + incrementValue;
          break;
        
        case 'relay':
          const relayLabel = body.label as string;
          this.metrics.relayMessages[relayLabel] = 
            (this.metrics.relayMessages[relayLabel] || 0) + incrementValue;
          break;
        
        case 'event':
          const kind = body.label as number;
          this.metrics.eventsByKind[kind] = 
            (this.metrics.eventsByKind[kind] || 0) + incrementValue;
          break;
        
        default:
          return new Response('Invalid metric type', { status: 400 });
      }

      await this.saveMetrics();
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Error incrementing metric:', error);
      return new Response('Internal server error', { status: 500 });
    }
  }

  private async handleGet(request: Request): Promise<Response> {
    return Response.json(this.metrics);
  }

  private async handleReset(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    this.metrics = {
      clientMessages: {},
      relayMessages: {},
      eventsByKind: {},
      lastUpdate: Date.now()
    };

    await this.saveMetrics();
    return new Response('Metrics reset', { status: 200 });
  }
}

/**
 * Convert stored metrics to Prometheus exposition format
 * This runs in the Worker (stateless) using data from the MetricsDO
 */
export function metricsToPrometheus(metrics: MetricData): string {
  const lines: string[] = [];

  // Client messages counter
  lines.push('# HELP divine_nostr_client_messages_total Total number of client messages by verb');
  lines.push('# TYPE divine_nostr_client_messages_total counter');
  for (const [verb, count] of Object.entries(metrics.clientMessages)) {
    lines.push(`divine_nostr_client_messages_total{verb="${verb}"} ${count}`);
  }

  // Relay messages counter
  lines.push('# HELP divine_nostr_relay_messages_total Total number of relay messages by verb');
  lines.push('# TYPE divine_nostr_relay_messages_total counter');
  for (const [verb, count] of Object.entries(metrics.relayMessages)) {
    lines.push(`divine_nostr_relay_messages_total{verb="${verb}"} ${count}`);
  }

  // Events by kind counter
  lines.push('# HELP divine_nostr_events_total Total number of events by kind');
  lines.push('# TYPE divine_nostr_events_total counter');
  for (const [kind, count] of Object.entries(metrics.eventsByKind)) {
    lines.push(`divine_nostr_events_total{kind="${kind}"} ${count}`);
  }

  return lines.join('\n') + '\n';
}
