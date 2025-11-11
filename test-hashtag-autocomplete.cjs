// ABOUTME: Test for hashtag autocomplete using FTS5 trigram search
// ABOUTME: Tests publishing events with hashtags and searching for prefix matches

const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools/pure');

const RELAY_URL = 'ws://127.0.0.1:8787';
const TEST_PRIVKEY = generateSecretKey();
const TEST_PUBKEY = getPublicKey(TEST_PRIVKEY);

async function testHashtagAutocomplete() {
  console.log('\n🧪 Testing hashtag autocomplete with FTS5...\n');

  const ws = new WebSocket(RELAY_URL);

  await new Promise((resolve, reject) => {
    let receivedResults = 0;
    const foundHashtags = new Set();

    ws.on('open', async () => {
      console.log('✓ Connected to relay');

      // Publish test events with hashtags starting with "dan"
      const testEvents = [
        { hashtags: ['dance', 'music'] },
        { hashtags: ['dancing', 'party'] },
        { hashtags: ['danube', 'river'] }
      ];

      for (const testData of testEvents) {
        const event = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: testData.hashtags.map(h => ['t', h]),
          content: `Test note with hashtags: ${testData.hashtags.join(' ')}`,
          pubkey: TEST_PUBKEY
        };

        const signedEvent = finalizeEvent(event, TEST_PRIVKEY);
        ws.send(JSON.stringify(['EVENT', signedEvent]));
      }

      // Wait for indexing
      await new Promise(r => setTimeout(r, 1000));

      console.log('✓ Published 3 events with hashtags: dance, dancing, danube');

      // Search for hashtags starting with "dan" using NIP-50 search
      const searchReq = JSON.stringify([
        'REQ',
        'hashtag-search',
        {
          search: 'hashtag:#dan',
          limit: 10
        }
      ]);

      console.log('Searching for hashtags starting with "dan"...');
      ws.send(searchReq);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg[0] === 'EVENT' && msg[1] === 'hashtag-search') {
        receivedResults++;
        try {
          const content = JSON.parse(msg[2].content);
          if (content.hashtag) {
            foundHashtags.add(content.hashtag);
            console.log(`  ✓ Found hashtag: #${content.hashtag}`);
          }
        } catch (e) {
          console.log('  Received event:', msg[2].id);
        }
      }

      if (msg[0] === 'EOSE' && msg[1] === 'hashtag-search') {
        console.log(`\nReceived ${receivedResults} results for "dan" prefix`);
        console.log(`Found hashtags: ${Array.from(foundHashtags).join(', ')}`);

        // Must have at least 2 hashtag results (not just regular events)
        if (foundHashtags.size >= 2) {
          console.log('\n✓ Hashtag autocomplete working!');
          ws.close();
          resolve();
        } else {
          console.error(`\n❌ Expected at least 2 hashtag results, got ${foundHashtags.size} (${receivedResults} total results)`);
          ws.close();
          reject(new Error('Insufficient hashtag results'));
        }
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      reject(err);
    });
  });
}

testHashtagAutocomplete().then(() => {
  console.log('\n✓ Hashtag autocomplete test passed!');
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
