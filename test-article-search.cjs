const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools');

async function testArticleSearch() {
  console.log('Testing long-form article search...');

  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    let receivedResults = false;

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Generate a test key pair
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);

      // Create and sign a test article event (kind 30023)
      const testArticle = finalizeEvent({
        kind: 30023,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test-article-nostr-protocol'],
          ['title', 'Understanding the Nostr Protocol'],
          ['summary', 'A comprehensive guide to the Nostr protocol and its implementation'],
          ['published_at', Math.floor(Date.now() / 1000).toString()],
          ['t', 'nostr'],
          ['t', 'protocol']
        ],
        content: 'The Nostr protocol is a revolutionary decentralized communication protocol. It provides censorship-resistant social networking by using cryptographic keys and relay servers. This article explores the technical details and implementation considerations.'
      }, sk);

      ws.send(JSON.stringify(['EVENT', testArticle]));

      await new Promise(r => setTimeout(r, 500));

      // Search for articles about nostr protocol
      const searchReq = JSON.stringify([
        'REQ',
        'search-articles',
        {
          search: 'type:article nostr protocol',
          kinds: [30023],
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

      if (msg[0] === 'EVENT' && msg[1] === 'search-articles') {
        receivedResults = true;
        const event = msg[2];
        const title = event.tags.find(t => t[0] === 'title')?.[1];
        console.log('✓ Received article search result:', title);
      }

      if (msg[0] === 'EOSE' && msg[1] === 'search-articles') {
        if (receivedResults) {
          console.log('✓ Article search working!');
          ws.close();
          resolve();
        } else {
          console.error('❌ No article search results');
          ws.close();
          reject(new Error('No results'));
        }
      }
    });

    ws.on('error', reject);
  });
}

testArticleSearch().then(() => {
  console.log('\n✓ Article search test passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
