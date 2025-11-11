const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools');

async function testUnifiedSearch() {
  console.log('Testing unified search across all types...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    const receivedTypes = new Set();

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate test key pair
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      // Publish various entity types with "nostr" keyword
      const entities = [
        { kind: 0, tags: [], content: JSON.stringify({ name: 'nostrdev', about: 'Nostr developer' }) },
        { kind: 1, tags: [], content: 'Learning about Nostr protocol today' },
        { kind: 34236, tags: [['title', 'Nostr Tutorial Video'], ['d', 'test-video-' + Date.now()]], content: 'Introduction to Nostr' }
      ];

      for (const entity of entities) {
        const event = finalizeEvent({
          kind: entity.kind,
          created_at: Math.floor(Date.now() / 1000),
          tags: entity.tags,
          content: entity.content
        }, sk);
        ws.send(JSON.stringify(['EVENT', event]));
      }

      await new Promise(r => setTimeout(r, 2000));

      // Unified search without type filter
      const searchReq = JSON.stringify([
        'REQ',
        'search-unified',
        {
          search: 'nostr',
          limit: 50
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-unified') {
        receivedTypes.add(msg[2].kind);
        console.log(`✓ Received result of kind ${msg[2].kind}`);
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-unified') {
        if (receivedTypes.size >= 2) {
          console.log(`✓ Unified search working! Found ${receivedTypes.size} different entity types`);
          ws.close();
          resolve();
        } else {
          console.error(`❌ Expected multiple types, got ${receivedTypes.size}`);
          ws.close();
          reject(new Error('Insufficient type diversity'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testUnifiedSearch().then(() => {
  console.log('\n✓ Unified search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
