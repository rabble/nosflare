const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools');

async function testNoteSearch() {
  console.log('Testing note content search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate a test key pair
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      // Create and sign a test note event
      const testNote = finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'Just learned about the Nostr protocol and Bitcoin integration. Amazing stuff!'
      }, sk);

      ws.send(JSON.stringify(['EVENT', testNote]));

      await new Promise(r => setTimeout(r, 500));

      // Search notes
      const searchReq = JSON.stringify([
        'REQ',
        'search-notes',
        {
          search: 'type:note Nostr protocol',
          kinds: [1],
          limit: 10
        }
      ]);

      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Received message:', msg[0], msg[1] || '');

      if (msg[0] === 'OK') {
        console.log('✓ Event published:', msg[1], msg[2], msg[3] || '');
      }

      if (msg[0] === 'EVENT' && msg[1] === 'search-notes') {
        const event = msg[2];
        // Verify it's our test note with the search terms
        if (event.content.includes('Nostr protocol')) {
          receivedResults = true;
          console.log('✓ Received correct note search result');
        } else {
          console.error('❌ Received event but does not match search:', event.content);
        }
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-notes') {
        if (receivedResults) {
          console.log('✓ Note search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No note search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testNoteSearch().then(() => {
  console.log('\n✓ Note search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
