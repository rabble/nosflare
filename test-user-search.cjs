const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools/pure');

async function testUserSearch() {
  console.log('Testing user profile search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate a test keypair
      const testPrivkey = generateSecretKey();
      const testPubkey = getPublicKey(testPrivkey);

      // First, publish a test user profile
      const profileEvent = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          name: 'testuser',
          display_name: 'Test User',
          about: 'I am a test user for search testing',
          nip05: 'test@example.com'
        }),
        pubkey: testPubkey
      };

      // Sign the event
      const signedProfile = finalizeEvent(profileEvent, testPrivkey);

      // Publish profile
      ws.send(JSON.stringify(['EVENT', signedProfile]));

      // Wait a moment for indexing
      await new Promise(r => setTimeout(r, 500));

      // Now search for the user
      const searchReq = JSON.stringify([
        'REQ',
        'search-user',
        {
          search: 'type:user testuser',
          kinds: [0],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'search-user') {
        receivedResults = true;
        console.log('✓ Received search result:', msg[2].content);
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-user') {
        if (receivedResults) {
          console.log('✓ User search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No search results returned');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testUserSearch().then(() => {
  console.log('\n✓ User search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
