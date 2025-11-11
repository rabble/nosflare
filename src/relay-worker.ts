import { schnorr } from "@noble/curves/secp256k1";
import { Env, NostrEvent, NostrFilter, QueryResult, NostrMessage, Nip05Response } from './types';
import * as config from './config';
import { RelayWebSocket } from './durable-object';
import { runMigrations } from './migrations';
import { indexUserProfile, indexHashtags, indexVideo, indexNote, indexList, indexArticle, indexCommunity } from './search';

// Import config values
const {
  relayInfo,
  getRelayInfo,
  PAY_TO_RELAY_ENABLED,
  RELAY_ACCESS_PRICE_SATS,
  relayNpub,
  nip05Users,
  enableAntiSpam,
  enableGlobalDuplicateCheck,
  antiSpamKinds,
  checkValidNip05,
  blockedNip05Domains,
  allowedNip05Domains,
} = config;

// Archive configuration constants
const ARCHIVE_RETENTION_DAYS = 7300; // ~20 years to keep backdated Vine content in D1
const ARCHIVE_BATCH_SIZE = 10;

// Query optimization constants
const GLOBAL_MAX_EVENTS = 5000;
const DEFAULT_TIME_WINDOW_DAYS = 7;
const MAX_QUERY_COMPLEXITY = 1000;

// Archive index types
interface ArchiveManifest {
  lastUpdated: string;
  hoursWithEvents: string[];  // Format: "YYYY-MM-DD/HH"
  firstHour: string;
  lastHour: string;
  totalEvents: number;
  indices: {
    authors: Set<string>;
    kinds: Set<number>;
    tags: Record<string, Set<string>>;
  };
}

// Database initialization
async function initializeDatabase(db: D1Database): Promise<void> {
  // ALWAYS run migrations first (they're idempotent)
  await runMigrations(db);

  try {
    const session = db.withSession('first-unconstrained');
    const initCheck = await session.prepare(
      "SELECT value FROM system_config WHERE key = 'db_initialized' LIMIT 1"
    ).first().catch(() => null);

    if (initCheck && initCheck.value === '1') {
      console.log("Database already initialized, migrations complete");
      return;
    }
  } catch (error) {
    console.log("Database not initialized, creating schema...");
  }

  const session = db.withSession('first-primary');

  try {
    await session.prepare(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `).run();

    const statements = [
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kind INTEGER NOT NULL,
        tags TEXT NOT NULL,
        content TEXT NOT NULL,
        sig TEXT NOT NULL,
        created_timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey)`,
      `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`,
      `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_kind_created_at ON events(kind, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_pubkey_created_at ON events(pubkey, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_created_at_kind ON events(created_at DESC, kind)`,
      `CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created_at ON events(pubkey, kind, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_kind_pubkey_created_at ON events(kind, pubkey, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_authors_kinds ON events(pubkey, kind) WHERE kind IN (0, 1, 3, 4, 6, 7, 1984, 9735, 10002)`,

      `CREATE TABLE IF NOT EXISTS tags (
        event_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        tag_value TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tags_name_value ON tags(tag_name, tag_value)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_name_value_event ON tags(tag_name, tag_value, event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_event_id ON tags(event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_value ON tags(tag_value)`,

      `CREATE TABLE IF NOT EXISTS event_tags_cache (
        event_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        kind INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        tag_p TEXT,
        tag_e TEXT,
        tag_a TEXT,
        PRIMARY KEY (event_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_event_tags_cache_p ON event_tags_cache(tag_p, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_event_tags_cache_e ON event_tags_cache(tag_e, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_event_tags_cache_kind_p ON event_tags_cache(kind, tag_p)`,
      `CREATE INDEX IF NOT EXISTS idx_event_tags_cache_p_e ON event_tags_cache(tag_p, tag_e) WHERE tag_p IS NOT NULL AND tag_e IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_event_tags_cache_kind_created_at ON event_tags_cache(kind, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_event_tags_cache_pubkey_kind_created_at ON event_tags_cache(pubkey, kind, created_at DESC)`,

      `CREATE TABLE IF NOT EXISTS paid_pubkeys (
        pubkey TEXT PRIMARY KEY,
        paid_at INTEGER NOT NULL,
        amount_sats INTEGER,
        created_timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS content_hashes (
        hash TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_content_hashes_pubkey ON content_hashes(pubkey)`

      // Note: videos table and composite indexes now created by Migration 2 (src/migrations.ts)
    ];

    for (const statement of statements) {
      await session.prepare(statement).run();
    }

    await session.prepare("PRAGMA foreign_keys = ON").run();
    await session.prepare(
      "INSERT OR REPLACE INTO system_config (key, value) VALUES ('db_initialized', '1')"
    ).run();
    await session.prepare(
      "INSERT OR REPLACE INTO system_config (key, value) VALUES ('schema_version', '2')"
    ).run();

    await session.prepare(`
      INSERT OR IGNORE INTO event_tags_cache (event_id, pubkey, kind, created_at, tag_p, tag_e, tag_a)
      SELECT 
        e.id,
        e.pubkey,
        e.kind,
        e.created_at,
        (SELECT tag_value FROM tags WHERE event_id = e.id AND tag_name = 'p' LIMIT 1) as tag_p,
        (SELECT tag_value FROM tags WHERE event_id = e.id AND tag_name = 'e' LIMIT 1) as tag_e,
        (SELECT tag_value FROM tags WHERE event_id = e.id AND tag_name = 'a' LIMIT 1) as tag_a
      FROM events e
      WHERE EXISTS (
        SELECT 1 FROM tags t 
        WHERE t.event_id = e.id 
        AND t.tag_name IN ('p', 'e', 'a')
      )
    `).run();

    // Run ANALYZE to initialize statistics
    await session.prepare("ANALYZE events").run();
    await session.prepare("ANALYZE tags").run();
    await session.prepare("ANALYZE event_tags_cache").run();

    // Analyze videos table if it exists (created by migrations)
    try {
      await session.prepare("ANALYZE videos").run();
    } catch (e) {
      // videos table doesn't exist yet (migration not run), that's ok
    }

    console.log("Database initialization completed!");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  }
}

// Event verification
async function verifyEventSignature(event: NostrEvent): Promise<boolean> {
  try {
    const signatureBytes = hexToBytes(event.sig);
    const serializedEventData = serializeEventForSigning(event);
    const messageHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializedEventData)
    );
    const messageHash = new Uint8Array(messageHashBuffer);
    const publicKeyBytes = hexToBytes(event.pubkey);
    return schnorr.verify(signatureBytes, messageHash, publicKeyBytes);
  } catch (error) {
    console.error("Error verifying event signature:", error);
    return false;
  }
}

function serializeEventForSigning(event: NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

function hexToBytes(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Content hashing for anti-spam
async function hashContent(event: NostrEvent): Promise<string> {
  const contentToHash = enableGlobalDuplicateCheck
    ? JSON.stringify({ kind: event.kind, tags: event.tags, content: event.content })
    : JSON.stringify({ pubkey: event.pubkey, kind: event.kind, tags: event.tags, content: event.content });

  const buffer = new TextEncoder().encode(contentToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function shouldCheckForDuplicates(kind: number): boolean {
  return enableAntiSpam && antiSpamKinds.has(kind);
}

// Payment handling
async function hasPaidForRelay(pubkey: string, env: Env): Promise<boolean> {
  if (!PAY_TO_RELAY_ENABLED) return true;

  try {
    const session = env.RELAY_DATABASE.withSession('first-unconstrained');
    const result = await session.prepare(
      "SELECT pubkey FROM paid_pubkeys WHERE pubkey = ? LIMIT 1"
    ).bind(pubkey).first();
    return result !== null;
  } catch (error) {
    console.error(`Error checking paid status for ${pubkey}:`, error);
    return false;
  }
}

async function savePaidPubkey(pubkey: string, env: Env): Promise<boolean> {
  try {
    const session = env.RELAY_DATABASE.withSession('first-primary');
    await session.prepare(`
      INSERT INTO paid_pubkeys (pubkey, paid_at, amount_sats)
      VALUES (?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET
        paid_at = excluded.paid_at,
        amount_sats = excluded.amount_sats
    `).bind(pubkey, Math.floor(Date.now() / 1000), RELAY_ACCESS_PRICE_SATS).run();
    return true;
  } catch (error) {
    console.error(`Error saving paid pubkey ${pubkey}:`, error);
    return false;
  }
}

// Fetches kind 0 event from fallback relay
function fetchEventFromFallbackRelay(pubkey: string): Promise<NostrEvent | null> {
  return new Promise((resolve, reject) => {
    const fallbackRelayUrl = 'wss://relay.nostr.band';
    const ws = new WebSocket(fallbackRelayUrl);
    let hasClosed = false;

    const closeWebSocket = (subscriptionId: string | null) => {
      if (!hasClosed && ws.readyState === WebSocket.OPEN) {
        if (subscriptionId) {
          ws.send(JSON.stringify(["CLOSE", subscriptionId]));
        }
        ws.close();
        hasClosed = true;
        console.log('WebSocket connection to fallback relay closed');
      }
    };

    ws.addEventListener('open', () => {
      console.log("WebSocket connection to fallback relay opened.");
      const subscriptionId = Math.random().toString(36).substr(2, 9);
      const filters = {
        kinds: [0],
        authors: [pubkey],
        limit: 1
      };
      const reqMessage = JSON.stringify(["REQ", subscriptionId, filters]);
      ws.send(reqMessage);
    });

    ws.addEventListener('message', event => {
      try {
        // @ts-ignore - Cloudflare Workers WebSocket event has data property
        const message = JSON.parse(event.data) as NostrMessage;

        // Handle EVENT message
        if (message[0] === "EVENT" && message[1]) {
          const eventData = message[2];
          if (eventData.kind === 0 && eventData.pubkey === pubkey) {
            console.log("Received kind 0 event from fallback relay.");
            closeWebSocket(message[1]);
            resolve(eventData);
          }
        }

        // Handle EOSE message
        else if (message[0] === "EOSE") {
          console.log("EOSE received from fallback relay, no kind 0 event found.");
          closeWebSocket(message[1]);
          resolve(null);
        }
      } catch (error) {
        console.error(`Error processing fallback relay event for pubkey ${pubkey}: ${error}`);
        reject(error);
      }
    });

    ws.addEventListener('error', (error: Event) => {
      console.error(`WebSocket error with fallback relay:`, error);
      ws.close();
      hasClosed = true;
      reject(error);
    });

    ws.addEventListener('close', () => {
      hasClosed = true;
      console.log('Fallback relay WebSocket connection closed.');
    });

    setTimeout(() => {
      if (!hasClosed) {
        console.log('Timeout reached. Closing WebSocket connection to fallback relay.');
        closeWebSocket(null);
        reject(new Error(`No response from fallback relay for pubkey ${pubkey}`));
      }
    }, 5000);
  });
}

// Fetch kind 0 event for pubkey
async function fetchKind0EventForPubkey(pubkey: string, env: Env): Promise<NostrEvent | null> {
  try {
    const filters = [{ kinds: [0], authors: [pubkey], limit: 1 }];
    const result = await queryEvents(filters, 'first-unconstrained', env);

    if (result.events && result.events.length > 0) {
      return result.events[0];
    }

    // If no event found from local database, use fallback relay
    console.log(`No kind 0 event found locally, trying fallback relay: wss://relay.nostr.band`);
    const fallbackEvent = await fetchEventFromFallbackRelay(pubkey);
    if (fallbackEvent) {
      return fallbackEvent;
    }
  } catch (error) {
    console.error(`Error fetching kind 0 event for pubkey ${pubkey}: ${error}`);
  }

  return null;
}

// NIP-05 validation
async function validateNIP05FromKind0(pubkey: string, env: Env): Promise<boolean> {
  try {
    // Fetch kind 0 event for the pubkey
    const metadataEvent = await fetchKind0EventForPubkey(pubkey, env);

    if (!metadataEvent) {
      console.error(`No kind 0 metadata event found for pubkey: ${pubkey}`);
      return false;
    }

    const metadata = JSON.parse(metadataEvent.content);
    const nip05Address = metadata.nip05;

    if (!nip05Address) {
      console.error(`No NIP-05 address found in kind 0 for pubkey: ${pubkey}`);
      return false;
    }

    // Validate the NIP-05 address
    const isValid = await validateNIP05(nip05Address, pubkey);
    return isValid;

  } catch (error) {
    console.error(`Error validating NIP-05 for pubkey ${pubkey}: ${error}`);
    return false;
  }
}

async function validateNIP05(nip05Address: string, pubkey: string): Promise<boolean> {
  try {
    const [name, domain] = nip05Address.split('@');

    if (!domain) {
      throw new Error(`Invalid NIP-05 address format: ${nip05Address}`);
    }

    // Check blocked/allowed domains
    if (blockedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is blocked: ${domain}`);
      return false;
    }

    if (allowedNip05Domains.size > 0 && !allowedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is not allowed: ${domain}`);
      return false;
    }

    // Fetch the NIP-05 data
    const url = `https://${domain}/.well-known/nostr.json?name=${name}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`Failed to fetch NIP-05 data from ${url}: ${response.statusText}`);
      return false;
    }

    const nip05Data = await response.json() as Nip05Response;

    if (!nip05Data.names || !nip05Data.names[name]) {
      console.error(`NIP-05 data does not contain a matching public key for ${name}`);
      return false;
    }

    const nip05Pubkey = nip05Data.names[name];
    return nip05Pubkey === pubkey;

  } catch (error) {
    console.error(`Error validating NIP-05 address: ${error}`);
    return false;
  }
}

// Query complexity calculation
function calculateQueryComplexity(filter: NostrFilter): number {
  let complexity = 0;

  // Base complexity
  complexity += (filter.ids?.length || 0) * 1;
  complexity += (filter.authors?.length || 0) * 2;
  complexity += (filter.kinds?.length || 0) * 5;

  // Tag filters are expensive
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) {
      complexity += values.length * 10;
    }
  }

  // No time bounds is very expensive
  if (!filter.since && !filter.until) {
    complexity *= 2;
  }

  // Large limits are expensive
  if ((filter.limit || 0) > 1000) {
    complexity *= 1.5;
  }

  return complexity;
}

// Event processing
async function processEvent(event: NostrEvent, sessionId: string, env: Env): Promise<{ success: boolean; message: string }> {
  try {
    // Check cache for duplicate event ID
    const existingEvent = await env.RELAY_DATABASE.withSession('first-unconstrained')
      .prepare("SELECT id FROM events WHERE id = ? LIMIT 1")
      .bind(event.id)
      .first();

    if (existingEvent) {
      console.log(`Duplicate event detected: ${event.id}`);
      return { success: false, message: "duplicate: already have this event" };
    }

    // NIP-05 validation if enabled (bypassed for kind 1059)
    if (event.kind !== 1059 && checkValidNip05 && event.kind !== 0) {
      const isValidNIP05 = await validateNIP05FromKind0(event.pubkey, env);
      if (!isValidNIP05) {
        console.error(`Event denied. NIP-05 validation failed for pubkey ${event.pubkey}.`);
        return { success: false, message: "invalid: NIP-05 validation failed" };
      }
    }

    // Handle deletion events
    if (event.kind === 5) {
      return await processDeletionEvent(event, env);
    }

    // Save event
    const saveResult = await saveEventToD1(event, env);
    return saveResult;

  } catch (error: any) {
    console.error(`Error processing event: ${error.message}`);
    return { success: false, message: `error: ${error.message}` };
  }
}

// Helper function to check if event kind is replaceable
function isReplaceableKind(kind: number): boolean {
  // Regular replaceable: 0, 3, and 10000-19999
  if (kind === 0 || kind === 3) return true;
  if (kind >= 10000 && kind < 20000) return true;
  // Parameterized replaceable: 30000-39999 (requires 'd' tag matching)
  if (kind >= 30000 && kind < 40000) return true;
  return false;
}

async function saveEventToD1(event: NostrEvent, env: Env): Promise<{ success: boolean; message: string }> {
  try {
    const session = env.RELAY_DATABASE.withSession('first-primary');

    // Check for duplicate content (only if anti-spam is enabled)
    if (shouldCheckForDuplicates(event.kind)) {
      const contentHash = await hashContent(event);
      const duplicateCheck = enableGlobalDuplicateCheck
        ? await session.prepare("SELECT event_id FROM content_hashes WHERE hash = ? LIMIT 1").bind(contentHash).first()
        : await session.prepare("SELECT event_id FROM content_hashes WHERE hash = ? AND pubkey = ? LIMIT 1").bind(contentHash, event.pubkey).first();

      if (duplicateCheck) {
        return { success: false, message: "duplicate: content already exists" };
      }
    }

    // Handle replaceable events (NIP-01)
    if (isReplaceableKind(event.kind)) {
      // For parameterized replaceable events (30000-39999), match on 'd' tag too
      const isParameterized = event.kind >= 30000 && event.kind < 40000;

      if (isParameterized) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';

        // Check for existing event with same pubkey, kind, and d tag
        const existing = await session.prepare(`
          SELECT id, created_at, tags FROM events
          WHERE pubkey = ? AND kind = ?
          ORDER BY created_at DESC LIMIT 1
        `).bind(event.pubkey, event.kind).first();

        if (existing) {
          const existingTags = JSON.parse(existing.tags as string);
          const existingDTag = existingTags.find((t: string[]) => t[0] === 'd')?.[1] || '';

          // Only replace if d tag matches
          if (existingDTag === dTag) {
            if ((existing.created_at as number) > event.created_at) {
              return { success: false, message: "duplicate: newer event already exists" };
            }
            // Delete older event
            await session.prepare(`DELETE FROM events WHERE id = ?`).bind(existing.id).run();
          }
        }
      } else {
        // Regular replaceable events (0, 3, 10000-19999)
        const existing = await session.prepare(`
          SELECT id, created_at FROM events
          WHERE pubkey = ? AND kind = ?
          ORDER BY created_at DESC LIMIT 1
        `).bind(event.pubkey, event.kind).first();

        if (existing) {
          if ((existing.created_at as number) > event.created_at) {
            return { success: false, message: "duplicate: newer event already exists" };
          }
          // Delete older event
          await session.prepare(`DELETE FROM events WHERE id = ?`).bind(existing.id).run();
        }
      }
    }

    // Insert the main event
    await session.prepare(`
      INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig).run();

    // Process tags in chunks
    const tagInserts = [];
    let tagP = null, tagE = null, tagA = null;

    for (const tag of event.tags) {
      const tagName = tag[0];
      if (!tagName) continue;

      // Store ALL values from the tag array (important for imeta and other multi-value tags)
      // For example: ["imeta", "url https://...", "m video/mp4", "dim 1920x1080", ...]
      for (let i = 1; i < tag.length; i++) {
        if (tag[i]) {
          tagInserts.push({ tag_name: tagName, tag_value: tag[i] });
        }
      }

      // Capture common tags for cache (first value only)
      if (tagName === 'p' && !tagP && tag[1]) tagP = tag[1];
      if (tagName === 'e' && !tagE && tag[1]) tagE = tag[1];
      if (tagName === 'a' && !tagA && tag[1]) tagA = tag[1];
    }

    // Insert tags in chunks of 50
    for (let i = 0; i < tagInserts.length; i += 50) {
      const chunk = tagInserts.slice(i, i + 50);
      const batch = chunk.map(t =>
        session.prepare(`
          INSERT INTO tags (event_id, tag_name, tag_value)
          VALUES (?, ?, ?)
        `).bind(event.id, t.tag_name, t.tag_value)
      );

      if (batch.length > 0) {
        await session.batch(batch);
      }
    }

    // Update event tags cache for common tags
    if (tagP || tagE || tagA) {
      await session.prepare(`
        INSERT INTO event_tags_cache (event_id, pubkey, kind, created_at, tag_p, tag_e, tag_a)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          tag_p = excluded.tag_p,
          tag_e = excluded.tag_e,
          tag_a = excluded.tag_a
      `).bind(event.id, event.pubkey, event.kind, event.created_at, tagP, tagE, tagA).run();
    }

    // Insert content hash separately (only if anti-spam is enabled)
    if (shouldCheckForDuplicates(event.kind)) {
      const contentHash = await hashContent(event);
      await session.prepare(`
        INSERT INTO content_hashes (hash, event_id, pubkey, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(contentHash, event.id, event.pubkey, event.created_at).run();
    }

    // Populate videos table for kind 34236 (video events)
    if (event.kind === 34236) {
      try {
        // Extract metrics from tags
        const getTagValue = (tagName: string): number => {
          const tag = event.tags.find(t => t[0] === tagName);
          return tag && tag[1] ? parseInt(tag[1], 10) || 0 : 0;
        };

        const loopCount = getTagValue('loops');
        const likes = getTagValue('likes');
        const comments = getTagValue('comments');
        const reposts = getTagValue('reposts');
        const views = getTagValue('views');

        // Extract first hashtag (from 't' tags)
        const tTags = event.tags.filter(t => t[0] === 't');
        const hashtag = tTags.length > 0 ? tTags[0][1] : null;

        // Extract ProofMode verification tags
        const verificationTag = event.tags.find(t => t[0] === 'verification');
        const proofmodeTag = event.tags.find(t => t[0] === 'proofmode');
        const deviceAttestationTag = event.tags.find(t => t[0] === 'device_attestation');
        const pgpFingerprintTag = event.tags.find(t => t[0] === 'pgp_fingerprint');

        // Determine verification level and flags
        const verificationLevel = verificationTag?.[1] || null;
        const hasProofmode = proofmodeTag ? 1 : 0;
        const hasDeviceAttestation = deviceAttestationTag ? 1 : 0;
        const hasPgpSignature = pgpFingerprintTag ? 1 : 0;

        // Upsert into videos table (no foreign key constraint to avoid issues)
        await session.prepare(`
          INSERT INTO videos (
            event_id, author, created_at, loop_count, likes, comments, reposts, views, avg_completion, hashtag,
            verification_level, has_proofmode, has_device_attestation, has_pgp_signature
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            loop_count = excluded.loop_count,
            likes = excluded.likes,
            comments = excluded.comments,
            reposts = excluded.reposts,
            views = excluded.views,
            hashtag = excluded.hashtag,
            verification_level = excluded.verification_level,
            has_proofmode = excluded.has_proofmode,
            has_device_attestation = excluded.has_device_attestation,
            has_pgp_signature = excluded.has_pgp_signature
        `).bind(
          event.id, event.pubkey, event.created_at, loopCount, likes, comments, reposts, views, hashtag,
          verificationLevel, hasProofmode, hasDeviceAttestation, hasPgpSignature
        ).run();

        console.log(`Video metrics saved for event ${event.id}`);

        // Extract and store #t tags (hashtags) in video_hashtags junction table
        const uniqueTTags = [...new Set(tTags.map(t => t[1]).filter(h => h))]; // Deduplicate and filter empty

        // Delete existing hashtags first (since kind 34236 is replaceable, tags can change)
        await session.prepare(`
          DELETE FROM video_hashtags WHERE event_id = ?
        `).bind(event.id).run();

        // Insert new hashtags
        for (const tag of uniqueTTags) {
          await session.prepare(`
            INSERT INTO video_hashtags (event_id, hashtag)
            VALUES (?, ?)
            ON CONFLICT DO NOTHING
          `).bind(event.id, tag).run();
        }

        if (uniqueTTags.length > 0) {
          console.log(`Stored ${uniqueTTags.length} #t tag(s) for event ${event.id}`);
        }

        // Extract and store #p tags (mentions) in video_mentions junction table
        const pTags = event.tags.filter(t => t[0] === 'p' && t[1]);
        const uniquePTags = [...new Set(pTags.map(t => t[1]))]; // Deduplicate

        for (const pubkey of uniquePTags) {
          await session.prepare(`
            INSERT INTO video_mentions (event_id, pubkey)
            VALUES (?, ?)
            ON CONFLICT DO NOTHING
          `).bind(event.id, pubkey).run();
        }

        if (uniquePTags.length > 0) {
          console.log(`Stored ${uniquePTags.length} #p tag(s) for event ${event.id}`);
        }

        // Extract and store #e tags (references) in video_references junction table
        const eTags = event.tags.filter(t => t[0] === 'e' && t[1]);
        const uniqueETags = [...new Set(eTags.map(t => t[1]))]; // Deduplicate

        for (const refEventId of uniqueETags) {
          await session.prepare(`
            INSERT INTO video_references (event_id, referenced_event_id)
            VALUES (?, ?)
            ON CONFLICT DO NOTHING
          `).bind(event.id, refEventId).run();
        }

        if (uniqueETags.length > 0) {
          console.log(`Stored ${uniqueETags.length} #e tag(s) for event ${event.id}`);
        }

        // Extract and store #a tags (addresses) in video_addresses junction table
        const aTags = event.tags.filter(t => t[0] === 'a' && t[1]);
        const uniqueATags = [...new Set(aTags.map(t => t[1]))]; // Deduplicate

        for (const address of uniqueATags) {
          await session.prepare(`
            INSERT INTO video_addresses (event_id, address)
            VALUES (?, ?)
            ON CONFLICT DO NOTHING
          `).bind(event.id, address).run();
        }

        if (uniqueATags.length > 0) {
          console.log(`Stored ${uniqueATags.length} #a tag(s) for event ${event.id}`);
        }

      } catch (videoError: any) {
        // Don't fail the whole event if video metrics fail
        console.error(`Error saving video metrics for ${event.id}:`, videoError.message);
      }
    }

    // Index user profile for search (kind 0)
    if (event.kind === 0) {
      await indexUserProfile(env.RELAY_DATABASE, event);
    }

    // Index note for search (kind 1)
    if (event.kind === 1) {
      await indexNote(env.RELAY_DATABASE, event);
    }

    // Index video for search (kind 34236)
    if (event.kind === 34236) {
      await indexVideo(env.RELAY_DATABASE, event);
    }

    // Index lists for search (kinds 30000-30003)
    if (event.kind >= 30000 && event.kind <= 30003) {
      await indexList(env.RELAY_DATABASE, event);
    }

    // Index articles for search (kind 30023)
    if (event.kind === 30023) {
      await indexArticle(env.RELAY_DATABASE, event);
    }

    // Index communities for search (kind 34550)
    if (event.kind === 34550) {
      await indexCommunity(env.RELAY_DATABASE, event);
    }

    // Index hashtags for search (all event kinds with #t tags)
    await indexHashtags(env.RELAY_DATABASE, event);

    console.log(`Event ${event.id} saved successfully to D1.`);
    return { success: true, message: "Event received successfully for processing" };

  } catch (error: any) {
    console.error(`Error saving event: ${error.message}`);
    console.error(`Event details: ID=${event.id}, Tags count=${event.tags.length}`);
    return { success: false, message: "error: could not save event" };
  }
}

// Helper function for kind 5
async function processDeletionEvent(event: NostrEvent, env: Env): Promise<{ success: boolean; message: string }> {
  console.log(`Processing deletion event ${event.id}`);
  const deletedEventIds = event.tags.filter(tag => tag[0] === "e").map(tag => tag[1]);

  if (deletedEventIds.length === 0) {
    return { success: true, message: "No events to delete" };
  }

  const session = env.RELAY_DATABASE.withSession('first-primary');
  let deletedCount = 0;
  const errors: string[] = [];

  for (const eventId of deletedEventIds) {
    try {
      // First check if the event exists and belongs to the requesting pubkey
      const existing = await session.prepare(
        "SELECT pubkey FROM events WHERE id = ? LIMIT 1"
      ).bind(eventId).first();

      if (!existing) {
        console.warn(`Event ${eventId} not found. Nothing to delete.`);
        continue;
      }

      if (existing.pubkey !== event.pubkey) {
        console.warn(`Event ${eventId} does not belong to pubkey ${event.pubkey}. Skipping deletion.`);
        errors.push(`unauthorized: cannot delete event ${eventId} - wrong pubkey`);
        continue;
      }

      // Delete associated tags first (due to foreign key constraint)
      await session.prepare(
        "DELETE FROM tags WHERE event_id = ?"
      ).bind(eventId).run();

      // Delete from content_hashes if exists
      await session.prepare(
        "DELETE FROM content_hashes WHERE event_id = ?"
      ).bind(eventId).run();

      // Delete from event_tags_cache
      await session.prepare(
        "DELETE FROM event_tags_cache WHERE event_id = ?"
      ).bind(eventId).run();

      // Now delete the event
      const result = await session.prepare(
        "DELETE FROM events WHERE id = ?"
      ).bind(eventId).run();

      if (result.meta.changes > 0) {
        console.log(`Event ${eventId} deleted successfully.`);
        deletedCount++;
      }
    } catch (error) {
      console.error(`Error deleting event ${eventId}:`, error);
      errors.push(`error deleting ${eventId}`);
    }
  }

  // Save the deletion event itself
  await saveEventToD1(event, env);

  if (errors.length > 0) {
    return { success: false, message: errors[0] };
  }

  return {
    success: true,
    message: deletedCount > 0 ? `Successfully deleted ${deletedCount} event(s)` : "No matching events found to delete"
  };
}

// Helper function to chunk arrays
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Query builder
function buildQuery(filter: NostrFilter): { sql: string; params: any[] } {
  const params: any[] = [];
  const conditions: string[] = [];

  // Count and categorize tag filters
  let tagCount = 0;
  const cacheableTags: Array<{ name: string; values: string[] }> = [];
  const otherTags: Array<{ name: string; values: string[] }> = [];

  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      tagCount += values.length;
      const tagName = key.substring(1);

      // Check if this is a cacheable tag (p, e, or a)
      if (['p', 'e', 'a'].includes(tagName)) {
        cacheableTags.push({ name: tagName, values });
      } else {
        otherTags.push({ name: tagName, values });
      }
    }
  }

  // Only cacheable tags (p, e, a) - use event_tags_cache
  if (cacheableTags.length > 0 && otherTags.length === 0) {
    let sql = "SELECT e.* FROM events e INNER JOIN event_tags_cache c ON e.id = c.event_id";
    const whereConditions: string[] = [];

    for (const tagFilter of cacheableTags) {
      const tagColumn = `tag_${tagFilter.name}`;
      whereConditions.push(`c.${tagColumn} IN (${tagFilter.values.map(() => '?').join(',')})`);
      params.push(...tagFilter.values);
    }

    if (filter.ids && filter.ids.length > 0) {
      whereConditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    if (filter.authors && filter.authors.length > 0) {
      whereConditions.push(`c.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      whereConditions.push(`c.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }

    if (filter.since) {
      whereConditions.push("c.created_at >= ?");
      params.push(filter.since);
    }

    if (filter.until) {
      whereConditions.push("c.created_at <= ?");
      params.push(filter.until);
    }

    if (whereConditions.length > 0) {
      sql += " WHERE " + whereConditions.join(" AND ");
    }

    sql += " ORDER BY c.created_at DESC";
    sql += " LIMIT ?";
    params.push(Math.min(filter.limit || 1000, 5000));

    return { sql, params };
  }

  // Has any non-cacheable tags - use CTE with tags table
  if (tagCount > 0) {
    const tagConditions: string[] = [];
    const cteParams: any[] = [];

    // Include ALL tags in the CTE (both cacheable and non-cacheable)
    for (const tagFilter of [...cacheableTags, ...otherTags]) {
      tagConditions.push(`(tag_name = ? AND tag_value IN (${tagFilter.values.map(() => '?').join(',')}))`);
      cteParams.push(tagFilter.name, ...tagFilter.values);
    }

    let sql = `WITH matching_events AS (
      SELECT DISTINCT event_id 
      FROM tags 
      WHERE ${tagConditions.join(' OR ')}
    )
    SELECT e.* FROM events e
    INNER JOIN matching_events m ON e.id = m.event_id`;

    params.push(...cteParams);

    const whereConditions: string[] = [];

    if (filter.ids && filter.ids.length > 0) {
      whereConditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    if (filter.authors && filter.authors.length > 0) {
      whereConditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      whereConditions.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }

    if (filter.since) {
      whereConditions.push("e.created_at >= ?");
      params.push(filter.since);
    }

    if (filter.until) {
      whereConditions.push("e.created_at <= ?");
      params.push(filter.until);
    }

    if (whereConditions.length > 0) {
      sql += " WHERE " + whereConditions.join(" AND ");
    }

    sql += " ORDER BY e.created_at DESC";
    sql += " LIMIT ?";
    params.push(Math.min(filter.limit || 1000, 5000));

    return { sql, params };
  }

  // No tag filters - standard query with index hints
  let indexHint = "";

  const hasAuthors = filter.authors && filter.authors.length > 0;
  const hasKinds = filter.kinds && filter.kinds.length > 0;
  const hasTimeRange = filter.since || filter.until;
  const authorCount = filter.authors?.length || 0;
  const kindCount = filter.kinds?.length || 0;

  // Choose index based on query pattern
  if (hasAuthors && hasKinds && authorCount <= 10 && kindCount <= 10) {
    if (authorCount <= kindCount) {
      indexHint = " INDEXED BY idx_events_pubkey_kind_created_at";
    } else {
      indexHint = " INDEXED BY idx_events_kind_pubkey_created_at";
    }
  } else if (hasAuthors && authorCount <= 5 && !hasKinds) {
    indexHint = " INDEXED BY idx_events_pubkey_created_at";
  } else if (hasKinds && kindCount <= 5 && !hasAuthors) {
    indexHint = " INDEXED BY idx_events_kind_created_at";
  } else if (hasAuthors && hasKinds && authorCount > 10) {
    indexHint = " INDEXED BY idx_events_kind_created_at";
  } else if (!hasAuthors && !hasKinds && hasTimeRange) {
    indexHint = " INDEXED BY idx_events_created_at";
  }

  let sql = `SELECT * FROM events${indexHint}`;

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
    params.push(...filter.ids);
  }

  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
    params.push(...filter.authors);
  }

  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }

  if (filter.since) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }

  if (filter.until) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY created_at DESC";
  sql += " LIMIT ?";
  params.push(Math.min(filter.limit || 1000, 5000));

  return { sql, params };
}

// Helper function to handle chunked queries
async function queryDatabaseChunked(filter: NostrFilter, bookmark: string, env: Env): Promise<{ events: NostrEvent[] }> {
  const session = env.RELAY_DATABASE.withSession(bookmark);
  const allEvents = new Map<string, NostrEvent>();

  const CHUNK_SIZE = 50;

  // Create a base filter with everything except the large arrays
  const baseFilter: NostrFilter = { ...filter };
  const needsChunking = {
    ids: false,
    authors: false,
    kinds: false,
    tags: {} as Record<string, boolean>
  };

  // Identify what needs chunking and remove from base filter
  if (filter.ids && filter.ids.length > CHUNK_SIZE) {
    needsChunking.ids = true;
    delete baseFilter.ids;
  }

  if (filter.authors && filter.authors.length > CHUNK_SIZE) {
    needsChunking.authors = true;
    delete baseFilter.authors;
  }

  if (filter.kinds && filter.kinds.length > CHUNK_SIZE) {
    needsChunking.kinds = true;
    delete baseFilter.kinds;
  }

  // Check tag filters
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > CHUNK_SIZE) {
      needsChunking.tags[key] = true;
      delete baseFilter[key];
    }
  }

  // Helper function to process string array chunks
  const processStringChunks = async (filterType: 'ids' | 'authors' | string, values: string[]) => {
    const chunks = chunkArray(values, CHUNK_SIZE);

    for (const chunk of chunks) {
      const chunkFilter = { ...baseFilter };

      if (filterType === 'ids') {
        chunkFilter.ids = chunk;
      } else if (filterType === 'authors') {
        chunkFilter.authors = chunk;
      } else if (filterType.startsWith('#')) {
        chunkFilter[filterType] = chunk;
      }

      const query = buildQuery(chunkFilter);

      try {
        const result = await session.prepare(query.sql)
          .bind(...query.params)
          .all();

        for (const row of result.results) {
          const event: NostrEvent = {
            id: row.id as string,
            pubkey: row.pubkey as string,
            created_at: row.created_at as number,
            kind: row.kind as number,
            tags: JSON.parse(row.tags as string),
            content: row.content as string,
            sig: row.sig as string
          };
          allEvents.set(event.id, event);
        }
      } catch (error) {
        console.error(`Error in chunk query: ${error}`);
      }
    }
  };

  // Helper function to process number array chunks
  const processNumberChunks = async (filterType: 'kinds', values: number[]) => {
    const chunks = chunkArray(values, CHUNK_SIZE);

    for (const chunk of chunks) {
      const chunkFilter = { ...baseFilter };
      chunkFilter.kinds = chunk;

      const query = buildQuery(chunkFilter);

      try {
        const result = await session.prepare(query.sql)
          .bind(...query.params)
          .all();

        for (const row of result.results) {
          const event: NostrEvent = {
            id: row.id as string,
            pubkey: row.pubkey as string,
            created_at: row.created_at as number,
            kind: row.kind as number,
            tags: JSON.parse(row.tags as string),
            content: row.content as string,
            sig: row.sig as string
          };
          allEvents.set(event.id, event);
        }
      } catch (error) {
        console.error(`Error in chunk query: ${error}`);
      }
    }
  };

  // Process each filter type that needs chunking
  if (needsChunking.ids && filter.ids) {
    await processStringChunks('ids', filter.ids);
  }

  if (needsChunking.authors && filter.authors) {
    await processStringChunks('authors', filter.authors);
  }

  if (needsChunking.kinds && filter.kinds) {
    await processNumberChunks('kinds', filter.kinds);
  }

  // Process tag filters
  for (const [tagKey, _] of Object.entries(needsChunking.tags)) {
    const tagValues = filter[tagKey];
    if (Array.isArray(tagValues) && tagValues.every((v: any) => typeof v === 'string')) {
      await processStringChunks(tagKey, tagValues as string[]);
    }
  }

  // If nothing needed chunking, just run the query as-is
  if (!needsChunking.ids && !needsChunking.authors && !needsChunking.kinds && Object.keys(needsChunking.tags).length === 0) {
    const query = buildQuery(filter);

    try {
      const result = await session.prepare(query.sql)
        .bind(...query.params)
        .all();

      for (const row of result.results) {
        const event: NostrEvent = {
          id: row.id as string,
          pubkey: row.pubkey as string,
          created_at: row.created_at as number,
          kind: row.kind as number,
          tags: JSON.parse(row.tags as string),
          content: row.content as string,
          sig: row.sig as string
        };
        allEvents.set(event.id, event);
      }
    } catch (error) {
      console.error(`Error in query: ${error}`);
    }
  }

  const events = Array.from(allEvents.values());
  console.log(`Found ${events.length} events (chunked)`);

  return { events };
}

// Query handling
async function queryEvents(filters: NostrFilter[], bookmark: string, env: Env): Promise<QueryResult> {
  try {
    console.log(`Processing query with ${filters.length} filters and bookmark: ${bookmark}`);
    const session = env.RELAY_DATABASE.withSession(bookmark);
    const eventSet = new Map<string, NostrEvent>();

    let totalEventsRead = 0;

    for (const filter of filters) {
      // Skip if we've already hit the global limit
      if (totalEventsRead >= GLOBAL_MAX_EVENTS) {
        console.warn(`Global event limit reached (${GLOBAL_MAX_EVENTS}), stopping query`);
        break;
      }

      // Check query complexity
      const complexity = calculateQueryComplexity(filter);
      if (complexity > MAX_QUERY_COMPLEXITY) {
        console.warn(`Query too complex (complexity: ${complexity}), skipping filter`);
        continue;
      }

      // For filters with no time bounds and broad criteria, add default time window
      // DISABLED: We need to support old Vine videos from 2013-2017 with original timestamps
      // if (!filter.since && !filter.until) {
      //   // Default to last 7 days for unbounded queries
      //   const sevenDaysAgo = Math.floor(Date.now() / 1000) - (DEFAULT_TIME_WINDOW_DAYS * 24 * 60 * 60);
      //   filter.since = sevenDaysAgo;
      //   console.log(`Added default ${DEFAULT_TIME_WINDOW_DAYS}-day time bound to unbounded query`);
      // }

      // Check if any array in the filter exceeds chunk size
      const needsChunking = (
        (filter.ids && filter.ids.length > 50) ||
        (filter.authors && filter.authors.length > 50) ||
        (filter.kinds && filter.kinds.length > 50) ||
        Object.entries(filter).some(([key, values]) =>
          key.startsWith('#') && Array.isArray(values) && values.length > 50
        )
      );

      if (needsChunking) {
        console.log(`Filter has arrays >50 items, using chunked query...`);
        const chunkedResult = await queryDatabaseChunked(filter, bookmark, env);
        for (const event of chunkedResult.events) {
          if (totalEventsRead >= GLOBAL_MAX_EVENTS) break;
          eventSet.set(event.id, event);
          totalEventsRead++;
        }
        continue;
      }

      // Build and execute the query
      const query = buildQuery(filter);

      try {
        const result = await session.prepare(query.sql).bind(...query.params).all();

        // Log query metadata
        if (result.meta) {
          console.log({
            servedByRegion: result.meta.served_by_region ?? "",
            servedByPrimary: result.meta.served_by_primary ?? false,
            rowsRead: result.results.length
          });
        }

        for (const row of result.results) {
          if (totalEventsRead >= GLOBAL_MAX_EVENTS) break;

          const event: NostrEvent = {
            id: row.id as string,
            pubkey: row.pubkey as string,
            created_at: row.created_at as number,
            kind: row.kind as number,
            tags: JSON.parse(row.tags as string),
            content: row.content as string,
            sig: row.sig as string
          };
          eventSet.set(event.id, event);
          totalEventsRead++;
        }
      } catch (error: any) {
        console.error(`Query execution error: ${error.message}`);
        throw error;
      }
    }

    const events = Array.from(eventSet.values()).sort((a, b) => {
      if (b.created_at !== a.created_at) {
        return b.created_at - a.created_at;
      }
      return a.id.localeCompare(b.id);
    });

    const newBookmark = session.getBookmark();
    console.log(`Found ${events.length} events. New bookmark: ${newBookmark}`);
    return { events, bookmark: newBookmark };

  } catch (error: any) {
    console.error(`Error querying events: ${error.message}`);
    return { events: [], bookmark: null };
  }
}

// Archive functions with hourly partitions
async function archiveOldEvents(db: D1Database, r2: R2Bucket): Promise<void> {
  const cutoffTime = Math.floor(Date.now() / 1000) - (ARCHIVE_RETENTION_DAYS * 24 * 60 * 60);

  console.log(`Archiving events older than ${new Date(cutoffTime * 1000).toISOString()}`);

  // Load existing manifest
  let manifest: ArchiveManifest;
  try {
    const manifestObj = await r2.get('manifest.json');
    if (manifestObj) {
      const data = JSON.parse(await manifestObj.text());
      // Convert arrays back to Sets when loading
      manifest = {
        ...data,
        indices: {
          authors: new Set(data.indices?.authors || []),
          kinds: new Set(data.indices?.kinds || []),
          tags: {} // Initialize empty, will populate below
        }
      };

      // Convert tag arrays back to Sets
      if (data.indices?.tags) {
        for (const [tagName, tagValues] of Object.entries(data.indices.tags)) {
          manifest.indices.tags[tagName] = new Set(tagValues as string[]);
        }
      }
    } else {
      manifest = {
        lastUpdated: new Date().toISOString(),
        hoursWithEvents: [],
        firstHour: '',
        lastHour: '',
        totalEvents: 0,
        indices: {
          authors: new Set(),
          kinds: new Set(),
          tags: {}
        }
      };
    }
  } catch (e) {
    console.log('Creating new manifest...');
    manifest = {
      lastUpdated: new Date().toISOString(),
      hoursWithEvents: [],
      firstHour: '',
      lastHour: '',
      totalEvents: 0,
      indices: {
        authors: new Set(),
        kinds: new Set(),
        tags: {}
      }
    };
  }

  let offset = 0;
  let hasMore = true;
  let totalArchived = 0;

  while (hasMore) {
    const session = db.withSession('first-unconstrained');

    // Get batch of old events
    const oldEvents = await session.prepare(`
      SELECT * FROM events 
      WHERE created_at < ?
      ORDER BY created_at
      LIMIT ?
      OFFSET ?
    `).bind(cutoffTime, ARCHIVE_BATCH_SIZE, offset).all();

    if (!oldEvents.results || oldEvents.results.length === 0) {
      hasMore = false;
      break;
    }

    // Process events for archiving
    const eventsByHour = new Map<string, NostrEvent[]>();
    const eventsByAuthorHour = new Map<string, NostrEvent[]>();
    const eventsByKindHour = new Map<string, NostrEvent[]>();
    const eventsByTagHour = new Map<string, NostrEvent[]>();

    for (const event of oldEvents.results) {
      const date = new Date(event.created_at as number * 1000);
      const hourKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCHours()).padStart(2, '0')}`;

      // Get tags for this event
      const tags = await session.prepare(
        'SELECT tag_name, tag_value FROM tags WHERE event_id = ?'
      ).bind(event.id as string).all();

      const formattedTags: string[][] = [];
      const tagMap: Record<string, string[]> = {};

      for (const tag of tags.results || []) {
        if (!tagMap[tag.tag_name as string]) {
          tagMap[tag.tag_name as string] = [];
        }
        tagMap[tag.tag_name as string].push(tag.tag_value as string);
      }

      for (const [name, values] of Object.entries(tagMap)) {
        formattedTags.push([name, ...values]);
      }

      const nostrEvent: NostrEvent = {
        id: event.id as string,
        pubkey: event.pubkey as string,
        created_at: event.created_at as number,
        kind: event.kind as number,
        tags: formattedTags,
        content: event.content as string,
        sig: event.sig as string
      };

      // Primary storage by hour
      if (!eventsByHour.has(hourKey)) {
        eventsByHour.set(hourKey, []);
      }
      eventsByHour.get(hourKey)!.push(nostrEvent);

      // Secondary index by author
      const authorHourKey = `${nostrEvent.pubkey}/${hourKey}`;
      if (!eventsByAuthorHour.has(authorHourKey)) {
        eventsByAuthorHour.set(authorHourKey, []);
      }
      eventsByAuthorHour.get(authorHourKey)!.push(nostrEvent);
      manifest.indices.authors.add(nostrEvent.pubkey);

      // Secondary index by kind
      const kindHourKey = `${nostrEvent.kind}/${hourKey}`;
      if (!eventsByKindHour.has(kindHourKey)) {
        eventsByKindHour.set(kindHourKey, []);
      }
      eventsByKindHour.get(kindHourKey)!.push(nostrEvent);
      manifest.indices.kinds.add(nostrEvent.kind);

      // Secondary indices by tags - FIXED SECTION
      for (const [tagName, ...tagValues] of formattedTags) {
        for (const tagValue of tagValues) {
          const tagKey = `${tagName}/${tagValue}/${hourKey}`;
          if (!eventsByTagHour.has(tagKey)) {
            eventsByTagHour.set(tagKey, []);
          }
          eventsByTagHour.get(tagKey)!.push(nostrEvent);

          // Update manifest - ensure it's a Set
          if (!manifest.indices.tags[tagName]) {
            manifest.indices.tags[tagName] = new Set();
          }
          // Now it's safe to use .add() because we know it's a Set
          (manifest.indices.tags[tagName] as Set<string>).add(tagValue);
        }
      }

      totalArchived++;
    }

    // Store primary data by hour
    for (const [hourKey, events] of eventsByHour) {
      const key = `events/${hourKey}.jsonl`;

      // Check if file exists
      let existingData = '';
      try {
        const existing = await r2.get(key);
        if (existing) {
          existingData = await existing.text() + '\n';
        }
      } catch (e) {
        // File doesn't exist
      }

      // Convert to JSON Lines
      const jsonLines = events.map(e => JSON.stringify(e)).join('\n');

      await r2.put(key, existingData + jsonLines, {
        customMetadata: {
          eventCount: String(events.length + (existingData ? existingData.split('\n').length - 1 : 0)),
          minCreatedAt: String(Math.min(...events.map(e => e.created_at))),
          maxCreatedAt: String(Math.max(...events.map(e => e.created_at)))
        }
      });

      if (!manifest.hoursWithEvents.includes(hourKey)) {
        manifest.hoursWithEvents.push(hourKey);
      }
    }

    // Store secondary indices
    // By author
    for (const [authorHourKey, events] of eventsByAuthorHour) {
      const [pubkey, hour] = authorHourKey.split('/');
      const key = `index/author/${pubkey}/${hour}.jsonl`;

      let existingData = '';
      try {
        const existing = await r2.get(key);
        if (existing) {
          existingData = await existing.text() + '\n';
        }
      } catch (e) { }

      const jsonLines = events.map(e => JSON.stringify(e)).join('\n');
      await r2.put(key, existingData + jsonLines);
    }

    // By kind
    for (const [kindHourKey, events] of eventsByKindHour) {
      const [kind, hour] = kindHourKey.split('/');
      const key = `index/kind/${kind}/${hour}.jsonl`;

      let existingData = '';
      try {
        const existing = await r2.get(key);
        if (existing) {
          existingData = await existing.text() + '\n';
        }
      } catch (e) { }

      const jsonLines = events.map(e => JSON.stringify(e)).join('\n');
      await r2.put(key, existingData + jsonLines);
    }

    // By tags
    for (const [tagKey, events] of eventsByTagHour) {
      const parts = tagKey.split('/');
      const tagName = parts[0];
      const tagValue = parts[1];
      const hour = `${parts[2]}/${parts[3]}`;
      const key = `index/tag/${tagName}/${tagValue}/${hour}.jsonl`;

      let existingData = '';
      try {
        const existing = await r2.get(key);
        if (existing) {
          existingData = await existing.text() + '\n';
        }
      } catch (e) { }

      const jsonLines = events.map(e => JSON.stringify(e)).join('\n');
      await r2.put(key, existingData + jsonLines);
    }

    // Store individual events by ID for direct lookups
    for (const event of oldEvents.results) {
      const eventId = event.id as string;
      const firstTwo = eventId.substring(0, 2);
      const key = `index/id/${firstTwo}/${eventId}.json`;

      // Get full event with tags
      const tags = await session.prepare(
        'SELECT tag_name, tag_value FROM tags WHERE event_id = ?'
      ).bind(eventId).all();

      const formattedTags: string[][] = [];
      const tagMap: Record<string, string[]> = {};

      for (const tag of tags.results || []) {
        if (!tagMap[tag.tag_name as string]) {
          tagMap[tag.tag_name as string] = [];
        }
        tagMap[tag.tag_name as string].push(tag.tag_value as string);
      }

      for (const [name, values] of Object.entries(tagMap)) {
        formattedTags.push([name, ...values]);
      }

      const nostrEvent: NostrEvent = {
        id: eventId,
        pubkey: event.pubkey as string,
        created_at: event.created_at as number,
        kind: event.kind as number,
        tags: formattedTags,
        content: event.content as string,
        sig: event.sig as string
      };

      await r2.put(key, JSON.stringify(nostrEvent));
    }

    // Delete from D1 (use primary session for writes)
    const writeSession = db.withSession('first-primary');
    const eventIds = oldEvents.results.map(e => e.id as string);

    for (let i = 0; i < eventIds.length; i += 100) {
      const chunk = eventIds.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');

      await writeSession.prepare(`DELETE FROM tags WHERE event_id IN (${placeholders})`).bind(...chunk).run();
      await writeSession.prepare(`DELETE FROM event_tags_cache WHERE event_id IN (${placeholders})`).bind(...chunk).run();
      await writeSession.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).bind(...chunk).run();
    }

    offset += ARCHIVE_BATCH_SIZE;
  }

  // Update manifest
  manifest.hoursWithEvents.sort();
  manifest.firstHour = manifest.hoursWithEvents[0] || '';
  manifest.lastHour = manifest.hoursWithEvents[manifest.hoursWithEvents.length - 1] || '';
  manifest.totalEvents += totalArchived;
  manifest.lastUpdated = new Date().toISOString();

  // Convert Sets to Arrays for JSON serialization
  const serializableManifest = {
    ...manifest,
    indices: {
      authors: Array.from(manifest.indices.authors),
      kinds: Array.from(manifest.indices.kinds),
      tags: Object.fromEntries(
        Object.entries(manifest.indices.tags).map(([k, v]) => [k, Array.from(v as Set<string>)])
      )
    }
  };

  await r2.put('manifest.json', JSON.stringify(serializableManifest, null, 2));

  console.log(`Archive process completed. Archived ${totalArchived} events.`);
}

// Query archive function with hourly partitions
async function queryArchive(filter: NostrFilter, hotDataCutoff: number, r2: R2Bucket): Promise<NostrEvent[]> {
  const results: NostrEvent[] = [];
  const processedEventIds = new Set<string>();

  // Load manifest
  let manifest: ArchiveManifest | null = null;
  try {
    const manifestObj = await r2.get('manifest.json');
    if (manifestObj) {
      const data = JSON.parse(await manifestObj.text());
      manifest = {
        ...data,
        indices: {
          authors: new Set(data.indices?.authors || []),
          kinds: new Set(data.indices?.kinds || []),
          tags: data.indices?.tags || {}
        }
      };
    }
  } catch (e) {
    console.warn('Failed to load archive manifest');
  }

  if (filter.ids && filter.ids.length > 0) {
    console.log(`Archive: Direct ID lookup for ${filter.ids.length} events`);

    for (const eventId of filter.ids) {
      const firstTwo = eventId.substring(0, 2);
      const key = `index/id/${firstTwo}/${eventId}.json`;

      try {
        const obj = await r2.get(key);
        if (obj) {
          const event = JSON.parse(await obj.text()) as NostrEvent;

          if (filter.since && event.created_at < filter.since) continue;
          if (filter.until && event.created_at > filter.until) continue;

          // Apply other filters
          if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
          if (filter.kinds && !filter.kinds.includes(event.kind)) continue;

          // Apply tag filters
          let matchesTags = true;
          for (const [key, values] of Object.entries(filter)) {
            if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
              const tagName = key.substring(1);
              const eventTagValues = event.tags
                .filter(tag => tag[0] === tagName)
                .map(tag => tag[1]);

              if (!values.some(v => eventTagValues.includes(v))) {
                matchesTags = false;
                break;
              }
            }
          }

          if (!matchesTags) continue;

          results.push(event);
          processedEventIds.add(event.id);
          console.log(`Archive: Found event ${eventId} in archive`);
        } else {
          console.log(`Archive: Event ${eventId} not found in archive`);
        }
      } catch (e) {
        console.log(`Archive: Error fetching event ${eventId}: ${e}`);
      }
    }

    // If this was purely a direct ID lookup, return early
    if (!filter.since && !filter.until && !filter.authors && !filter.kinds &&
      !Object.keys(filter).some(k => k.startsWith('#'))) {
      console.log(`Archive: Direct ID lookup complete, found ${results.length} events`);
      return results;
    }
  }

  if (filter.since && filter.since >= hotDataCutoff && !filter.ids) {
    console.log('Archive query skipped - filter.since is newer than archive cutoff');
    return results;
  }

  const startDate = filter.since ? new Date(Math.max(filter.since * 1000, 0)) : new Date(0);
  const endDate = filter.until ?
    new Date(Math.min(filter.until * 1000, hotDataCutoff * 1000)) :
    new Date(hotDataCutoff * 1000);

  const cappedEndDate = filter.ids ? endDate : new Date(Math.min(endDate.getTime(), hotDataCutoff * 1000));

  if (startDate >= cappedEndDate && !filter.ids) {
    console.log('Archive query skipped - date range does not overlap with archive');
    return results;
  }

  console.log(`Archive query range: ${startDate.toISOString()} to ${cappedEndDate.toISOString()}`);

  // Determine the most efficient index to use
  const useAuthorIndex = filter.authors && filter.authors.length <= 10;
  const useKindIndex = filter.kinds && filter.kinds.length <= 5;
  const useTagIndex = Object.entries(filter).some(([k, v]) =>
    k.startsWith('#') && Array.isArray(v) && v.length <= 10
  );

  // Generate list of hours to query
  const getHourKeys = (): string[] => {
    const hourKeys: string[] = [];
    const currentDate = new Date(startDate);

    while (currentDate <= cappedEndDate) {
      for (let hour = 0; hour < 24; hour++) {
        const hourKey = `${currentDate.getUTCFullYear()}-${String(currentDate.getUTCMonth() + 1).padStart(2, '0')}-${String(currentDate.getUTCDate()).padStart(2, '0')}/${String(hour).padStart(2, '0')}`;

        // Check if within our time range
        const hourTimestamp = new Date(currentDate);
        hourTimestamp.setUTCHours(hour);

        if (hourTimestamp >= startDate && hourTimestamp <= cappedEndDate) {
          if (!manifest || manifest.hoursWithEvents.includes(hourKey)) {
            hourKeys.push(hourKey);
          }
        }
      }
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return hourKeys;
  };

  // Use secondary indices if available
  if (useAuthorIndex && filter.authors) {
    // Query by author index
    for (const author of filter.authors) {
      for (const hourKey of getHourKeys()) {
        const key = `index/author/${author}/${hourKey}.jsonl`;

        try {
          const obj = await r2.get(key);
          if (obj) {
            const content = await obj.text();
            const lines = content.split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const event = JSON.parse(line) as NostrEvent;

                if (processedEventIds.has(event.id)) continue;

                // For time-based queries, ensure event is in archive range
                if (!filter.ids && event.created_at >= hotDataCutoff) continue;

                // Apply remaining filters
                if (filter.ids && !filter.ids.includes(event.id)) continue;
                if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
                if (filter.since && event.created_at < filter.since) continue;
                if (filter.until && event.created_at > filter.until) continue;

                // Apply tag filters
                let matchesTags = true;
                for (const [key, values] of Object.entries(filter)) {
                  if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
                    const tagName = key.substring(1);
                    const eventTagValues = event.tags
                      .filter(tag => tag[0] === tagName)
                      .map(tag => tag[1]);

                    if (!values.some(v => eventTagValues.includes(v))) {
                      matchesTags = false;
                      break;
                    }
                  }
                }

                if (!matchesTags) continue;

                results.push(event);
                processedEventIds.add(event.id);
              } catch (e) {
                console.error('Failed to parse archive event:', e);
              }
            }
          }
        } catch (e) {
          // File doesn't exist
        }
      }
    }
  } else if (useKindIndex && filter.kinds) {
    // Query by kind index
    for (const kind of filter.kinds) {
      for (const hourKey of getHourKeys()) {
        const key = `index/kind/${kind}/${hourKey}.jsonl`;

        try {
          const obj = await r2.get(key);
          if (obj) {
            const content = await obj.text();
            const lines = content.split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const event = JSON.parse(line) as NostrEvent;

                if (processedEventIds.has(event.id)) continue;

                // For time-based queries, ensure event is in archive range
                if (!filter.ids && event.created_at >= hotDataCutoff) continue;

                // Apply remaining filters
                if (filter.ids && !filter.ids.includes(event.id)) continue;
                if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
                if (filter.since && event.created_at < filter.since) continue;
                if (filter.until && event.created_at > filter.until) continue;

                // Apply tag filters
                let matchesTags = true;
                for (const [key, values] of Object.entries(filter)) {
                  if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
                    const tagName = key.substring(1);
                    const eventTagValues = event.tags
                      .filter(tag => tag[0] === tagName)
                      .map(tag => tag[1]);

                    if (!values.some(v => eventTagValues.includes(v))) {
                      matchesTags = false;
                      break;
                    }
                  }
                }

                if (!matchesTags) continue;

                results.push(event);
                processedEventIds.add(event.id);
              } catch (e) {
                console.error('Failed to parse archive event:', e);
              }
            }
          }
        } catch (e) {
          // File doesn't exist
        }
      }
    }
  } else if (useTagIndex) {
    // Query by tag index
    for (const [filterKey, filterValues] of Object.entries(filter)) {
      if (filterKey.startsWith('#') && Array.isArray(filterValues) && filterValues.length > 0) {
        const tagName = filterKey.substring(1);

        for (const tagValue of filterValues) {
          for (const hourKey of getHourKeys()) {
            const key = `index/tag/${tagName}/${tagValue}/${hourKey}.jsonl`;

            try {
              const obj = await r2.get(key);
              if (obj) {
                const content = await obj.text();
                const lines = content.split('\n').filter(line => line.trim());

                for (const line of lines) {
                  try {
                    const event = JSON.parse(line) as NostrEvent;

                    if (processedEventIds.has(event.id)) continue;

                    // For time-based queries, ensure event is in archive range
                    if (!filter.ids && event.created_at >= hotDataCutoff) continue;

                    // Apply remaining filters
                    if (filter.ids && !filter.ids.includes(event.id)) continue;
                    if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
                    if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
                    if (filter.since && event.created_at < filter.since) continue;
                    if (filter.until && event.created_at > filter.until) continue;

                    // Check other tag filters
                    let matchesOtherTags = true;
                    for (const [otherKey, otherValues] of Object.entries(filter)) {
                      if (otherKey.startsWith('#') && otherKey !== filterKey &&
                        Array.isArray(otherValues) && otherValues.length > 0) {
                        const otherTagName = otherKey.substring(1);
                        const eventOtherTagValues = event.tags
                          .filter(tag => tag[0] === otherTagName)
                          .map(tag => tag[1]);

                        if (!otherValues.some(v => eventOtherTagValues.includes(v))) {
                          matchesOtherTags = false;
                          break;
                        }
                      }
                    }

                    if (!matchesOtherTags) continue;

                    results.push(event);
                    processedEventIds.add(event.id);
                  } catch (e) {
                    console.error('Failed to parse archive event:', e);
                  }
                }
              }
            } catch (e) {
              // File doesn't exist
            }
          }
        }
      }
    }
  } else {
    // Fall back to primary hourly storage
    const filesToQuery = getHourKeys().map(hourKey => `events/${hourKey}.jsonl`);

    // Limit files to query
    if (filesToQuery.length > 2160) { // 90 days * 24 hours
      console.warn(`Large archive query spanning ${filesToQuery.length} hours, limiting to most recent 2160`);
      filesToQuery.splice(0, filesToQuery.length - 2160);
    }

    // Query each file
    for (const file of filesToQuery) {
      try {
        const object = await r2.get(file);
        if (!object) continue;

        const content = await object.text();
        const lines = content.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const event = JSON.parse(line) as NostrEvent;

            if (processedEventIds.has(event.id)) continue;

            // For time-based queries, ensure event is in archive range
            if (!filter.ids && event.created_at >= hotDataCutoff) continue;

            // Apply filters
            if (filter.ids && !filter.ids.includes(event.id)) continue;
            if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
            if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
            if (filter.since && event.created_at < filter.since) continue;
            if (filter.until && event.created_at > filter.until) continue;

            // Apply tag filters
            let matchesTags = true;
            for (const [key, values] of Object.entries(filter)) {
              if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
                const tagName = key.substring(1);
                const eventTagValues = event.tags
                  .filter(tag => tag[0] === tagName)
                  .map(tag => tag[1]);

                if (!values.some(v => eventTagValues.includes(v))) {
                  matchesTags = false;
                  break;
                }
              }
            }

            if (!matchesTags) continue;

            results.push(event);
            processedEventIds.add(event.id);
          } catch (e) {
            console.error('Failed to parse archive event:', e);
          }
        }
      } catch (e) {
        // File doesn't exist
        continue;
      }
    }
  }

  console.log(`Archive query returned ${results.length} events`);
  return results;
}

// Query events with archive support
async function queryEventsWithArchive(filters: NostrFilter[], bookmark: string, env: Env): Promise<QueryResult> {
  // First get results from D1
  const d1Result = await queryEvents(filters, bookmark, env);

  // Check if we need to query archive
  const hotDataCutoff = Math.floor(Date.now() / 1000) - (ARCHIVE_RETENTION_DAYS * 24 * 60 * 60);

  // Determine if we need archive access
  const needsArchive = filters.some(filter => {
    // Always check archive for direct ID lookups (no time constraints)
    if (filter.ids && filter.ids.length > 0) {
      return true;
    }

    // Check archive if the filter explicitly requests data older than 90 days
    if (!filter.since && !filter.until) {
      return false;
    }

    const queryStartsBeforeCutoff = filter.since && filter.since < hotDataCutoff;
    const queryEndsBeforeCutoff = filter.until && filter.until < hotDataCutoff;

    return queryStartsBeforeCutoff || queryEndsBeforeCutoff;
  });

  if (!needsArchive || !env.EVENT_ARCHIVE) {
    return d1Result;
  }

  console.log('Query requires archive access - checking for missing events or old data');

  // Query archive for each filter that needs it
  const archiveEvents: NostrEvent[] = [];
  for (const filter of filters) {
    // Check if this specific filter needs archive
    const hasDirectIds = filter.ids && filter.ids.length > 0;
    const queryStartsBeforeCutoff = filter.since && filter.since < hotDataCutoff;
    const queryEndsBeforeCutoff = filter.until && filter.until < hotDataCutoff;

    if (hasDirectIds || queryStartsBeforeCutoff || queryEndsBeforeCutoff) {
      // For direct ID lookups, check which IDs are missing from D1 results
      if (hasDirectIds) {
        const foundIds = new Set(d1Result.events.map(e => e.id));
        // @ts-ignore
        const missingIds = filter.ids.filter(id => !foundIds.has(id));

        if (missingIds.length > 0) {
          console.log(`Checking archive for ${missingIds.length} missing event IDs`);
          const archiveFilter = { ...filter, ids: missingIds };

          // Don't apply time constraints for direct ID lookups in archive
          delete archiveFilter.since;
          delete archiveFilter.until;

          const archived = await queryArchive(archiveFilter, hotDataCutoff, env.EVENT_ARCHIVE);
          archiveEvents.push(...archived);
        }
      } else {
        // For time-based queries, adjust the filter for archive query to avoid overlap
        const archiveFilter = { ...filter };

        // If querying archive, cap the `until` at the cutoff to avoid overlap with D1
        if (!archiveFilter.until || archiveFilter.until > hotDataCutoff) {
          archiveFilter.until = hotDataCutoff;
        }

        const archived = await queryArchive(archiveFilter, hotDataCutoff, env.EVENT_ARCHIVE);
        archiveEvents.push(...archived);
      }
    }
  }

  // Merge results
  const allEvents = new Map<string, NostrEvent>();

  // Add D1 events
  for (const event of d1Result.events) {
    allEvents.set(event.id, event);
  }

  // Add archive events
  for (const event of archiveEvents) {
    allEvents.set(event.id, event);
  }

  // Sort by created_at descending and apply overall limit
  const sortedEvents = Array.from(allEvents.values()).sort((a, b) => {
    if (b.created_at !== a.created_at) {
      return b.created_at - a.created_at;
    }
    return a.id.localeCompare(b.id);
  });

  // Apply the most restrictive limit from filters
  const limit = Math.min(...filters.map(f => f.limit || 10000));
  const limitedEvents = sortedEvents.slice(0, limit);

  console.log(`Query returned ${d1Result.events.length} events from D1, ${archiveEvents.length} from archive`);

  return {
    events: limitedEvents,
    bookmark: d1Result.bookmark
  };
}

// HTTP endpoints
function handleRelayInfoRequest(request: Request, env: Env): Response {
  const responseInfo = { ...getRelayInfo(env) };

  if (PAY_TO_RELAY_ENABLED) {
    const url = new URL(request.url);
    responseInfo.payments_url = `${url.protocol}//${url.host}`;
    responseInfo.fees = {
      admission: [{ amount: RELAY_ACCESS_PRICE_SATS * 1000, unit: "msats" }]
    };
  }

  return new Response(JSON.stringify(responseInfo), {
    status: 200,
    headers: {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Allow-Methods": "GET",
    }
  });
}

function serveDocumentation(): Response {
  const docsHtml = `<h1>Developer Documentation</h1>
<h2>Divine Video Relay - Video Discovery & Sorting</h2>
<h3>Overview</h3>
<p>The Divine Video relay (relay.divine.video) is a specialized Nostr relay with custom vendor extensions for discovering and sorting short-form videos by engagement metrics.</p>
<h3>Relay Information</h3>
<ul>
<li><strong>URL</strong>: <code>wss://relay.divine.video</code></li>
<li><strong>Video Event Kind</strong>: <code>34236</code> (vertical video)</li>
<li><strong>Supported Metrics</strong>: <code>loop_count</code>, <code>likes</code>, <code>views</code>, <code>comments</code>, <code>avg_completion</code></li>
</ul>
<hr>
<h2>Quick Start</h2>
<h3>JavaScript / Node.js</h3>
<pre><code class="language-javascript">import WebSocket from &#39;ws&#39;;

const ws = new WebSocket(&#39;wss://relay.divine.video&#39;);

ws.on(&#39;open&#39;, () =&gt; {
  // Query trending videos
  ws.send(JSON.stringify([
    &#39;REQ&#39;,
    &#39;trending&#39;,
    {
      kinds: [34236],
      sort: { field: &#39;loop_count&#39;, dir: &#39;desc&#39; },
      limit: 20
    }
  ]));
});

ws.on(&#39;message&#39;, (data) =&gt; {
  const [type, subId, event] = JSON.parse(data);
  if (type === &#39;EVENT&#39;) {
    console.log(&#39;Video:&#39;, event);
  }
});
</code></pre>
<h3>Python</h3>
<pre><code class="language-python">import websocket
import json

ws = websocket.create_connection(&#39;wss://relay.divine.video&#39;)

# Query trending videos
query = [&#39;REQ&#39;, &#39;trending&#39;, {
    &#39;kinds&#39;: [34236],
    &#39;sort&#39;: {&#39;field&#39;: &#39;loop_count&#39;, &#39;dir&#39;: &#39;desc&#39;},
    &#39;limit&#39;: 20
}]
ws.send(json.dumps(query))

while True:
    message = json.loads(ws.recv())
    if message[0] == &#39;EVENT&#39;:
        print(f&#39;Video: {message[2]}&#39;)
    elif message[0] == &#39;EOSE&#39;:
        break
</code></pre>
<h3>Using wscat (testing)</h3>
<pre><code class="language-bash">wscat -c wss://relay.divine.video

# Then send:
[&quot;REQ&quot;,&quot;test&quot;,{&quot;kinds&quot;:[34236],&quot;sort&quot;:{&quot;field&quot;:&quot;loop_count&quot;,&quot;dir&quot;:&quot;desc&quot;},&quot;limit&quot;:5}]
</code></pre>
<hr>
<h2>Basic Query Structure</h2>
<p>All queries follow standard Nostr REQ format with added vendor extensions:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;subscription_id&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;loop_count&quot;,  // or &quot;likes&quot;, &quot;views&quot;, &quot;comments&quot;, &quot;avg_completion&quot;, &quot;created_at&quot;
    &quot;dir&quot;: &quot;desc&quot;           // or &quot;asc&quot;
  },
  &quot;limit&quot;: 20
}]
</code></pre>
<hr>
<h2>Common Query Examples</h2>
<h3>1. Most Looped Videos (Trending)</h3>
<p>Get videos with the most loops (plays):</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;trending&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;loop_count&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 50
}]
</code></pre>
<h3>2. Most Liked Videos</h3>
<p>Get videos sorted by number of likes:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;most-liked&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;likes&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 50
}]
</code></pre>
<h3>3. Most Viewed Videos</h3>
<p>Get videos sorted by view count:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;most-viewed&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;views&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 50
}]
</code></pre>
<h3>4. Newest Videos First</h3>
<p>Get most recently published videos:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;newest&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;created_at&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 50
}]
</code></pre>
<hr>
<h2>Filtering by Engagement Metrics</h2>
<p>Use <code>int#&lt;metric&gt;</code> filters to set thresholds:</p>
<h3>5. Popular Videos (minimum threshold)</h3>
<p>Get videos with at least 100 likes:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;popular&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;int#likes&quot;: {&quot;gte&quot;: 100},
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;loop_count&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 20
}]
</code></pre>
<h3>6. Range Queries</h3>
<p>Get videos with 10-100 likes:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;moderate-engagement&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;int#likes&quot;: {
    &quot;gte&quot;: 10,
    &quot;lte&quot;: 100
  },
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;created_at&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 50
}]
</code></pre>
<h3>7. Highly Engaged Videos</h3>
<p>Combine multiple metric filters:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;highly-engaged&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;int#likes&quot;: {&quot;gte&quot;: 50},
  &quot;int#loop_count&quot;: {&quot;gte&quot;: 1000},
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;likes&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 20
}]
</code></pre>
<hr>
<h2>Hashtag Filtering</h2>
<h3>8. Videos by Hashtag</h3>
<p>Get videos tagged with specific hashtags:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;music-videos&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;#t&quot;: [&quot;music&quot;],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;likes&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 20
}]
</code></pre>
<h3>9. Multiple Hashtags (OR logic)</h3>
<p>Videos with ANY of these tags:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;entertainment&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;#t&quot;: [&quot;music&quot;, &quot;dance&quot;, &quot;comedy&quot;],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;loop_count&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 50
}]
</code></pre>
<hr>
<h2>Author Queries</h2>
<h3>10. Videos by Specific Author</h3>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;author-videos&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;authors&quot;: [&quot;pubkey_hex_here&quot;],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;created_at&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 20
}]
</code></pre>
<h3>11. Top Videos by Author</h3>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;author-top-videos&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;authors&quot;: [&quot;pubkey_hex_here&quot;],
  &quot;sort&quot;: {
    &quot;field&quot;: &quot;loop_count&quot;,
    &quot;dir&quot;: &quot;desc&quot;
  },
  &quot;limit&quot;: 10
}]
</code></pre>
<hr>
<h2>Pagination</h2>
<h3>12. Using Cursors for Infinite Scroll</h3>
<p>The relay returns a cursor in the EOSE message for pagination:</p>
<pre><code class="language-javascript">// Send initial query
ws.send(JSON.stringify([&#39;REQ&#39;, &#39;feed&#39;, {
  kinds: [34236],
  sort: {field: &#39;loop_count&#39;, dir: &#39;desc&#39;},
  limit: 20
}]));

// Listen for EOSE message with cursor
ws.on(&#39;message&#39;, (data) =&gt; {
  const message = JSON.parse(data);

  if (message[0] === &#39;EOSE&#39;) {
    const subscriptionId = message[1];
    const cursor = message[2]; // Cursor for next page

    if (cursor) {
      // Fetch next page
      ws.send(JSON.stringify([&#39;REQ&#39;, &#39;feed-page-2&#39;, {
        kinds: [34236],
        sort: {field: &#39;loop_count&#39;, dir: &#39;desc&#39;},
        limit: 20,
        cursor: cursor
      }]));
    }
  }
});
</code></pre>
<hr>
<h2>Available Metrics</h2>
<table>
<thead>
<tr>
<th>Metric</th>
<th>Description</th>
<th>Tag Name</th>
</tr>
</thead>
<tbody><tr>
<td><code>loop_count</code></td>
<td>Number of times video was looped/replayed</td>
<td><code>loops</code></td>
</tr>
<tr>
<td><code>likes</code></td>
<td>Number of likes</td>
<td><code>likes</code></td>
</tr>
<tr>
<td><code>views</code></td>
<td>Number of views</td>
<td><code>views</code></td>
</tr>
<tr>
<td><code>comments</code></td>
<td>Number of comments</td>
<td><code>comments</code></td>
</tr>
<tr>
<td><code>avg_completion</code></td>
<td>Average completion rate (0-100)</td>
<td>Not in tags yet</td>
</tr>
<tr>
<td><code>created_at</code></td>
<td>Unix timestamp of publication</td>
<td>Event&#39;s <code>created_at</code></td>
</tr>
</tbody></table>
<hr>
<h2>Reading Metrics from Events</h2>
<p>When you receive an EVENT, metrics are in the tags array:</p>
<pre><code class="language-javascript">ws.on(&#39;message&#39;, (data) =&gt; {
  const [type, subId, event] = JSON.parse(data);

  if (type === &#39;EVENT&#39;) {
    // Extract metrics from tags
    const loops = getTagValue(event.tags, &#39;loops&#39;);
    const likes = getTagValue(event.tags, &#39;likes&#39;);
    const views = getTagValue(event.tags, &#39;views&#39;);
    const comments = getTagValue(event.tags, &#39;comments&#39;);
    const vineId = getTagValue(event.tags, &#39;d&#39;); // Original Vine ID

    console.log(\`Video \${vineId}: \${loops} loops, \${likes} likes\`);
  }
});

function getTagValue(tags, tagName) {
  const tag = tags.find(t =&gt; t[0] === tagName);
  return tag ? parseInt(tag[1]) || 0 : 0;
}
</code></pre>
<pre><code class="language-python"># Python example
def handle_event(event):
    tags = event[&#39;tags&#39;]

    # Extract metrics
    loops = get_tag_value(tags, &#39;loops&#39;)
    likes = get_tag_value(tags, &#39;likes&#39;)
    views = get_tag_value(tags, &#39;views&#39;)
    vine_id = get_tag_value(tags, &#39;d&#39;)

    print(f&#39;Video {vine_id}: {loops} loops, {likes} likes&#39;)

def get_tag_value(tags, tag_name):
    for tag in tags:
        if tag[0] == tag_name:
            return int(tag[1]) if len(tag) &gt; 1 else 0
    return 0
</code></pre>
<hr>
<h2>Feed Recommendations</h2>
<h3>For You Feed</h3>
<p>Trending content from last 24 hours:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;for-you&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;since&quot;: 1704067200,
  &quot;sort&quot;: {&quot;field&quot;: &quot;loop_count&quot;, &quot;dir&quot;: &quot;desc&quot;},
  &quot;limit&quot;: 50
}]
</code></pre>
<h3>Discover Feed</h3>
<p>High engagement, diverse content:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;discover&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;int#likes&quot;: {&quot;gte&quot;: 20},
  &quot;int#loop_count&quot;: {&quot;gte&quot;: 500},
  &quot;sort&quot;: {&quot;field&quot;: &quot;created_at&quot;, &quot;dir&quot;: &quot;desc&quot;},
  &quot;limit&quot;: 100
}]
</code></pre>
<h3>Trending Feed</h3>
<p>Pure virality - most loops:</p>
<pre><code class="language-json">[&quot;REQ&quot;, &quot;trending&quot;, {
  &quot;kinds&quot;: [34236],
  &quot;sort&quot;: {&quot;field&quot;: &quot;loop_count&quot;, &quot;dir&quot;: &quot;desc&quot;},
  &quot;limit&quot;: 50
}]
</code></pre>
<hr>
<h2>Rate Limits</h2>
<ul>
<li><strong>Maximum limit per query</strong>: 200 events</li>
<li><strong>Query rate</strong>: Up to 50 REQ messages per minute per connection</li>
<li><strong>Publish rate</strong>: Up to 10 EVENT messages per minute per pubkey</li>
</ul>
<hr>
<h2>Error Handling</h2>
<p>The relay will send a CLOSED message if a query is invalid:</p>
<pre><code class="language-javascript">ws.on(&#39;message&#39;, (data) =&gt; {
  const message = JSON.parse(data);

  if (message[0] === &#39;CLOSED&#39;) {
    const subscriptionId = message[1];
    const reason = message[2];
    console.log(\`Subscription \${subscriptionId} closed: \${reason}\`);

    // Common reasons:
    // - &#39;invalid: unsupported sort field&#39;
    // - &#39;invalid: limit exceeds maximum (200)&#39;
    // - &#39;blocked: kinds [...] not allowed&#39;
  }
});
</code></pre>
<hr>
<h2>Testing</h2>
<p>You can test queries using wscat:</p>
<pre><code class="language-bash"># Connect to relay
wscat -c wss://relay.divine.video

# Send query (paste this after connecting)
[&quot;REQ&quot;, &quot;test&quot;, {&quot;kinds&quot;: [34236], &quot;sort&quot;: {&quot;field&quot;: &quot;loop_count&quot;, &quot;dir&quot;: &quot;desc&quot;}, &quot;limit&quot;: 5}]
</code></pre>
<hr>
<h2>NIP-11 Relay Information (Discovery)</h2>
<h3>Checking Relay Capabilities</h3>
<p>Before using vendor extensions, check the relay&#39;s NIP-11 document to verify support:</p>
<pre><code class="language-bash">curl -H &quot;Accept: application/nostr+json&quot; https://relay.divine.video
</code></pre>
<h3>JavaScript Example</h3>
<pre><code class="language-javascript">async function getRelayCapabilities(relayUrl) {
  // Convert wss:// to https://
  const httpUrl = relayUrl.replace(&#39;wss://&#39;, &#39;https://&#39;).replace(&#39;ws://&#39;, &#39;http://&#39;);

  const response = await fetch(httpUrl, {
    headers: {&#39;Accept&#39;: &#39;application/nostr+json&#39;}
  });

  const relayInfo = await response.json();

  if (relayInfo.divine_extensions) {
    console.log(&#39;Supported sort fields:&#39;, relayInfo.divine_extensions.sort_fields);
    console.log(&#39;Supported filters:&#39;, relayInfo.divine_extensions.int_filters);
    console.log(&#39;Max limit:&#39;, relayInfo.divine_extensions.limit_max);
  }

  return relayInfo;
}

// Usage
const info = await getRelayCapabilities(&#39;wss://relay.divine.video&#39;);
</code></pre>
<h3>Python Example</h3>
<pre><code class="language-python">import requests

def get_relay_capabilities(relay_url):
    http_url = relay_url.replace(&#39;wss://&#39;, &#39;https://&#39;).replace(&#39;ws://&#39;, &#39;http://&#39;)

    response = requests.get(http_url, headers={
        &#39;Accept&#39;: &#39;application/nostr+json&#39;
    })

    relay_info = response.json()

    if &#39;divine_extensions&#39; in relay_info:
        print(f&quot;Supported sort fields: {relay_info[&#39;divine_extensions&#39;][&#39;sort_fields&#39;]}&quot;)
        print(f&quot;Supported filters: {relay_info[&#39;divine_extensions&#39;][&#39;int_filters&#39;]}&quot;)

    return relay_info

# Usage
info = get_relay_capabilities(&#39;wss://relay.divine.video&#39;)
</code></pre>
<h3>Example NIP-11 Response</h3>
<pre><code class="language-json">{
  &quot;name&quot;: &quot;Divine Video Relay&quot;,
  &quot;description&quot;: &quot;A specialized Nostr relay for Divine Video&#39;s 6-second short-form videos&quot;,
  &quot;supported_nips&quot;: [1, 2, 4, 5, 9, 11, 12, 15, 16, 17, 20, 22, 33, 40],
  &quot;divine_extensions&quot;: {
    &quot;int_filters&quot;: [&quot;loop_count&quot;, &quot;likes&quot;, &quot;views&quot;, &quot;comments&quot;, &quot;avg_completion&quot;],
    &quot;sort_fields&quot;: [&quot;loop_count&quot;, &quot;likes&quot;, &quot;views&quot;, &quot;comments&quot;, &quot;avg_completion&quot;, &quot;created_at&quot;],
    &quot;cursor_format&quot;: &quot;base64url-encoded HMAC-SHA256 with query hash binding&quot;,
    &quot;videos_kind&quot;: 34236,
    &quot;metrics_freshness_sec&quot;: 3600,
    &quot;limit_max&quot;: 200
  }
}
</code></pre>
<h3>What Each Field Means</h3>
<ul>
<li><strong><code>int_filters</code></strong>: Metrics you can use with <code>int#&lt;metric&gt;</code> filters (e.g., <code>int#likes</code>)</li>
<li><strong><code>sort_fields</code></strong>: Fields you can use in the <code>sort</code> parameter</li>
<li><strong><code>cursor_format</code></strong>: How pagination cursors are generated (for security)</li>
<li><strong><code>videos_kind</code></strong>: The Nostr event kind for videos (34236)</li>
<li><strong><code>metrics_freshness_sec</code></strong>: How often metrics are updated (hourly = 3600 seconds)</li>
<li><strong><code>limit_max</code></strong>: Maximum events you can request in a single query (200)</li>
</ul>
<hr>
<h2>Support</h2>
<p>For questions or issues:</p>
<ul>
<li>GitHub: <a href="https://github.com/rabble/nosflare">https://github.com/rabble/nosflare</a></li>
<li>Relay Maintainer: <a href="mailto:relay@divine.video">relay@divine.video</a></li>
</ul>
`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Developer documentation for integrating with Divine Video relay - WebSocket API examples in JavaScript, Python, and more" />
    <title>Developer Documentation - Divine Video Relay</title>
    <link href="https://fonts.googleapis.com/css2?family=Pacifico&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: #ffffff;
            color: #333333;
            line-height: 1.6;
        }

        .header {
            background: linear-gradient(135deg, #00BFA5 0%, #00897B 100%);
            color: white;
            padding: 2rem;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .logo {
            font-family: 'Pacifico', cursive;
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
        }

        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 2rem;
        }

        .back-link {
            display: inline-block;
            color: #00BFA5;
            text-decoration: none;
            margin-bottom: 2rem;
            font-weight: 500;
        }

        .back-link:hover {
            text-decoration: underline;
        }

        .content {
            background: white;
        }

        .content h1 {
            color: #00BFA5;
            margin-top: 2rem;
            margin-bottom: 1rem;
            padding-bottom: 0.5rem;
            border-bottom: 2px solid #00BFA5;
        }

        .content h2 {
            color: #00897B;
            margin-top: 1.5rem;
            margin-bottom: 0.75rem;
        }

        .content h3 {
            color: #333;
            margin-top: 1.25rem;
            margin-bottom: 0.5rem;
        }

        .content p {
            margin-bottom: 1rem;
        }

        .content ul, .content ol {
            margin-left: 2rem;
            margin-bottom: 1rem;
        }

        .content li {
            margin-bottom: 0.5rem;
        }

        .content pre {
            background: #1e1e1e;
            border-radius: 8px;
            padding: 1rem;
            overflow-x: auto;
            margin-bottom: 1rem;
            color: #fff;
        }

        .content code {
            font-family: 'Courier New', Courier, monospace;
            background: #f5f5f5;
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            font-size: 0.9em;
        }

        .content pre code {
            background: transparent;
            padding: 0;
            color: #61afef;
        }

        .content table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 1rem;
        }

        .content th, .content td {
            border: 1px solid #ddd;
            padding: 0.75rem;
            text-align: left;
        }

        .content th {
            background: #00BFA5;
            color: white;
        }

        .content tr:nth-child(even) {
            background: #f9f9f9;
        }

        .content hr {
            border: none;
            border-top: 2px solid #e0e0e0;
            margin: 2rem 0;
        }

        .content a {
            color: #00BFA5;
            text-decoration: none;
        }

        .content a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="logo">diVine Relay</div>
        <p>Developer Documentation</p>
    </div>

    <div class="container">
        <a href="/" class="back-link">← Back to Home</a>
        <div class="content">
            ${docsHtml}
        </div>
    </div>
</body>
</html>
`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}function serveLandingPage(): Response {
  const payToRelaySection = PAY_TO_RELAY_ENABLED ? `
    <div class="pay-section" id="paySection">
      <p style="margin-bottom: 1rem;">Pay to access this relay:</p>
      <button id="payButton" class="pay-button" data-npub="${relayNpub}" data-relays="wss://relay.damus.io,wss://relay.primal.net,wss://sendit.nosflare.com" data-sats-amount="${RELAY_ACCESS_PRICE_SATS}">
        <img src="https://nosflare.com/images/pwb-button-min.png" alt="Pay with Bitcoin" style="height: 60px;">
      </button>
      <p class="price-info">${RELAY_ACCESS_PRICE_SATS.toLocaleString()} sats</p>
    </div>
    <div class="info-box" id="accessSection" style="display: none;">
      <p style="margin-bottom: 1rem;">Connect your Nostr client to:</p>
      <div class="url-display" onclick="copyToClipboard()" id="relay-url">
        <!-- URL will be inserted by JavaScript -->
      </div>
      <p class="copy-hint">Click to copy</p>
    </div>
  ` : `
    <div class="info-box">
      <p style="margin-bottom: 1rem;">Connect your Nostr client to:</p>
      <div class="url-display" onclick="copyToClipboard()" id="relay-url">
        <!-- URL will be inserted by JavaScript -->
      </div>
      <p class="copy-hint">Click to copy</p>
    </div>
  `;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="A free, open Nostr relay for the Divine Video community" />
    <title>Divine Video Relay - Nostr Relay</title>
    <link href="https://fonts.googleapis.com/css2?family=Pacifico&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: #ffffff;
            color: #333333;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 2rem;
        }

        .container {
            text-align: center;
            padding: 2rem;
            max-width: 600px;
            width: 100%;
        }

        .logo {
            font-family: 'Pacifico', cursive;
            font-size: 4rem;
            color: #00BFA5;
            margin-bottom: 0.5rem;
            text-decoration: none;
        }

        .tagline {
            font-size: 1.1rem;
            color: #666;
            margin-bottom: 3rem;
            font-weight: 400;
        }

        .info-box {
            background: #ffffff;
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 2rem;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }

        .url-display {
            background: #f5f5f5;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 1rem;
            font-family: 'Courier New', monospace;
            font-size: 1rem;
            color: #00BFA5;
            margin: 1rem 0;
            word-break: break-all;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .url-display:hover {
            border-color: #00BFA5;
            background: #f0fffe;
        }

        .copy-hint {
            font-size: 0.85rem;
            color: #999;
            margin-top: 0.5rem;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 1rem;
            margin-top: 2rem;
        }

        .stat-item {
            background: #ffffff;
            border: 1px solid #e0e0e0;
            border-radius: 12px;
            padding: 1.5rem 1rem;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }

        .stat-value {
            font-size: 1.8rem;
            font-weight: 700;
            color: #00BFA5;
        }

        .stat-label {
            font-size: 0.9rem;
            color: #666;
            margin-top: 0.5rem;
        }

        .links {
            margin-top: 3rem;
            display: flex;
            gap: 1.5rem;
            justify-content: center;
            flex-wrap: wrap;
        }

        .link {
            color: #00BFA5;
            text-decoration: none;
            font-size: 1rem;
            transition: all 0.3s ease;
            font-weight: 500;
            padding: 0.75rem 1.5rem;
            border: 2px solid #00BFA5;
            border-radius: 24px;
            background: transparent;
        }

        .link:hover {
            color: #ffffff;
            background: #00BFA5;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 191, 165, 0.3);
        }

        .link.primary {
            background: #00BFA5;
            color: #ffffff;
        }

        .link.primary:hover {
            background: #00897B;
            border-color: #00897B;
        }

        .toast {
            position: fixed;
            bottom: 2rem;
            background: #00BFA5;
            color: white;
            padding: 1rem 2rem;
            border-radius: 24px;
            transform: translateY(100px);
            transition: transform 0.3s ease;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0, 191, 165, 0.3);
        }

        .toast.show {
            transform: translateY(0);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">diVine Relay</div>
        <p class="tagline">Short-form video relay for authentic, human-created content</p>

        <div class="info-box">
            <h2 style="font-size: 1.3rem; color: #00BFA5; margin-bottom: 1rem; font-weight: 600;">What is Divine Video?</h2>
            <p style="color: #666; line-height: 1.6; margin-bottom: 1rem;">
                This relay is dedicated to hosting <strong>6-second short-form videos</strong> from the Divine Video app.
                Each video is verified using <strong>ProofMode</strong> to ensure authenticity — proving they're real,
                live-shot moments captured by humans, not AI-generated content.
            </p>
            <p style="color: #666; line-height: 1.6;">
                Connect your Nostr client to access a feed of genuine, creative micro-videos from the Divine Video community.
            </p>
        </div>

        ${payToRelaySection}
        
        <div class="stats">
            <div class="stat-item">
                <div class="stat-value">6 sec</div>
                <div class="stat-label">Max Video Length</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">✓</div>
                <div class="stat-label">ProofMode Verified</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${relayInfo.supported_nips.length}</div>
                <div class="stat-label">Supported NIPs</div>
            </div>
        </div>
        
        <div class="links">
            <a href="https://divine.video" class="link primary" target="_blank">Get the App</a>
            <a href="/docs" class="link">Developer Docs</a>
            <a href="https://divine.video/about" class="link" target="_blank">About Divine Video</a>
            <a href="https://divine.video/proofmode" class="link" target="_blank">What is ProofMode?</a>
        </div>
    </div>
    
    <div class="toast" id="toast">Copied to clipboard!</div>
    
    <script>
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const relayUrl = protocol + '//' + window.location.host;
        const relayUrlElement = document.getElementById('relay-url');
        if (relayUrlElement) {
            relayUrlElement.textContent = relayUrl;
        }
        
        function copyToClipboard() {
            const relayUrl = document.getElementById('relay-url').textContent;
            navigator.clipboard.writeText(relayUrl).then(() => {
                const toast = document.getElementById('toast');
                toast.classList.add('show');
                setTimeout(() => {
                    toast.classList.remove('show');
                }, 2000);
            });
        }
        
        ${PAY_TO_RELAY_ENABLED ? `
        // Payment handling code
        let paymentCheckInterval;

        async function checkPaymentStatus() {
            if (!window.nostr || !window.nostr.getPublicKey) return false;
            
            try {
                const pubkey = await window.nostr.getPublicKey();
                const response = await fetch('/api/check-payment?pubkey=' + pubkey);
                const data = await response.json();
                
                if (data.paid) {
                    showRelayAccess();
                    return true;
                }
                return false;
            } catch (error) {
                console.error('Error checking payment status:', error);
                return false;
            }
        }

        function showRelayAccess() {
            const paySection = document.getElementById('paySection');
            const accessSection = document.getElementById('accessSection');
            
            if (paySection && accessSection) {
                paySection.style.transition = 'opacity 0.3s ease-out';
                paySection.style.opacity = '0';
                
                setTimeout(() => {
                    paySection.style.display = 'none';
                    accessSection.style.display = 'block';
                    accessSection.style.opacity = '0';
                    accessSection.style.transition = 'opacity 0.3s ease-in';
                    
                    void accessSection.offsetHeight;
                    
                    accessSection.style.opacity = '1';
                }, 300);
            }
            
            if (paymentCheckInterval) {
                clearInterval(paymentCheckInterval);
                paymentCheckInterval = null;
            }
        }

        window.addEventListener('payment-success', async (event) => {
            console.log('Payment success event received');
            setTimeout(() => {
                showRelayAccess();
            }, 500);
        });

        async function initPayment() {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/gh/Spl0itable/nosflare@main/nostr-zap.js';
            script.onload = () => {
                if (window.nostrZap) {
                    window.nostrZap.initTargets('#payButton');
                    
                    document.getElementById('payButton').addEventListener('click', () => {
                        if (!paymentCheckInterval) {
                            paymentCheckInterval = setInterval(async () => {
                                await checkPaymentStatus();
                            }, 3000);
                        }
                    });
                }
            };
            document.head.appendChild(script);
            
            await checkPaymentStatus();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initPayment);
        } else {
            initPayment();
        }
        ` : ''}
    </script>
    ${PAY_TO_RELAY_ENABLED ? '<script src="https://unpkg.com/nostr-login@latest/dist/unpkg.js" data-perms="sign_event:1" data-methods="connect,extension,local" data-dark-mode="true"></script>' : ''}
</body>
</html>
  `;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

async function serveFavicon(): Promise<Response> {
  const response = await fetch(relayInfo.icon);
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "max-age=3600");
    return new Response(response.body, {
      status: response.status,
      headers: headers,
    });
  }
  return new Response(null, { status: 404 });
}

function handleNIP05Request(url: URL): Response {
  const name = url.searchParams.get("name");
  if (!name) {
    return new Response(JSON.stringify({ error: "Missing 'name' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const pubkey = nip05Users[name.toLowerCase()];
  if (!pubkey) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const response = {
    names: { [name]: pubkey },
    relays: { [pubkey]: [] }
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function handleCheckPayment(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pubkey = url.searchParams.get('pubkey');

  if (!pubkey) {
    return new Response(JSON.stringify({ error: 'Missing pubkey' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const paid = await hasPaidForRelay(pubkey, env);

  return new Response(JSON.stringify({ paid }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function handlePaymentNotification(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const pubkey = url.searchParams.get('npub');

    if (!pubkey) {
      return new Response(JSON.stringify({ error: 'Missing pubkey' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const success = await savePaidPubkey(pubkey, env);

    return new Response(JSON.stringify({
      success,
      message: success ? 'Payment recorded successfully' : 'Failed to save payment'
    }), {
      status: success ? 200 : 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('Error processing payment notification:', error);
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// Multi-region DO selection logic with location hints
async function getOptimalDO(cf: any, env: Env, url: URL): Promise<{ stub: DurableObjectStub; doName: string }> {
  const continent = cf?.continent || 'NA';
  const country = cf?.country || 'US';
  const region = cf?.region || 'unknown';
  const colo = cf?.colo || 'unknown';

  console.log(`User location: continent=${continent}, country=${country}, region=${region}, colo=${colo}`);

  // All 9 endpoints with their location hints
  const ALL_ENDPOINTS = [
    { name: 'relay-WNAM-primary', hint: 'wnam' },
    { name: 'relay-ENAM-primary', hint: 'enam' },
    { name: 'relay-WEUR-primary', hint: 'weur' },
    { name: 'relay-EEUR-primary', hint: 'eeur' },
    { name: 'relay-APAC-primary', hint: 'apac' },
    { name: 'relay-OC-primary', hint: 'oc' },
    { name: 'relay-SAM-primary', hint: 'sam' },
    { name: 'relay-AFR-primary', hint: 'afr' },
    { name: 'relay-ME-primary', hint: 'me' }
  ];

  // Country to hint mapping
  const countryToHint: Record<string, string> = {
    // North America
    'US': 'enam', 'CA': 'enam', 'MX': 'wnam',

    // Central America & Caribbean (route to WNAM)
    'GT': 'wnam', 'BZ': 'wnam', 'SV': 'wnam', 'HN': 'wnam', 'NI': 'wnam',
    'CR': 'wnam', 'PA': 'wnam', 'CU': 'wnam', 'DO': 'wnam', 'HT': 'wnam',
    'JM': 'wnam', 'PR': 'wnam', 'TT': 'wnam', 'BB': 'wnam',

    // South America
    'BR': 'sam', 'AR': 'sam', 'CL': 'sam', 'CO': 'sam', 'PE': 'sam',
    'VE': 'sam', 'EC': 'sam', 'BO': 'sam', 'PY': 'sam', 'UY': 'sam',
    'GY': 'sam', 'SR': 'sam', 'GF': 'sam',

    // Western Europe
    'GB': 'weur', 'FR': 'weur', 'DE': 'weur', 'ES': 'weur', 'IT': 'weur',
    'NL': 'weur', 'BE': 'weur', 'CH': 'weur', 'AT': 'weur', 'PT': 'weur',
    'IE': 'weur', 'LU': 'weur', 'MC': 'weur', 'AD': 'weur', 'SM': 'weur',
    'VA': 'weur', 'LI': 'weur', 'MT': 'weur',

    // Nordic countries (route to WEUR)
    'SE': 'weur', 'NO': 'weur', 'DK': 'weur', 'FI': 'weur', 'IS': 'weur',

    // Eastern Europe
    'PL': 'eeur', 'RU': 'eeur', 'UA': 'eeur', 'RO': 'eeur', 'CZ': 'eeur',
    'HU': 'eeur', 'GR': 'eeur', 'BG': 'eeur', 'SK': 'eeur', 'HR': 'eeur',
    'RS': 'eeur', 'SI': 'eeur', 'BA': 'eeur', 'AL': 'eeur', 'MK': 'eeur',
    'ME': 'eeur', 'XK': 'eeur', 'BY': 'eeur', 'MD': 'eeur', 'LT': 'eeur',
    'LV': 'eeur', 'EE': 'eeur', 'CY': 'eeur',

    // Asia-Pacific
    'JP': 'apac', 'CN': 'apac', 'KR': 'apac', 'IN': 'apac', 'SG': 'apac',
    'TH': 'apac', 'ID': 'apac', 'MY': 'apac', 'VN': 'apac', 'PH': 'apac',
    'TW': 'apac', 'HK': 'apac', 'MO': 'apac', 'KH': 'apac', 'LA': 'apac',
    'MM': 'apac', 'BD': 'apac', 'LK': 'apac', 'NP': 'apac', 'BT': 'apac',
    'MV': 'apac', 'PK': 'apac', 'AF': 'apac', 'MN': 'apac', 'KP': 'apac',
    'BN': 'apac', 'TL': 'apac', 'PG': 'apac', 'FJ': 'apac', 'SB': 'apac',
    'VU': 'apac', 'NC': 'apac', 'PF': 'apac', 'WS': 'apac', 'TO': 'apac',
    'KI': 'apac', 'PW': 'apac', 'MH': 'apac', 'FM': 'apac', 'NR': 'apac',
    'TV': 'apac', 'CK': 'apac', 'NU': 'apac', 'TK': 'apac', 'GU': 'apac',
    'MP': 'apac', 'AS': 'apac',

    // Oceania
    'AU': 'oc', 'NZ': 'oc',

    // Middle East
    'AE': 'me', 'SA': 'me', 'IL': 'me', 'TR': 'me', 'EG': 'me',
    'IQ': 'me', 'IR': 'me', 'SY': 'me', 'JO': 'me', 'LB': 'me',
    'KW': 'me', 'QA': 'me', 'BH': 'me', 'OM': 'me', 'YE': 'me',
    'PS': 'me', 'GE': 'me', 'AM': 'me', 'AZ': 'me',

    // Africa
    'ZA': 'afr', 'NG': 'afr', 'KE': 'afr', 'MA': 'afr', 'TN': 'afr',
    'DZ': 'afr', 'LY': 'afr', 'ET': 'afr', 'GH': 'afr', 'TZ': 'afr',
    'UG': 'afr', 'SD': 'afr', 'AO': 'afr', 'MZ': 'afr', 'MG': 'afr',
    'CM': 'afr', 'CI': 'afr', 'NE': 'afr', 'BF': 'afr', 'ML': 'afr',
    'MW': 'afr', 'ZM': 'afr', 'SN': 'afr', 'SO': 'afr', 'TD': 'afr',
    'ZW': 'afr', 'GN': 'afr', 'RW': 'afr', 'BJ': 'afr', 'BI': 'afr',
    'TG': 'afr', 'SL': 'afr', 'LR': 'afr', 'MR': 'afr', 'CF': 'afr',
    'ER': 'afr', 'GM': 'afr', 'BW': 'afr', 'NA': 'afr', 'GA': 'afr',
    'LS': 'afr', 'GW': 'afr', 'GQ': 'afr', 'MU': 'afr', 'SZ': 'afr',
    'DJ': 'afr', 'KM': 'afr', 'CV': 'afr', 'SC': 'afr', 'ST': 'afr',
    'SS': 'afr', 'EH': 'afr', 'CG': 'afr', 'CD': 'afr',

    // Central Asia (route to APAC)
    'KZ': 'apac', 'UZ': 'apac', 'TM': 'apac', 'TJ': 'apac', 'KG': 'apac',
  };

  // US state-level routing
  const usStateToHint: Record<string, string> = {
    // Western states -> WNAM
    'California': 'wnam', 'Oregon': 'wnam', 'Washington': 'wnam', 'Nevada': 'wnam', 'Arizona': 'wnam',
    'Utah': 'wnam', 'Idaho': 'wnam', 'Montana': 'wnam', 'Wyoming': 'wnam', 'Colorado': 'wnam',
    'New Mexico': 'wnam', 'Alaska': 'wnam', 'Hawaii': 'wnam',

    // Eastern states -> ENAM
    'New York': 'enam', 'Florida': 'enam', 'Texas': 'enam', 'Illinois': 'enam', 'Georgia': 'enam',
    'Pennsylvania': 'enam', 'Ohio': 'enam', 'Michigan': 'enam', 'North Carolina': 'enam', 'Virginia': 'enam',
    'Massachusetts': 'enam', 'New Jersey': 'enam', 'Maryland': 'enam', 'Connecticut': 'enam', 'Maine': 'enam',
    'New Hampshire': 'enam', 'Vermont': 'enam', 'Rhode Island': 'enam', 'South Carolina': 'enam', 'Tennessee': 'enam',
    'Alabama': 'enam', 'Mississippi': 'enam', 'Louisiana': 'enam', 'Arkansas': 'enam', 'Missouri': 'enam',
    'Iowa': 'enam', 'Minnesota': 'enam', 'Wisconsin': 'enam', 'Indiana': 'enam', 'Kentucky': 'enam',
    'West Virginia': 'enam', 'Delaware': 'enam', 'Oklahoma': 'enam', 'Kansas': 'enam', 'Nebraska': 'enam',
    'South Dakota': 'enam', 'North Dakota': 'enam',

    // DC
    'District of Columbia': 'enam',
  };

  // Continent to hint fallback
  const continentToHint: Record<string, string> = {
    'NA': 'enam',
    'SA': 'sam',
    'EU': 'weur',
    'AS': 'apac',
    'AF': 'afr',
    'OC': 'oc'
  };

  // Determine best hint 
  let bestHint: string;

  // Only check US states if country is actually US
  if (country === 'US' && region && region !== 'unknown') {
    bestHint = usStateToHint[region] || 'enam';
  } else {
    // First try country mapping, then continent fallback
    bestHint = countryToHint[country] || continentToHint[continent] || 'enam';
  }

  // Find the primary endpoint based on hint
  const primaryEndpoint = ALL_ENDPOINTS.find(ep => ep.hint === bestHint) || ALL_ENDPOINTS[1]; // Default to ENAM

  // Order endpoints by proximity (primary first, then others)
  const orderedEndpoints = [
    primaryEndpoint,
    ...ALL_ENDPOINTS.filter(ep => ep.name !== primaryEndpoint.name)
  ];

  // Try each endpoint
  for (const endpoint of orderedEndpoints) {
    try {
      const id = env.RELAY_WEBSOCKET.idFromName(endpoint.name);
      const stub = env.RELAY_WEBSOCKET.get(id, { locationHint: endpoint.hint });

      console.log(`Connected to DO: ${endpoint.name} (hint: ${endpoint.hint})`);
      // @ts-ignore
      return { stub, doName: endpoint.name };
    } catch (error) {
      console.log(`Failed to connect to ${endpoint.name}: ${error}`);
    }
  }

  // Fallback to ENAM
  const fallback = ALL_ENDPOINTS[1]; // ENAM
  const id = env.RELAY_WEBSOCKET.idFromName(fallback.name);
  const stub = env.RELAY_WEBSOCKET.get(id, { locationHint: fallback.hint });
  console.log(`Fallback to DO: ${fallback.name} (hint: ${fallback.hint})`);
  // @ts-ignore
  return { stub, doName: fallback.name };
}

// Export functions for use by Durable Object
export {
  verifyEventSignature,
  hasPaidForRelay,
  processEvent,
  queryEvents,
  queryEventsWithArchive,
  calculateQueryComplexity
};

// Main worker export with Durable Object
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Payment endpoints
      if (request.method === 'POST' && url.searchParams.has('notify-zap') && PAY_TO_RELAY_ENABLED) {
        return await handlePaymentNotification(request, env);
      }

      if (url.pathname === "/api/check-payment" && PAY_TO_RELAY_ENABLED) {
        return await handleCheckPayment(request, env);
      }

      // Handle CORS preflight requests
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol',
            'Access-Control-Max-Age': '86400'
          }
        });
      }

      // Main endpoints
      if (url.pathname === "/") {
        if (request.headers.get("Upgrade") === "websocket") {
          // Get Cloudflare location info
          const cf = (request as any).cf;

          // Get optimal DO based on user location
          const { stub, doName } = await getOptimalDO(cf, env, url);

          // Add location info to the request
          const newUrl = new URL(request.url);
          newUrl.searchParams.set('region', cf?.region || 'unknown');
          newUrl.searchParams.set('colo', cf?.colo || 'unknown');
          newUrl.searchParams.set('continent', cf?.continent || 'unknown');
          newUrl.searchParams.set('country', cf?.country || 'unknown');
          newUrl.searchParams.set('doName', doName);

          return stub.fetch(new Request(newUrl, request));
        } else if (request.headers.get("Accept") === "application/nostr+json") {
          return handleRelayInfoRequest(request, env);
        } else {
          // Initialize database in background
          ctx.waitUntil(
            initializeDatabase(env.RELAY_DATABASE)
              .catch(e => console.error("DB init error:", e))
          );
          return serveLandingPage();
        }
      } else if (url.pathname === "/.well-known/nostr.json") {
        return handleNIP05Request(url);
      } else if (url.pathname === "/favicon.ico") {
        return await serveFavicon();
      } else if (url.pathname === "/docs") {
        return serveDocumentation();
      } else if (url.pathname === "/_migrations") {
        // Debug endpoint to check migration status
        const migrations = await env.RELAY_DATABASE.prepare(
          'SELECT version, description, datetime(applied_at, "unixepoch") as applied FROM schema_migrations ORDER BY version'
        ).all();
        const tables = await env.RELAY_DATABASE.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all();
        return Response.json({ migrations: migrations.results, tables: tables.results });
      } else {
        return new Response("Invalid request", { status: 400 });
      }
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  // Scheduled handler for archiving and maintenance
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled maintenance...');

    try {
      // Run archive process
      await archiveOldEvents(env.RELAY_DATABASE, env.EVENT_ARCHIVE);
      console.log('Archive process completed successfully');

      // Use PRAGMA optimize - much more efficient
      const session = env.RELAY_DATABASE.withSession('first-primary');
      await session.prepare('PRAGMA optimize').run();
      console.log('Database optimization completed');
    } catch (error) {
      console.error('Scheduled maintenance failed:', error);
    }
  }
};

// Export the Durable Object class
export { RelayWebSocket };