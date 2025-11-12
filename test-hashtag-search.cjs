// ABOUTME: Simple test to verify hashtag search works with multi-hashtag support
// ABOUTME: Tests publishing a video with multiple hashtags and querying for each one

const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey, getPublicKey } = require('nostr-tools/pure');

const RELAY_URL = 'wss://nosflare.protestnet.workers.dev';
const TEST_PRIVKEY = generateSecretKey();
const TEST_PUBKEY = getPublicKey(TEST_PRIVKEY);

let ws;
let testEventId;

function randomHex(length = 64) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function createVideoWithHashtags(hashtags) {
  const tags = [
    ['url', 'https://example.com/video.mp4'],
    ['m', 'video/mp4'],
    ['dim', '1080x1920'],
    ['duration', '6'],
    ['fallback', 'https://example.com/video.mp4']
  ];

  // Add all hashtags
  for (const tag of hashtags) {
    tags.push(['t', tag]);
  }

  const event = {
    kind: 34236,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: 'Test video with multiple hashtags',
    pubkey: TEST_PUBKEY
  };

  return finalizeEvent(event, TEST_PRIVKEY);
}

function waitForMessage(ws, filter, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for message'));
    }, timeout);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (filter(msg)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    ws.on('message', handler);
  });
}

async function runTests() {
  console.log('\n🧪 Hashtag Search Test\n');

  // Connect to relay
  ws = new WebSocket(RELAY_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('✓ Connected to relay\n');

  // Test 1: Publish video with 3 hashtags
  console.log('Test 1: Publishing video with hashtags: dance, music, fun');
  const testHashtags = ['dance', 'music', 'fun'];
  const videoEvent = createVideoWithHashtags(testHashtags);
  testEventId = videoEvent.id;

  ws.send(JSON.stringify(['EVENT', videoEvent]));
  const okMsg = await waitForMessage(ws, msg => msg[0] === 'OK' && msg[1] === videoEvent.id);

  if (okMsg[2]) {
    console.log('✓ Video published successfully\n');
  } else {
    console.log(`✗ Failed to publish: ${okMsg[3]}\n`);
    process.exit(1);
  }

  // Wait a moment for indexing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Test 2: Search for each hashtag individually
  for (const hashtag of testHashtags) {
    console.log(`Test 2.${testHashtags.indexOf(hashtag) + 1}: Searching for #${hashtag}...`);

    const subId = `test-${hashtag}-${Date.now()}`;
    const filter = {
      kinds: [34236],
      '#t': [hashtag],
      limit: 10
    };

    ws.send(JSON.stringify(['REQ', subId, filter]));

    let found = false;
    let eventCount = 0;
    const startTime = Date.now();

    while (Date.now() - startTime < 3000) {
      try {
        const msg = await waitForMessage(ws, m => {
          if (m[0] === 'EVENT' && m[1] === subId) {
            return true;
          }
          if (m[0] === 'EOSE' && m[1] === subId) {
            return true;
          }
          return false;
        }, 1000);

        if (msg[0] === 'EVENT') {
          eventCount++;
          if (msg[2].id === testEventId) {
            found = true;
          }
        } else if (msg[0] === 'EOSE') {
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (found) {
      console.log(`  ✓ Found our video in #${hashtag} results (${eventCount} total events)\n`);
    } else {
      console.log(`  ✗ Video NOT found in #${hashtag} results (${eventCount} total events)\n`);
    }

    // Close subscription
    ws.send(JSON.stringify(['CLOSE', subId]));
  }

  // Test 3: Search with multiple hashtags (OR logic)
  console.log('Test 3: Searching for multiple hashtags at once (dance OR music)...');
  const multiSubId = `test-multi-${Date.now()}`;
  const multiFilter = {
    kinds: [34236],
    '#t': ['dance', 'music'],
    limit: 10
  };

  ws.send(JSON.stringify(['REQ', multiSubId, multiFilter]));

  let foundMulti = false;
  let multiCount = 0;
  const startTimeMulti = Date.now();

  while (Date.now() - startTimeMulti < 3000) {
    try {
      const msg = await waitForMessage(ws, m => {
        if (m[0] === 'EVENT' && m[1] === multiSubId) {
          return true;
        }
        if (m[0] === 'EOSE' && m[1] === multiSubId) {
          return true;
        }
        return false;
      }, 1000);

      if (msg[0] === 'EVENT') {
        multiCount++;
        if (msg[2].id === testEventId) {
          foundMulti = true;
        }
      } else if (msg[0] === 'EOSE') {
        break;
      }
    } catch (e) {
      break;
    }
  }

  if (foundMulti) {
    console.log(`  ✓ Found our video in multi-hashtag query (${multiCount} total events)\n`);
  } else {
    console.log(`  ✗ Video NOT found in multi-hashtag query (${multiCount} total events)\n`);
  }

  ws.send(JSON.stringify(['CLOSE', multiSubId]));

  // Test 4: Verify video has all hashtags in database
  console.log('Test 4: Verifying video appears in all three hashtag searches...');
  let allFound = true;
  for (const hashtag of testHashtags) {
    const checkSubId = `verify-${hashtag}-${Date.now()}`;
    ws.send(JSON.stringify(['REQ', checkSubId, { kinds: [34236], '#t': [hashtag], ids: [testEventId] }]));

    let hashtagFound = false;
    const verifyStart = Date.now();

    while (Date.now() - verifyStart < 2000) {
      try {
        const msg = await waitForMessage(ws, m => {
          if (m[0] === 'EVENT' && m[1] === checkSubId && m[2].id === testEventId) {
            return true;
          }
          if (m[0] === 'EOSE' && m[1] === checkSubId) {
            return true;
          }
          return false;
        }, 500);

        if (msg[0] === 'EVENT') {
          hashtagFound = true;
          break;
        } else if (msg[0] === 'EOSE') {
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (!hashtagFound) {
      console.log(`  ✗ Missing hashtag: #${hashtag}`);
      allFound = false;
    }

    ws.send(JSON.stringify(['CLOSE', checkSubId]));
  }

  if (allFound) {
    console.log('  ✓ Video correctly indexed with all hashtags\n');
  }

  ws.close();

  console.log('\n========================================');
  console.log('HASHTAG SEARCH TESTS COMPLETE!');
  console.log('========================================\n');
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
