import { RelayInfo, Env } from './types';

// ***************************** //
// ** BEGIN EDITABLE SETTINGS ** //
// ***************************** //

// Settings below can be configured to your preferences

// Pay to relay
export const relayNpub = "npub16jdfqgazrkapk0yrqm9rdxlnys7ck39c7zmdzxtxqlmmpxg04r0sd733sv"; // Use your own npub
export const PAY_TO_RELAY_ENABLED = false; // Set to false to disable pay to relay
export const RELAY_ACCESS_PRICE_SATS = 2121; // Price in SATS for relay access

// Metrics endpoint configuration
// Set METRICS_USERNAME and METRICS_PASSWORD as environment variables in wrangler.toml
// or in the Cloudflare dashboard under Settings > Variables
// The /metrics endpoint uses HTTP Basic Authentication
// Example: curl -u metrics:yourpassword https://relay.divine.video/metrics

// Function to get environment-specific relay info
export function getRelayInfo(env: Env): RelayInfo {
  const isStaging = env.ENVIRONMENT === 'staging';

  return {
    name: isStaging ? "Divine Video Relay (STAGING)" : "Divine Video Relay",
    description: isStaging
      ? "🚧 STAGING - Testing environment for Divine Video's 6-second short-form videos with ProofMode verification"
      : "A specialized Nostr relay for Divine Video's 6-second short-form videos with ProofMode verification ensuring authentic, human-created content",
    pubkey: "d49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df",
    contact: isStaging ? "staging@divine.video" : "relay@divine.video",
    supported_nips: [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40, 50],
    software: "https://github.com/Spl0itable/nosflare",
    version: "7.4.11",
    icon: "https://divine.video/logo.png",

    // Relay limitations
    limitation: {
      payment_required: PAY_TO_RELAY_ENABLED,
      restricted_writes: PAY_TO_RELAY_ENABLED,
    },

    // NIP-50 search capabilities
    search: {
      enabled: true,
      entity_types: ['user', 'video', 'list', 'hashtag', 'note', 'article', 'community', 'all'],
      extensions: ['type:', 'author:', 'kind:', 'hashtag:', 'min_likes:', 'min_loops:', 'since:', 'until:'],
      max_results: 200,
      ranking_algorithm: 'bm25',
      features: ['prefix_matching', 'autocomplete', 'snippet_generation', 'relevance_scoring']
    },

    // Vendor extensions (Phase 1: Video discovery with custom filters)
    divine_extensions: {
      int_filters: ["loop_count", "likes", "views", "comments", "avg_completion", "has_proofmode", "has_device_attestation", "has_pgp_signature"],
      sort_fields: ["loop_count", "likes", "views", "comments", "avg_completion", "created_at"],
      cursor_format: "base64url-encoded HMAC-SHA256 with query hash binding",
      videos_kind: 34236,
      metrics_freshness_sec: 3600, // Metrics updated hourly via analytics pipeline
      limit_max: 200, // Hard cap for sorted queries
      proofmode: {
        enabled: true,
        verification_filter: "verification",  // Filter by verification level (e.g., verification: ['verified_mobile', 'verified_web'])
        verification_levels: ["verified_mobile", "verified_web", "basic_proof", "unverified"],
        tags: ["verification", "proofmode", "device_attestation", "pgp_fingerprint"],
        info_url: "https://divine.video/proofmode"
      }
    }
  };
}

// Legacy export for backward compatibility (production defaults)
// Use getRelayInfo(env) in worker code instead
export const relayInfo: RelayInfo = {
  name: "Divine Video Relay",
  description: "A specialized Nostr relay for Divine Video's 6-second short-form videos with ProofMode verification ensuring authentic, human-created content",
  pubkey: "d49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df",
  contact: "relay@divine.video",
  supported_nips: [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40, 50],
  software: "https://github.com/Spl0itable/nosflare",
  version: "7.4.11",
  icon: "https://divine.video/logo.png",

  limitation: {
    payment_required: PAY_TO_RELAY_ENABLED,
    restricted_writes: PAY_TO_RELAY_ENABLED,
  },

  search: {
    enabled: true,
    entity_types: ['user', 'video', 'list', 'hashtag', 'note', 'article', 'community', 'all'],
    extensions: ['type:', 'author:', 'kind:', 'hashtag:', 'min_likes:', 'min_loops:', 'since:', 'until:'],
    max_results: 200,
    ranking_algorithm: 'bm25',
    features: ['prefix_matching', 'autocomplete', 'snippet_generation', 'relevance_scoring']
  },

  divine_extensions: {
    int_filters: ["loop_count", "likes", "views", "comments", "avg_completion", "has_proofmode", "has_device_attestation", "has_pgp_signature"],
    sort_fields: ["loop_count", "likes", "views", "comments", "avg_completion", "created_at"],
    cursor_format: "base64url-encoded HMAC-SHA256 with query hash binding",
    videos_kind: 34236,
    metrics_freshness_sec: 3600,
    limit_max: 200,
    proofmode: {
      enabled: true,
      verification_filter: "verification",
      verification_levels: ["verified_mobile", "verified_web", "basic_proof", "unverified"],
      tags: ["verification", "proofmode", "device_attestation", "pgp_fingerprint"],
      info_url: "https://divine.video/proofmode"
    }
  }
};

// Nostr address NIP-05 verified users (for verified checkmark like username@your-relay.com)
export const nip05Users: Record<string, string> = {
  "Luxas": "d49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df",
  // ... more NIP-05 verified users
};

// Anti-spam settings
export const enableAntiSpam = false; // Set to true to enable hashing and duplicate content checking
export const enableGlobalDuplicateCheck = false; // When anti-spam is enabled, set to true for global hash (across all pubkeys and not individually)

// Kinds subjected to duplicate checks (only when anti-spam is enabled)
export const antiSpamKinds = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 40, 41, 42, 43, 44, 64, 818, 1021, 1022, 1040, 1059, 1063, 1311, 1617, 1621, 1622, 1630, 1633, 1971, 1984, 1985, 1986, 1987, 2003, 2004, 2022, 4550, 5000, 5999, 6000, 6999, 7000, 9000, 9030, 9041, 9467, 9734, 9735, 9802, 10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10009, 10015, 10030, 10050, 10063, 10096, 13194, 21000, 22242, 23194, 23195, 24133, 24242, 27235, 30000, 30001, 30002, 30003, 30004, 30005, 30007, 30008, 30009, 30015, 30017, 30018, 30019, 30020, 30023, 30024, 30030, 30040, 30041, 30063, 30078, 30311, 30315, 30402, 30403, 30617, 30618, 30818, 30819, 31890, 31922, 31923, 31924, 31925, 31989, 31990, 34235, 34236, 34237, 34550, 39000, 39001, 39002, 39003, 39004, 39005, 39006, 39007, 39008, 39009
  // Add other kinds you want to check for duplicates
]);

// Blocked pubkeys
// Add pubkeys in hex format to block write access
export const blockedPubkeys = new Set<string>([]);







// Allowed pubkeys
// Add pubkeys in hex format to allow write access
export const allowedPubkeys = new Set<string>([
  // ... pubkeys that are explicitly allowed
]);

// Blocked event kinds
// Add comma-separated kinds Ex: 1064, 4, 22242
export const blockedEventKinds = new Set([
  1064
]);

// Allowed event kinds
// Add comma-separated kinds Ex: 1, 2, 3
export const allowedEventKinds = new Set<number>([
  // ... kinds that are explicitly allowed
]);

// Blocked words or phrases (case-insensitive)
export const blockedContent = new Set([
  "~~ hello world! ~~"
  // ... more blocked content
]);

// NIP-05 validation
export const checkValidNip05 = false; // Set to true to enable NIP-05 validation (this requires users to have a valid NIP-05 in order to publish events to the relay as part of anti-spam)

// Blocked NIP-05 domains
// This prevents users with NIP-05's from specified domains from publishing events to the relay
export const blockedNip05Domains = new Set<string>([
  // Add domains that are explicitly blocked
  // "primal.net"
]);

// Allowed NIP-05 domains
export const allowedNip05Domains = new Set<string>([
  // Add domains that are explicitly allowed
  // Leave empty to allow all domains (unless blocked)
]);

// Blocked tags
// Add comma-separated tags Ex: t, e, p
export const blockedTags = new Set<string>([
  // ... tags that are explicitly blocked
]);

// Allowed tags
// Add comma-separated tags Ex: p, e, t
export const allowedTags = new Set<string>([
  // "p", "e", "t"
  // ... tags that are explicitly allowed
]);

// Rate limit thresholds
export const PUBKEY_RATE_LIMIT = { rate: 10 / 60000, capacity: 10 }; // 10 EVENT messages per min
export const REQ_RATE_LIMIT = { rate: 50 / 60000, capacity: 50 }; // 50 REQ messages per min
export const excludedRateLimitKinds = new Set<number>([
  1059
  // ... kinds to exclude from EVENT rate limiting Ex: 1, 2, 3
]);

// *************************** //
// ** END EDITABLE SETTINGS ** //
// *************************** //

// Helper validation functions
import { NostrEvent } from './types';

export function isPubkeyAllowed(pubkey: string): boolean {
  if (allowedPubkeys.size > 0 && !allowedPubkeys.has(pubkey)) {
    return false;
  }
  return !blockedPubkeys.has(pubkey);
}

export function isEventKindAllowed(kind: number): boolean {
  if (allowedEventKinds.size > 0 && !allowedEventKinds.has(kind)) {
    return false;
  }
  return !blockedEventKinds.has(kind);
}

export function containsBlockedContent(event: NostrEvent): boolean {
  const lowercaseContent = (event.content || "").toLowerCase();
  const lowercaseTags = event.tags.map(tag => tag.join("").toLowerCase());

  for (const blocked of blockedContent) {
    const blockedLower = blocked.toLowerCase(); // Checks case-insensitively
    if (
      lowercaseContent.includes(blockedLower) ||
      lowercaseTags.some(tag => tag.includes(blockedLower))
    ) {
      return true;
    }
  }
  return false;
}

export function isTagAllowed(tag: string): boolean {
  if (allowedTags.size > 0 && !allowedTags.has(tag)) {
    return false;
  }
  return !blockedTags.has(tag);
}