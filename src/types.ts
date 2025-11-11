// Nostr protocol types
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// Search-related types

/**
 * Types of entities that can be searched in the relay
 * Used by NIP-50 search extensions to filter by entity type
 */
export type SearchEntityType = 'user' | 'video' | 'list' | 'hashtag' | 'note' | 'article' | 'community' | 'all';

/**
 * Options for performing a search query
 * Used by the relay's search functionality
 */
export interface SearchOptions {
  /** The search query string */
  query: string;
  /** Filter results to specific entity types */
  types?: SearchEntityType[];
  /** Filter results to specific Nostr event kinds */
  kinds?: number[];
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip (for pagination) */
  offset?: number;
  /** Minimum relevance score threshold (0-1) */
  minRelevance?: number;
}

/**
 * A single search result with relevance scoring
 */
export interface SearchResult {
  /** The type of entity found */
  type: SearchEntityType;
  /** The matching Nostr event */
  event: NostrEvent;
  /** Relevance score (0-1, higher is more relevant) */
  relevance_score: number;
  /** Text snippet showing the match context */
  snippet?: string;
  /** Which fields matched the search query */
  match_fields?: string[];
}

/**
 * Parsed representation of a search query with extracted filters
 * Used internally to process search queries
 */
export interface ParsedSearchQuery {
  /** Original raw search query string */
  raw: string;
  /** Extracted search terms */
  terms: string[];
  /** Entity type filter extracted from query */
  type?: SearchEntityType;
  /** Structured filters extracted from query */
  filters: {
    /** Author pubkey filter */
    author?: string;
    /** Event kind filters (array for consistency with NostrFilter) */
    kinds?: number[];
    /** Hashtag filters */
    hashtags?: string[];
    /** Minimum timestamp filter */
    since?: number;
    /** Maximum timestamp filter */
    until?: number;
    /** Minimum likes threshold */
    min_likes?: number;
    /** Minimum loop count threshold */
    min_loops?: number;
  };
}

/**
 * Nostr filter with vendor extensions for video queries
 *
 * Standard NIP-01 filters:
 * - ids, authors, kinds: Event filters
 * - since, until: Timestamp filters
 * - limit: Result count limit
 * - #<tag>: Tag filters (e.g., #t for hashtags, #e for event refs)
 *
 * Vendor extensions (nosflare-specific):
 * - search: NIP-50 full-text search
 * - search_types: Filter search by entity type
 * - sort: Sort results by engagement metrics
 * - cursor: Keyset pagination cursor
 * - verification: Filter by ProofMode verification level
 * - int#<metric>: Numeric comparison filters for engagement metrics
 */
export interface NostrFilter {
  // Standard NIP-01 filters
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;

  // Search extensions (NIP-50)
  search?: string;
  search_types?: SearchEntityType[];

  // Vendor extensions (nosflare-specific)
  /** Sort results by a field (default: created_at desc) */
  sort?: {
    /** Field name to sort by (e.g., 'loop_count', 'likes', 'created_at') */
    field: string;
    /** Sort direction */
    dir: 'asc' | 'desc';
  };

  /** Keyset pagination cursor (signed, includes query hash) */
  cursor?: string;

  /** ProofMode verification level filter (e.g., ['verified_mobile', 'verified_web']) */
  verification?: string[];

  // Tag filters (dynamic)
  /** Tag filters using # prefix (e.g., #t for hashtags, #e for event refs) */
  [key: `#${string}`]: string[] | undefined;

  // Integer comparison filters (dynamic)
  /** Numeric comparison filters using int# prefix (e.g., int#likes, int#loop_count) */
  [key: `int#${string}`]: {
    /** Greater than or equal to */
    gte?: number;
    /** Greater than */
    gt?: number;
    /** Less than or equal to */
    lte?: number;
    /** Less than */
    lt?: number;
    /** Equal to */
    eq?: number;
    /** Not equal to */
    neq?: number;
  } | undefined;

  // Catch-all for other extensions
  [key: string]: any;
}

export interface RelayInfo {
  name: string;
  description: string;
  pubkey: string;
  contact: string;
  supported_nips: number[];
  software: string;
  version: string;
  icon: string;
  limitation?: {
    payment_required?: boolean;
    restricted_writes?: boolean;
    [key: string]: any;
  };
  payments_url?: string;
  fees?: {
    admission?: Array<{ amount: number; unit: string }>;
    subscription?: Array<{ amount: number; unit: string; period: number }>;
    publication?: Array<{ kinds: number[]; amount: number; unit: string }>;
  };
}

export interface Subscription {
  id: string;
  filters: NostrFilter[];
}

export interface QueryResult {
  events: NostrEvent[];
  bookmark: string | null;
}

// Worker environment type
export interface Env {
  RELAY_DATABASE: D1Database;
  RELAY_WEBSOCKET: DurableObjectNamespace;
  EVENT_ARCHIVE: R2Bucket;
  CURSOR_SECRET: string;
  CURSOR_SECRET_PREVIOUS?: string; // For secret rotation
}

// Durable Object types
export interface RateLimiterConfig {
  rate: number;
  capacity: number;
}

export interface WebSocketSession {
  id: string;
  webSocket: WebSocket;
  subscriptions: Map<string, NostrFilter[]>;
  pubkeyRateLimiter: RateLimiter;
  reqRateLimiter: RateLimiter;
  bookmark: string;
  host: string;
}

export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private capacity: number;
  private fillRate: number;

  constructor(rate: number, capacity: number) {
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
    this.capacity = capacity;
    this.fillRate = rate;
  }

  removeToken(): boolean {
    this.refill();
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedTime = now - this.lastRefillTime;
    const tokensToAdd = Math.floor(elapsedTime * this.fillRate);
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

// NIP-05 response type
export interface Nip05Response {
  names: Record<string, string>;
  relays?: Record<string, string[]>;
}

// WebSocket message types for Nostr protocol
export type NostrMessage = 
  | ["EVENT", string, NostrEvent]
  | ["EOSE", string]
  | ["OK", string, boolean, string]
  | ["NOTICE", string]
  | ["REQ", string, ...NostrFilter[]]
  | ["CLOSE", string]
  | ["CLOSED", string, string];

// WebSocket event types for Cloudflare Workers
export interface WebSocketEventMap {
  "close": CloseEvent;
  "error": Event;
  "message": MessageEvent;
  "open": Event;
}

// Request body types for internal RPC calls
export interface BroadcastEventRequest {
  event: NostrEvent;
}

// Simplified DO-to-DO broadcast request
export interface DOBroadcastRequest {
  event: NostrEvent;
  sourceDoId: string;
}

// Health check response
export interface HealthCheckResponse {
  status: string;
  doName: string;
  sessions: number;
  activeWebSockets: number;
}

// Durable Object interface with hibernation support
export interface DurableObject {
  fetch(request: Request): Promise<Response>;
  // WebSocket hibernation handlers (optional)
  webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
  webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: any): void | Promise<void>;
}

// Durable Object stub with location hint support
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

// Extended Durable Object namespace with location hints
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId, options?: { locationHint?: string }): DurableObjectStub;
}

export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

// Extended DurableObjectState with hibernation support
export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  // WebSocket hibernation methods
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

export interface DurableObjectStorage {
  get<T = any>(key: string): Promise<T | undefined>;
  get<T = any>(keys: string[]): Promise<Map<string, T>>;
  put<T = any>(key: string, value: T): Promise<void>;
  put(entries: Record<string, any>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

// Extended WebSocket interface with hibernation attachment methods
declare global {
  interface WebSocket {
    serializeAttachment(value: any): void;
    deserializeAttachment(): any;
  }
}