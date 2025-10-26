// ABOUTME: Script to restore archived events from R2 back into D1
// ABOUTME: Reads all events from R2 archive and re-inserts them into D1 database

import { NostrEvent } from './src/types';

interface Env {
  RELAY_DATABASE: D1Database;
  EVENT_ARCHIVE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log('Starting R2 to D1 restoration process...');

    try {
      // Load manifest to get all archived hours
      const manifestObj = await env.EVENT_ARCHIVE.get('manifest.json');
      if (!manifestObj) {
        return new Response('No manifest.json found in R2 bucket', { status: 404 });
      }

      const manifest = JSON.parse(await manifestObj.text());
      const hours = manifest.hoursWithEvents || [];

      console.log(`Found ${hours.length} hours with archived events`);

      let totalRestored = 0;
      let errors: string[] = [];

      // Process each hour
      for (const hourKey of hours) {
        console.log(`Processing hour: ${hourKey}`);

        try {
          // Get events for this hour
          const eventsFile = await env.EVENT_ARCHIVE.get(`events/${hourKey}.jsonl`);
          if (!eventsFile) {
            console.log(`No events file found for ${hourKey}`);
            continue;
          }

          const eventsText = await eventsFile.text();
          const eventLines = eventsText.split('\n').filter(line => line.trim());

          console.log(`Found ${eventLines.length} events in ${hourKey}`);

          if (eventLines.length === 0) {
            console.log(`⚠️  No events in ${hourKey}, file might be empty`);
            continue;
          }

          // Process events in batches
          let skipped = 0;
          let inserted = 0;

          for (const line of eventLines) {
            try {
              const event: NostrEvent = JSON.parse(line);

              if (!event.id || !event.pubkey) {
                console.log(`⚠️  Invalid event structure in ${hourKey}`);
                continue;
              }

              // Check if event already exists in D1
              const existing = await env.RELAY_DATABASE.prepare(
                'SELECT id FROM events WHERE id = ?'
              ).bind(event.id).first();

              if (existing) {
                skipped++;
                continue;
              }

              // Insert event into D1
              await env.RELAY_DATABASE.prepare(`
                INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).bind(
                event.id,
                event.pubkey,
                event.created_at,
                event.kind,
                JSON.stringify(event.tags),
                event.content,
                event.sig
              ).run();

              // Insert tags
              for (const tag of event.tags) {
                const tagName = tag[0];
                for (let i = 1; i < tag.length; i++) {
                  await env.RELAY_DATABASE.prepare(`
                    INSERT OR IGNORE INTO tags (event_id, tag_name, tag_value)
                    VALUES (?, ?, ?)
                  `).bind(event.id, tagName, tag[i]).run();
                }
              }

              // Update event_tags_cache for common tags (uses first value only)
              const tagP = event.tags.find(t => t[0] === 'p')?.[1] || null;
              const tagE = event.tags.find(t => t[0] === 'e')?.[1] || null;
              const tagA = event.tags.find(t => t[0] === 'a')?.[1] || null;

              if (tagP || tagE || tagA) {
                await env.RELAY_DATABASE.prepare(`
                  INSERT OR IGNORE INTO event_tags_cache (event_id, pubkey, kind, created_at, tag_p, tag_e, tag_a)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                `).bind(event.id, event.pubkey, event.kind, event.created_at, tagP, tagE, tagA).run();
              }

              totalRestored++;
              inserted++;

              if (totalRestored % 100 === 0) {
                console.log(`✓ Restored ${totalRestored} events so far...`);
              }

            } catch (error) {
              const err = error as Error;
              console.error(`❌ Error restoring event from ${hourKey}: ${err.message}`);
              errors.push(`${hourKey}: ${err.message}`);
            }
          }

          console.log(`  ${hourKey}: ${inserted} inserted, ${skipped} skipped, ${eventLines.length} total`);

        } catch (error) {
          const err = error as Error;
          console.error(`Error processing hour ${hourKey}: ${err.message}`);
          errors.push(`Hour ${hourKey}: ${err.message}`);
        }
      }

      const response = {
        success: true,
        totalRestored,
        hoursProcessed: hours.length,
        errors: errors.length > 0 ? errors : undefined
      };

      console.log('Restoration complete:', response);
      return new Response(JSON.stringify(response, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      const err = error as Error;
      console.error('Restoration failed:', err);
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
