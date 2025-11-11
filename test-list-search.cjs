const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools');

async function testListSearch() {
  console.log('Testing list search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate a test key pair
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      // Create and sign a test list event (kind 30000 - follow list)
      const testList = finalizeEvent({
        kind: 30000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'bitcoin-podcasters'],
          ['name', 'Bitcoin Podcasts'],
          ['description', 'Best Bitcoin and cryptocurrency podcasts'],
          ['p', 'abc123...', 'podcaster1'],
          ['p', 'def456...', 'podcaster2']
        ],
        content: 'A curated list of the best Bitcoin podcasts'
      }, sk);

      ws.send(JSON.stringify(['EVENT', testList]));

      await new Promise(r => setTimeout(r, 500));

      // Search for lists about bitcoin podcasts
      const searchReq = JSON.stringify([
        'REQ',
        'search-lists',
        {
          search: 'type:list bitcoin podcasts',
          kinds: [30000, 30001, 30002, 30003],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-lists') {
        receivedResults = true;
        console.log('✓ Received list search result');
        const tags = msg[2].tags;
        const dTag = tags.find(t => t[0] === 'd')?.[1];
        const name = tags.find(t => t[0] === 'name')?.[1];
        console.log(`  d_tag: ${dTag}, name: ${name}`);
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-lists') {
        if (receivedResults) {
          console.log('✓ List search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No list search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testListSearch().then(() => {
  console.log('\n✓ List search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
