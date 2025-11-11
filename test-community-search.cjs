const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools');

async function testCommunitySearch() {
  console.log('Testing community search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate a test key pair
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      // Create and sign a test community event (kind 34550)
      const testCommunity = finalizeEvent({
        kind: 34550,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'bitcoin-community'],
          ['name', 'Bitcoin Enthusiasts'],
          ['description', 'A community for bitcoin lovers and cryptocurrency enthusiasts']
        ],
        content: 'Join us to discuss bitcoin, lightning network, and crypto adoption'
      }, sk);

      ws.send(JSON.stringify(['EVENT', testCommunity]));

      await new Promise(r => setTimeout(r, 500));

      // Search for bitcoin communities
      const searchReq = JSON.stringify([
        'REQ',
        'search-communities',
        {
          search: 'type:community bitcoin',
          kinds: [34550],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-communities') {
        receivedResults = true;
        console.log('✓ Received community search result');
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-communities') {
        if (receivedResults) {
          console.log('✓ Community search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No community search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testCommunitySearch().then(() => {
  console.log('\n✓ Community search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
