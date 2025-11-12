const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools/pure');

// Configuration
const RELAY_URL = 'wss://nosflare.protestnet.workers.dev';
const TEST_PRIVKEY = generateSecretKey();
const TEST_PUBKEY = getPublicKey(TEST_PRIVKEY);

// Helper to generate random hex string (64 chars for pubkey)
function randomHex(length = 64) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// Helper to create a video event with specific tags
function createVideoEvent(tags) {
  const event = {
    pubkey: TEST_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: 34236,
    tags: tags,
    content: 'Test video with tags'
  };

  // Properly sign the event
  const signedEvent = finalizeEvent(event, TEST_PRIVKEY);
  return signedEvent;
}

// Helper to publish event and wait for OK
function publishEvent(ws, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for OK')), 5000);

    const messageHandler = (data) => {
      const msg = JSON.parse(data);
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timeout);
        ws.off('message', messageHandler);
        resolve(msg);
      }
    };

    ws.on('message', messageHandler);
    ws.send(JSON.stringify(['EVENT', event]));
  });
}

// Helper to query and wait for EOSE
function queryEvents(ws, filter) {
  return new Promise((resolve, reject) => {
    const events = [];
    const subId = 'test-' + Date.now();
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for EOSE')), 5000);

    const messageHandler = (data) => {
      const msg = JSON.parse(data);
      if (msg[0] === 'EVENT' && msg[1] === subId) {
        events.push(msg[2]);
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        clearTimeout(timeout);
        ws.off('message', messageHandler);
        resolve(events);
      }
    };

    ws.on('message', messageHandler);
    ws.send(JSON.stringify(['REQ', subId, filter]));
  });
}

async function runTests() {
  const ws = new WebSocket(RELAY_URL);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });

  console.log('Connected to relay\n');

  try {
    // Test 1: Publish video with #p tag (mention)
    console.log('Test 1: Publishing video with #p tag...');
    const mentionPubkey = randomHex(64);
    const videoWithP = createVideoEvent([
      ['t', 'test'],
      ['p', mentionPubkey],
      ['loops', '100']
    ]);

    const okP = await publishEvent(ws, videoWithP);
    console.log(`✓ Published video with #p tag: ${okP[2] ? 'accepted' : 'rejected'}`);
    if (!okP[2]) {
      console.error(`  Error: ${okP[3]}`);
      throw new Error('Failed to publish video with #p tag');
    }

    // Test 2: Query by #p tag
    console.log('\nTest 2: Querying videos by #p tag...');
    const resultsP = await queryEvents(ws, {
      kinds: [34236],
      '#p': [mentionPubkey]
    });
    console.log(`  Found ${resultsP.length} event(s)`);

    const foundP = resultsP.find(e => e.id === videoWithP.id);
    if (foundP) {
      console.log('✓ Video with #p tag found by query');
    } else {
      console.error('✗ Video with #p tag NOT found by query');
      throw new Error('Failed to query by #p tag');
    }

    // Test 3: Publish video with #e tag (reference)
    console.log('\nTest 3: Publishing video with #e tag...');
    const referenceEventId = randomHex(64);
    const videoWithE = createVideoEvent([
      ['t', 'test'],
      ['e', referenceEventId],
      ['likes', '50']
    ]);

    const okE = await publishEvent(ws, videoWithE);
    console.log(`✓ Published video with #e tag: ${okE[2] ? 'accepted' : 'rejected'}`);
    if (!okE[2]) {
      console.error(`  Error: ${okE[3]}`);
      throw new Error('Failed to publish video with #e tag');
    }

    // Test 4: Query by #e tag
    console.log('\nTest 4: Querying videos by #e tag...');
    const resultsE = await queryEvents(ws, {
      kinds: [34236],
      '#e': [referenceEventId]
    });
    console.log(`  Found ${resultsE.length} event(s)`);

    const foundE = resultsE.find(e => e.id === videoWithE.id);
    if (foundE) {
      console.log('✓ Video with #e tag found by query');
    } else {
      console.error('✗ Video with #e tag NOT found by query');
      throw new Error('Failed to query by #e tag');
    }

    // Test 5: Publish video with #a tag (address)
    console.log('\nTest 5: Publishing video with #a tag...');
    const addressTag = '34550:' + randomHex(64) + ':d-tag';
    const videoWithA = createVideoEvent([
      ['t', 'test'],
      ['a', addressTag],
      ['views', '1000']
    ]);

    const okA = await publishEvent(ws, videoWithA);
    console.log(`✓ Published video with #a tag: ${okA[2] ? 'accepted' : 'rejected'}`);
    if (!okA[2]) {
      console.error(`  Error: ${okA[3]}`);
      throw new Error('Failed to publish video with #a tag');
    }

    // Test 6: Query by #a tag
    console.log('\nTest 6: Querying videos by #a tag...');
    const resultsA = await queryEvents(ws, {
      kinds: [34236],
      '#a': [addressTag]
    });
    console.log(`  Found ${resultsA.length} event(s)`);

    const foundA = resultsA.find(e => e.id === videoWithA.id);
    if (foundA) {
      console.log('✓ Video with #a tag found by query');
    } else {
      console.error('✗ Video with #a tag NOT found by query');
      throw new Error('Failed to query by #a tag');
    }

    // Test 7: Combined filter - #p tag with sort by likes
    console.log('\nTest 7: Publishing another video with same #p tag for sort testing...');
    const videoWithP2 = createVideoEvent([
      ['t', 'test'],
      ['p', mentionPubkey],
      ['loops', '200'],
      ['likes', '150']
    ]);

    await publishEvent(ws, videoWithP2);

    console.log('Querying with #p tag and sort by likes...');
    const sortedResults = await queryEvents(ws, {
      kinds: [34236],
      '#p': [mentionPubkey],
      sort: { field: 'likes', dir: 'desc' }
    });
    console.log(`  Found ${sortedResults.length} event(s)`);

    if (sortedResults.length >= 2) {
      const first = sortedResults[0];
      const second = sortedResults[1];

      // Extract likes from tags
      const getLikes = (event) => {
        const likesTag = event.tags.find(t => t[0] === 'likes');
        return likesTag ? parseInt(likesTag[1], 10) : 0;
      };

      const firstLikes = getLikes(first);
      const secondLikes = getLikes(second);

      console.log(`  First video likes: ${firstLikes}`);
      console.log(`  Second video likes: ${secondLikes}`);

      if (firstLikes >= secondLikes) {
        console.log('✓ Videos correctly sorted by likes (descending)');
      } else {
        console.error('✗ Videos NOT correctly sorted by likes');
        throw new Error('Sort order incorrect');
      }
    } else {
      console.log('⚠️  Not enough videos to test sorting');
    }

    // Test 8: Multiple #p values
    console.log('\nTest 8: Querying with multiple #p values...');
    const anotherPubkey = randomHex(64);
    const videoWithP3 = createVideoEvent([
      ['t', 'test'],
      ['p', anotherPubkey],
      ['loops', '50']
    ]);

    await publishEvent(ws, videoWithP3);

    const multiResults = await queryEvents(ws, {
      kinds: [34236],
      '#p': [mentionPubkey, anotherPubkey]
    });
    console.log(`  Found ${multiResults.length} event(s) with either #p tag`);

    const hasFirst = multiResults.some(e => e.id === videoWithP.id || e.id === videoWithP2.id);
    const hasSecond = multiResults.some(e => e.id === videoWithP3.id);

    if (hasFirst && hasSecond) {
      console.log('✓ Multiple #p values work correctly (OR logic)');
    } else {
      console.error('✗ Multiple #p values not working as expected');
      throw new Error('Multiple #p values failed');
    }

    console.log('\n========================================');
    console.log('ALL TESTS PASSED!');
    console.log('========================================');

  } catch (error) {
    console.error('\n========================================');
    console.error('TEST FAILED:', error.message);
    console.error('========================================');
    process.exit(1);
  } finally {
    ws.close();
  }
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
