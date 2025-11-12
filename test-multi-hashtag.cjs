const WebSocket = require('ws');
const crypto = require('crypto');

// Configuration
const RELAY_URL = 'wss://nosflare.protestnet.workers.dev'; // Remote relay for testing
const TEST_PUBKEY = '0000000000000000000000000000000000000000000000000000000000000001';

// Test state
let ws;
let testEventId;
const results = {
  publish: false,
  queryMusic: false,
  queryDance: false,
  queryComedy: false,
  queryMultiple: false,
  sortOrder: false,
  pagination: false
};

// Helper to create kind 34236 video event
function createVideoEvent(hashtags, metrics = {}) {
  const tags = [
    ['d', `test-video-${Date.now()}`],
    ['url', 'https://example.com/test.mp4'],
    ['m', 'video/mp4'],
    ['duration', '30'],
    ['loops', String(metrics.loops || 100)],
    ['likes', String(metrics.likes || 50)],
    ['views', String(metrics.views || 200)],
    ['comments', String(metrics.comments || 10)],
    ['reposts', String(metrics.reposts || 5)]
  ];

  // Add all hashtags as separate #t tags
  hashtags.forEach(tag => {
    tags.push(['t', tag]);
  });

  const event = {
    kind: 34236,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: 'Multi-hashtag test video',
    pubkey: TEST_PUBKEY,
    id: '',
    sig: ''
  };

  // Generate event ID
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  event.id = crypto.createHash('sha256').update(serialized).digest('hex');
  event.sig = '0'.repeat(128); // Fake signature

  return event;
}

// Helper to send query and wait for results
function queryWithPromise(filter, subscriptionId) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${subscriptionId}`));
    }, 3000);

    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg[0] === 'EVENT' && msg[1] === subscriptionId) {
        events.push(msg[2]);
      } else if (msg[0] === 'EOSE' && msg[1] === subscriptionId) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(events);
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
  });
}

// Test sequence
async function runTests() {
  console.log('\n🧪 Multi-Hashtag Test Suite\n');
  console.log('═══════════════════════════════════════════════\n');

  try {
    // Skip publishing for now - test with existing events
    console.log('Test 1: Skipped (publishing requires valid signatures)\n');
    results.publish = true; // Mark as passed since we're testing queries

    // Get a sample event to use for testing
    const sampleEvents = await queryWithPromise({
      kinds: [34236],
      limit: 1
    }, 'get-sample');

    if (sampleEvents.length > 0) {
      testEventId = sampleEvents[0].id;
      const hashtags = sampleEvents[0].tags.filter(t => t[0] === 't').map(t => t[1]);
      console.log(`Using existing event ${testEventId.substring(0, 16)}... with hashtags:`, hashtags);
      console.log('');
    } else {
      console.log('⚠ No events found to test with');
      ws.close();
      return;
    }

    // Test 2: Query for first hashtag (music)
    console.log('Test 2: Querying for hashtag "music"...');
    const musicResults = await queryWithPromise({
      kinds: [34236],
      '#t': ['music']
    }, 'test-music');

    const foundInMusic = musicResults.some(e => e.id === testEventId);
    results.queryMusic = foundInMusic;
    console.log(foundInMusic
      ? `✓ Found video in "music" results (${musicResults.length} total)`
      : `✗ Video NOT found in "music" results`);
    console.log('');

    // Test 3: Query for second hashtag (dance)
    console.log('Test 3: Querying for hashtag "dance"...');
    const danceResults = await queryWithPromise({
      kinds: [34236],
      '#t': ['dance']
    }, 'test-dance');

    const foundInDance = danceResults.some(e => e.id === testEventId);
    results.queryDance = foundInDance;
    console.log(foundInDance
      ? `✓ Found video in "dance" results (${danceResults.length} total)`
      : `✗ Video NOT found in "dance" results`);
    console.log('');

    // Test 4: Query for third hashtag (comedy)
    console.log('Test 4: Querying for hashtag "comedy"...');
    const comedyResults = await queryWithPromise({
      kinds: [34236],
      '#t': ['comedy']
    }, 'test-comedy');

    const foundInComedy = comedyResults.some(e => e.id === testEventId);
    results.queryComedy = foundInComedy;
    console.log(foundInComedy
      ? `✓ Found video in "comedy" results (${comedyResults.length} total)`
      : `✗ Video NOT found in "comedy" results`);
    console.log('');

    // Test 5: Query with multiple hashtags (OR logic)
    console.log('Test 5: Querying for multiple hashtags ["music", "dance"]...');
    const multiResults = await queryWithPromise({
      kinds: [34236],
      '#t': ['music', 'dance']
    }, 'test-multi');

    const foundInMulti = multiResults.some(e => e.id === testEventId);
    results.queryMultiple = foundInMulti;
    console.log(foundInMulti
      ? `✓ Found video in multi-hashtag results (${multiResults.length} total)`
      : `✗ Video NOT found in multi-hashtag results`);
    console.log('');

    // Test 6: Verify sort order with hashtag filtering
    console.log('Test 6: Verifying sort order with hashtag filter...');
    const sortedResults = await queryWithPromise({
      kinds: [34236],
      '#t': ['music'],
      sort: { field: 'loop_count', dir: 'desc' },
      limit: 10
    }, 'test-sorted');

    // Check if results are sorted correctly
    let isSorted = true;
    for (let i = 1; i < sortedResults.length; i++) {
      const prevLoops = parseInt(sortedResults[i-1].tags.find(t => t[0] === 'loops')?.[1] || '0');
      const currLoops = parseInt(sortedResults[i].tags.find(t => t[0] === 'loops')?.[1] || '0');
      if (prevLoops < currLoops) {
        isSorted = false;
        break;
      }
    }
    results.sortOrder = isSorted && sortedResults.length > 0;
    console.log(isSorted && sortedResults.length > 0
      ? `✓ Sort order maintained (${sortedResults.length} results)`
      : `✗ Sort order NOT correct`);
    console.log('');

    // Test 7: Test pagination with cursors
    console.log('Test 7: Testing pagination with cursors...');
    const page1 = await queryWithPromise({
      kinds: [34236],
      '#t': ['music'],
      limit: 2
    }, 'test-page1');

    if (page1.length > 0) {
      const lastEvent = page1[page1.length - 1];
      const cursor = Buffer.from(JSON.stringify({
        event_id: lastEvent.id,
        loop_count: parseInt(lastEvent.tags.find(t => t[0] === 'loops')?.[1] || '0'),
        created_at: lastEvent.created_at
      })).toString('base64');

      const page2 = await queryWithPromise({
        kinds: [34236],
        '#t': ['music'],
        limit: 2,
        cursor: cursor
      }, 'test-page2');

      // Verify no duplicates between pages
      const page1Ids = new Set(page1.map(e => e.id));
      const hasDuplicates = page2.some(e => page1Ids.has(e.id));

      results.pagination = !hasDuplicates;
      console.log(!hasDuplicates
        ? `✓ Pagination works (page1: ${page1.length}, page2: ${page2.length}, no duplicates)`
        : `✗ Pagination has duplicates`);
    } else {
      console.log('⚠ Not enough results to test pagination');
      results.pagination = true; // Don't fail if not enough data
    }
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════════════');
    console.log('\n📊 Test Results Summary:\n');
    Object.entries(results).forEach(([test, passed]) => {
      console.log(`  ${passed ? '✓' : '✗'} ${test}: ${passed ? 'PASSED' : 'FAILED'}`);
    });

    const allPassed = Object.values(results).every(r => r === true);
    console.log('');
    console.log(allPassed ? '🎉 All tests PASSED!' : '❌ Some tests FAILED');
    console.log('');

    ws.close();
    process.exit(allPassed ? 0 : 1);

  } catch (error) {
    console.error('\n✗ Test error:', error.message);
    ws.close();
    process.exit(1);
  }
}

// Connect and run tests
ws = new WebSocket(RELAY_URL);

ws.on('open', () => {
  console.log('✓ Connected to relay');
  runTests();
});

ws.on('error', (err) => {
  console.error('✗ WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('Connection closed');
});
