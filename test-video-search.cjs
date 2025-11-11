const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools');

async function testVideoSearch() {
  console.log('Testing video content search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate a test key pair
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      // Create and sign a test video event
      const testVideo = finalizeEvent({
        kind: 34236,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test-video-123'],
          ['title', 'Funny Dance Tutorial'],
          ['summary', 'Learn to dance like a pro'],
          ['t', 'dance'],
          ['t', 'tutorial']
        ],
        content: 'This is a comprehensive guide to dancing with style and grace'
      }, sk);

      ws.send(JSON.stringify(['EVENT', testVideo]));

      await new Promise(r => setTimeout(r, 500));

      // Search for dancing videos
      const searchReq = JSON.stringify([
        'REQ',
        'search-videos',
        {
          search: 'type:video dancing',
          kinds: [34236],
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

      if (msg[0] === 'EVENT' && msg[1] === 'search-videos') {
        receivedResults = true;
        console.log('✓ Received video search result');
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-videos') {
        if (receivedResults) {
          console.log('✓ Video search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No video search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testVideoSearch().then(() => {
  console.log('\n✓ Video search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
