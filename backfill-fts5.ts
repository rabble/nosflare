// ABOUTME: Backfills existing events into FTS5 search tables in chunks
// ABOUTME: Processes 2000 events per request to avoid memory limits

interface Env {
  RELAY_DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(getHtmlPage(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/backfill' && request.method === 'POST') {
      return handleBackfill(env);
    }

    if (url.pathname === '/status') {
      return handleStatus(env);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleStatus(env: Env): Promise<Response> {
  try {
    const stats = await Promise.all([
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as total FROM events WHERE kind = 0').first(),
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM users_fts').first(),

      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as total FROM events WHERE kind = 34236').first(),
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM videos_fts').first(),

      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as total FROM events WHERE kind = 1').first(),
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM notes_fts').first(),

      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as total FROM events WHERE kind IN (30000, 30001, 30002, 30003)').first(),
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM lists_fts').first(),

      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as total FROM events WHERE kind = 30023').first(),
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM articles_fts').first(),

      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as total FROM events WHERE kind = 34550').first(),
      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM communities_fts').first(),

      env.RELAY_DATABASE.prepare('SELECT COUNT(*) as indexed FROM hashtags_fts').first(),
    ]);

    return new Response(JSON.stringify({
      users: { total: stats[0]?.total || 0, indexed: stats[1]?.indexed || 0 },
      videos: { total: stats[2]?.total || 0, indexed: stats[3]?.indexed || 0 },
      notes: { total: stats[4]?.total || 0, indexed: stats[5]?.indexed || 0 },
      lists: { total: stats[6]?.total || 0, indexed: stats[7]?.indexed || 0 },
      articles: { total: stats[8]?.total || 0, indexed: stats[9]?.indexed || 0 },
      communities: { total: stats[10]?.total || 0, indexed: stats[11]?.indexed || 0 },
      hashtags: { indexed: stats[12]?.indexed || 0 },
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleBackfill(env: Env): Promise<Response> {
  const start = Date.now();
  const CHUNK_SIZE = 2000; // Process 2000 events per request

  try {
    const db = env.RELAY_DATABASE;

    // Process one chunk at a time - find which type needs work
    const result = await processNextChunk(db, CHUNK_SIZE);

    const duration = (Date.now() - start) / 1000;

    return new Response(JSON.stringify({
      success: true,
      duration: `${duration.toFixed(2)}s`,
      ...result,
      message: result.complete ? 'Backfill complete!' : 'Continue backfilling - click Start Backfill again'
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function processNextChunk(db: D1Database, chunkSize: number) {
  const stats = {
    type: '',
    processed: 0,
    errors: [] as string[]
  };

  // Try users first
  console.log('Checking for unindexed users...');
  const users = await db
    .prepare(`SELECT * FROM events WHERE kind = 0 AND id NOT IN (SELECT event_id FROM users_fts) ORDER BY created_at DESC LIMIT ?`)
    .bind(chunkSize)
    .all();

  if (users.results.length > 0) {
    console.log(`Processing ${users.results.length} users...`);
    stats.type = 'users';
    const statements = [];

    for (const row of users.results) {
      try {
        const event = row as any;
        const profile = JSON.parse(event.content || '{}');
        statements.push(
          db.prepare('INSERT INTO users_fts(event_id, pubkey, name, display_name, about, nip05) VALUES (?, ?, ?, ?, ?, ?)').bind(
            event.id,
            event.pubkey,
            profile.name || '',
            profile.display_name || profile.displayName || '',
            profile.about || '',
            profile.nip05 || ''
          )
        );
        stats.processed++;
      } catch (e: any) {
        stats.errors.push(`User ${row.id}: ${e.message}`);
      }
    }

    await executeBatch(db, statements);
    return { ...stats, complete: false };
  }

  // Try videos
  console.log('Checking for unindexed videos...');
  const videos = await db
    .prepare(`SELECT * FROM events WHERE kind = 34236 AND id NOT IN (SELECT event_id FROM videos_fts) ORDER BY created_at DESC LIMIT ?`)
    .bind(chunkSize)
    .all();

  if (videos.results.length > 0) {
    console.log(`Processing ${videos.results.length} videos...`);
    stats.type = 'videos';
    const statements = [];

    for (const row of videos.results) {
      try {
        const event = row as any;
        const tags = event.tags ? JSON.parse(event.tags) : [];
        const title = tags.find((t: any[]) => t[0] === 'title')?.[1] || '';
        const summary = tags.find((t: any[]) => t[0] === 'summary')?.[1] || '';

        statements.push(
          db.prepare('INSERT INTO videos_fts(event_id, title, description, summary, content) VALUES (?, ?, ?, ?, ?)').bind(
            event.id,
            title,
            event.content || '',
            summary,
            event.content || ''
          )
        );
        stats.processed++;
      } catch (e: any) {
        stats.errors.push(`Video ${row.id}: ${e.message}`);
      }
    }

    await executeBatch(db, statements);
    return { ...stats, complete: false };
  }

  // Try notes
  console.log('Checking for unindexed notes...');
  const notes = await db
    .prepare(`SELECT * FROM events WHERE kind = 1 AND id NOT IN (SELECT event_id FROM notes_fts) ORDER BY created_at DESC LIMIT ?`)
    .bind(chunkSize)
    .all();

  if (notes.results.length > 0) {
    console.log(`Processing ${notes.results.length} notes...`);
    stats.type = 'notes';
    const statements = [];

    for (const row of notes.results) {
      try {
        const event = row as any;
        statements.push(
          db.prepare('INSERT INTO notes_fts(event_id, content) VALUES (?, ?)').bind(event.id, event.content || '')
        );
        stats.processed++;
      } catch (e: any) {
        stats.errors.push(`Note ${row.id}: ${e.message}`);
      }
    }

    await executeBatch(db, statements);
    return { ...stats, complete: false };
  }

  // Try lists
  console.log('Checking for unindexed lists...');
  const lists = await db
    .prepare(`SELECT * FROM events WHERE kind IN (30000, 30001, 30002, 30003) AND id NOT IN (SELECT event_id FROM lists_fts) ORDER BY created_at DESC LIMIT ?`)
    .bind(chunkSize)
    .all();

  if (lists.results.length > 0) {
    console.log(`Processing ${lists.results.length} lists...`);
    stats.type = 'lists';
    const statements = [];

    for (const row of lists.results) {
      try {
        const event = row as any;
        const tags = event.tags ? JSON.parse(event.tags) : [];
        const dTag = tags.find((t: any[]) => t[0] === 'd')?.[1] || '';
        const name = tags.find((t: any[]) => t[0] === 'name')?.[1] || '';
        const description = tags.find((t: any[]) => t[0] === 'description')?.[1] || '';

        statements.push(
          db.prepare('INSERT INTO lists_fts(event_id, d_tag, kind, name, description, content) VALUES (?, ?, ?, ?, ?, ?)').bind(
            event.id,
            dTag,
            event.kind,
            name,
            description,
            event.content || ''
          )
        );
        stats.processed++;
      } catch (e: any) {
        stats.errors.push(`List ${row.id}: ${e.message}`);
      }
    }

    await executeBatch(db, statements);
    return { ...stats, complete: false };
  }

  // Try articles
  console.log('Checking for unindexed articles...');
  const articles = await db
    .prepare(`SELECT * FROM events WHERE kind = 30023 AND id NOT IN (SELECT event_id FROM articles_fts) ORDER BY created_at DESC LIMIT ?`)
    .bind(chunkSize)
    .all();

  if (articles.results.length > 0) {
    console.log(`Processing ${articles.results.length} articles...`);
    stats.type = 'articles';
    const statements = [];

    for (const row of articles.results) {
      try {
        const event = row as any;
        const tags = event.tags ? JSON.parse(event.tags) : [];
        const dTag = tags.find((t: any[]) => t[0] === 'd')?.[1] || '';
        const title = tags.find((t: any[]) => t[0] === 'title')?.[1] || '';
        const summary = tags.find((t: any[]) => t[0] === 'summary')?.[1] || '';

        statements.push(
          db.prepare('INSERT INTO articles_fts(event_id, d_tag, title, summary, content) VALUES (?, ?, ?, ?, ?)').bind(
            event.id,
            dTag,
            title,
            summary,
            event.content || ''
          )
        );
        stats.processed++;
      } catch (e: any) {
        stats.errors.push(`Article ${row.id}: ${e.message}`);
      }
    }

    await executeBatch(db, statements);
    return { ...stats, complete: false };
  }

  // Try communities
  console.log('Checking for unindexed communities...');
  const communities = await db
    .prepare(`SELECT * FROM events WHERE kind = 34550 AND id NOT IN (SELECT event_id FROM communities_fts) ORDER BY created_at DESC LIMIT ?`)
    .bind(chunkSize)
    .all();

  if (communities.results.length > 0) {
    console.log(`Processing ${communities.results.length} communities...`);
    stats.type = 'communities';
    const statements = [];

    for (const row of communities.results) {
      try {
        const event = row as any;
        const tags = event.tags ? JSON.parse(event.tags) : [];
        const dTag = tags.find((t: any[]) => t[0] === 'd')?.[1] || '';
        const name = tags.find((t: any[]) => t[0] === 'name')?.[1] || '';
        const description = tags.find((t: any[]) => t[0] === 'description')?.[1] || '';

        statements.push(
          db.prepare('INSERT INTO communities_fts(event_id, d_tag, name, description) VALUES (?, ?, ?, ?)').bind(
            event.id,
            dTag,
            name,
            description
          )
        );
        stats.processed++;
      } catch (e: any) {
        stats.errors.push(`Community ${row.id}: ${e.message}`);
      }
    }

    await executeBatch(db, statements);
    return { ...stats, complete: false };
  }

  // All entity types done - return complete
  console.log('All entity types indexed!');
  return { ...stats, type: 'none', complete: true };
}

// Helper function to execute statements in batches (D1 limit is ~1000 per batch)
async function executeBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const BATCH_SIZE = 500;
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    console.log(`Executing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(statements.length / BATCH_SIZE)} (${batch.length} statements)...`);
    await db.batch(batch);
  }
}

function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>FTS5 Backfill Tool</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 { margin-top: 0; color: #333; }
    button {
      background: #0070f3;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      margin-right: 10px;
    }
    button:hover { background: #0051cc; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    #status { margin-top: 20px; }
    pre {
      background: #f4f4f4;
      padding: 12px;
      border-radius: 4px;
      overflow: auto;
    }
    .stat { display: inline-block; margin-right: 20px; }
    .progress { color: #0070f3; font-weight: bold; }
    .error { color: #e00; }
  </style>
</head>
<body>
  <div class="card">
    <h1>NIP-50 Search FTS5 Backfill</h1>
    <p>This tool backfills existing events into FTS5 search tables in chunks of 2000. Click "Start Backfill" multiple times until complete.</p>
    <button onclick="checkStatus()">Check Status</button>
    <button onclick="startBackfill()" id="backfillBtn">Start Backfill</button>
  </div>

  <div id="status"></div>

  <script>
    async function checkStatus() {
      document.getElementById('status').innerHTML = '<div class="card"><p class="progress">Checking status...</p></div>';
      try {
        const response = await fetch('/status');
        const data = await response.json();
        document.getElementById('status').innerHTML = \`
          <div class="card">
            <h2>Current Status</h2>
            <div class="stat">Users: \${data.users.indexed} / \${data.users.total}</div>
            <div class="stat">Videos: \${data.videos.indexed} / \${data.videos.total}</div>
            <div class="stat">Notes: \${data.notes.indexed} / \${data.notes.total}</div><br>
            <div class="stat">Lists: \${data.lists.indexed} / \${data.lists.total}</div>
            <div class="stat">Articles: \${data.articles.indexed} / \${data.articles.total}</div>
            <div class="stat">Communities: \${data.communities.indexed} / \${data.communities.total}</div><br>
            <div class="stat">Hashtags: \${data.hashtags.indexed}</div>
          </div>
        \`;
      } catch (error) {
        document.getElementById('status').innerHTML = '<div class="card"><p class="error">Error: ' + error.message + '</p></div>';
      }
    }

    async function startBackfill() {
      const btn = document.getElementById('backfillBtn');
      btn.disabled = true;
      document.getElementById('status').innerHTML = '<div class="card"><p class="progress">Processing chunk...</p></div>';

      try {
        const response = await fetch('/backfill', { method: 'POST' });
        const data = await response.json();

        if (data.success) {
          document.getElementById('status').innerHTML = \`
            <div class="card">
              <h2>Chunk Complete!</h2>
              <p>Duration: \${data.duration}</p>
              <p>Type: \${data.type || 'none'}</p>
              <p>Processed: \${data.processed || 0} events</p>
              <p class="progress">\${data.message}</p>
              \${data.errors && data.errors.length > 0 ? '<p class="error">Errors: ' + data.errors.length + '</p><pre>' + data.errors.join('\\n') + '</pre>' : ''}
            </div>
          \`;
          // Auto-check status after completion
          setTimeout(checkStatus, 500);
        } else {
          document.getElementById('status').innerHTML = '<div class="card"><p class="error">Error: ' + data.error + '</p></div>';
        }
      } catch (error) {
        document.getElementById('status').innerHTML = '<div class="card"><p class="error">Error: ' + error.message + '</p></div>';
      } finally {
        btn.disabled = false;
      }
    }

    // Auto-check status on load
    checkStatus();
  </script>
</body>
</html>`;
}
