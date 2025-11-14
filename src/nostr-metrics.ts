// ABOUTME: Nostr-specific metrics tracking using Cloudflare Analytics Engine
// ABOUTME: Tracks client messages (EVENT, REQ, CLOSE), relay responses (OK, EOSE, CLOSED, NOTICE),
// ABOUTME: event kinds, rejection reasons, and performance metrics

import { Env } from './types';

/**
 * Nostr client message types
 */
export type NostrClientMessageType = 'EVENT' | 'REQ' | 'CLOSE' | 'AUTH' | 'COUNT';

/**
 * Nostr relay message types
 */
export type NostrRelayMessageType = 'EVENT' | 'OK' | 'EOSE' | 'CLOSED' | 'NOTICE' | 'AUTH';

/**
 * Event rejection reasons
 */
export type RejectionReason =
  | 'invalid_signature'
  | 'payment_required'
  | 'pubkey_blocked'
  | 'kind_blocked'
  | 'tag_blocked'
  | 'content_blocked'
  | 'rate_limited'
  | 'duplicate'
  | 'pow_difficulty'
  | 'invalid_format'
  | 'nip05_invalid'
  | 'spam_detected';

/**
 * Nostr metrics collector using Cloudflare Analytics Engine
 */
export class NostrMetrics {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Record a client message received
   */
  recordClientMessage(type: NostrClientMessageType, metadata?: Record<string, string | number>): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [type],
        doubles: [1], // count
        indexes: ['client_message']
      });

      // Also log for debugging
      console.log(JSON.stringify({
        metric_type: 'client_message',
        message_type: type,
        ...metadata
      }));
    } catch (error) {
      console.error('Failed to record client message metric:', error);
    }
  }

  /**
   * Record a relay message sent
   */
  recordRelayMessage(type: NostrRelayMessageType, metadata?: Record<string, string | number>): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [type],
        doubles: [1], // count
        indexes: ['relay_message']
      });

      console.log(JSON.stringify({
        metric_type: 'relay_message',
        message_type: type,
        ...metadata
      }));
    } catch (error) {
      console.error('Failed to record relay message metric:', error);
    }
  }

  /**
   * Record an event submission by kind
   */
  recordEventKind(kind: number, accepted: boolean, reason?: RejectionReason): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [accepted ? 'accepted' : 'rejected', reason || 'none'],
        doubles: [kind, 1], // kind number, count
        indexes: ['event_kind']
      });

      console.log(JSON.stringify({
        metric_type: 'event_kind',
        kind,
        accepted,
        reason
      }));
    } catch (error) {
      console.error('Failed to record event kind metric:', error);
    }
  }

  /**
   * Record a subscription (REQ) with filter details
   */
  recordSubscription(filterCount: number, hasAuthors: boolean, hasKinds: boolean, hasHashtags: boolean, hasSearch: boolean): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [
          hasAuthors ? 'has_authors' : 'no_authors',
          hasKinds ? 'has_kinds' : 'no_kinds',
          hasHashtags ? 'has_hashtags' : 'no_hashtags',
          hasSearch ? 'has_search' : 'no_search'
        ],
        doubles: [filterCount, 1], // filter count, occurrence count
        indexes: ['subscription']
      });

      console.log(JSON.stringify({
        metric_type: 'subscription',
        filter_count: filterCount,
        has_authors: hasAuthors,
        has_kinds: hasKinds,
        has_hashtags: hasHashtags,
        has_search: hasSearch
      }));
    } catch (error) {
      console.error('Failed to record subscription metric:', error);
    }
  }

  /**
   * Record query performance
   */
  recordQueryPerformance(
    latencyMs: number,
    resultCount: number,
    hasArchive: boolean,
    queryType: 'standard' | 'video' | 'search'
  ): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [queryType, hasArchive ? 'with_archive' : 'no_archive'],
        doubles: [latencyMs, resultCount],
        indexes: ['query_performance']
      });

      console.log(JSON.stringify({
        metric_type: 'query_performance',
        latency_ms: latencyMs,
        result_count: resultCount,
        has_archive: hasArchive,
        query_type: queryType
      }));
    } catch (error) {
      console.error('Failed to record query performance metric:', error);
    }
  }

  /**
   * Record event rejection with reason
   */
  recordRejection(reason: RejectionReason, kind?: number, pubkey?: string): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [reason, kind?.toString() || 'unknown'],
        doubles: [1], // count
        indexes: ['rejection']
      });

      console.log(JSON.stringify({
        metric_type: 'rejection',
        reason,
        kind,
        pubkey_prefix: pubkey?.substring(0, 8)
      }));
    } catch (error) {
      console.error('Failed to record rejection metric:', error);
    }
  }

  /**
   * Record payment status check
   */
  recordPaymentCheck(hasPaid: boolean, fromCache: boolean): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [hasPaid ? 'paid' : 'unpaid', fromCache ? 'cached' : 'db_lookup'],
        doubles: [1], // count
        indexes: ['payment_check']
      });

      console.log(JSON.stringify({
        metric_type: 'payment_check',
        has_paid: hasPaid,
        from_cache: fromCache
      }));
    } catch (error) {
      console.error('Failed to record payment check metric:', error);
    }
  }

  /**
   * Record websocket connection event
   */
  recordConnection(event: 'connected' | 'disconnected' | 'error', region?: string): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [event, region || 'unknown'],
        doubles: [1], // count
        indexes: ['connection']
      });

      console.log(JSON.stringify({
        metric_type: 'connection',
        event,
        region
      }));
    } catch (error) {
      console.error('Failed to record connection metric:', error);
    }
  }

  /**
   * Record broadcast event (DO-to-DO)
   */
  recordBroadcast(sourceRegion: string, targetRegion: string, eventKind: number): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [sourceRegion, targetRegion],
        doubles: [eventKind, 1], // event kind, count
        indexes: ['broadcast']
      });

      console.log(JSON.stringify({
        metric_type: 'broadcast',
        source_region: sourceRegion,
        target_region: targetRegion,
        event_kind: eventKind
      }));
    } catch (error) {
      console.error('Failed to record broadcast metric:', error);
    }
  }

  /**
   * Record NIP-05 validation
   */
  recordNip05Validation(valid: boolean, domain?: string): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [valid ? 'valid' : 'invalid', domain || 'unknown'],
        doubles: [1], // count
        indexes: ['nip05_validation']
      });

      console.log(JSON.stringify({
        metric_type: 'nip05_validation',
        valid,
        domain
      }));
    } catch (error) {
      console.error('Failed to record NIP-05 validation metric:', error);
    }
  }

  /**
   * Record search query
   */
  recordSearch(
    searchType: 'user' | 'video' | 'note' | 'list' | 'article' | 'community' | 'hashtag' | 'unified',
    resultCount: number,
    latencyMs: number
  ): void {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('Analytics Engine not configured');
      return;
    }

    try {
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: [searchType],
        doubles: [resultCount, latencyMs],
        indexes: ['search']
      });

      console.log(JSON.stringify({
        metric_type: 'search',
        search_type: searchType,
        result_count: resultCount,
        latency_ms: latencyMs
      }));
    } catch (error) {
      console.error('Failed to record search metric:', error);
    }
  }
}
