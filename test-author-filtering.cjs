// Test author filtering for video queries
// Tests single author, multiple authors, and combinations with other filters

const WebSocket = require('ws');

// Configuration
const RELAY_URL = 'wss://nosflare.protestnet.workers.dev';
const TIMEOUT_MS = 10000;

// Test pubkeys (using known authors from the database)
const TEST_AUTHORS = [
  'f0b84b78f284386a70534a23302a251498e56057eef596aecd7a14c829d512ef', // Real author 1
  '3ca3a1a0ab3587223a391f670cce3e1033a24de37019cd187ae1523a510b2523'  // Real author 2
];

// Track all test results
const tests = [];
let currentTest = 0;

// Test cases
const testCases = [
  {
    name: 'Test 1: Single author with default sort',
    filter: {
      kinds: [34236],
      authors: [TEST_AUTHORS[0]],
      limit: 5
    },
    validate: (events) => {
      if (events.length === 0) {
        return { pass: true, message: 'No events from this author (acceptable)' };
      }
      const allMatch = events.every(e => e.pubkey === TEST_AUTHORS[0]);
      return {
        pass: allMatch,
        message: allMatch
          ? `All ${events.length} events from correct author`
          : 'Found events from wrong author'
      };
    }
  },
  {
    name: 'Test 2: Single author sorted by loop_count DESC',
    filter: {
      kinds: [34236],
      authors: [TEST_AUTHORS[0]],
      sort: { field: 'loop_count', dir: 'desc' },
      limit: 5
    },
    validate: (events) => {
      if (events.length === 0) {
        return { pass: true, message: 'No events from this author (acceptable)' };
      }
      const allMatch = events.every(e => e.pubkey === TEST_AUTHORS[0]);
      if (!allMatch) {
        return { pass: false, message: 'Found events from wrong author' };
      }

      // Check sort order
      const loops = events.map(e => {
        const loopsTag = e.tags.find(t => t[0] === 'loops');
        return loopsTag ? parseInt(loopsTag[1]) : 0;
      });

      const isSorted = loops.every((val, i, arr) => i === 0 || arr[i - 1] >= val);
      return {
        pass: isSorted,
        message: isSorted
          ? `Correctly sorted: ${loops.join(' >= ')}`
          : `Incorrect sort order: ${loops.join(', ')}`
      };
    }
  },
  {
    name: 'Test 3: Single author sorted by likes DESC',
    filter: {
      kinds: [34236],
      authors: [TEST_AUTHORS[0]],
      sort: { field: 'likes', dir: 'desc' },
      limit: 5
    },
    validate: (events) => {
      if (events.length === 0) {
        return { pass: true, message: 'No events from this author (acceptable)' };
      }
      const allMatch = events.every(e => e.pubkey === TEST_AUTHORS[0]);
      if (!allMatch) {
        return { pass: false, message: 'Found events from wrong author' };
      }

      const likes = events.map(e => {
        const likesTag = e.tags.find(t => t[0] === 'likes');
        return likesTag ? parseInt(likesTag[1]) : 0;
      });

      const isSorted = likes.every((val, i, arr) => i === 0 || arr[i - 1] >= val);
      return {
        pass: isSorted,
        message: isSorted
          ? `Correctly sorted: ${likes.join(' >= ')}`
          : `Incorrect sort order: ${likes.join(', ')}`
      };
    }
  },
  {
    name: 'Test 4: Multiple authors (OR logic)',
    filter: {
      kinds: [34236],
      authors: TEST_AUTHORS,
      limit: 10
    },
    validate: (events) => {
      if (events.length === 0) {
        return { pass: true, message: 'No events from these authors (acceptable)' };
      }
      const allMatch = events.every(e => TEST_AUTHORS.includes(e.pubkey));
      const uniqueAuthors = [...new Set(events.map(e => e.pubkey))];
      return {
        pass: allMatch,
        message: allMatch
          ? `Found ${events.length} events from ${uniqueAuthors.length} author(s): ${uniqueAuthors.join(', ').substring(0, 80)}...`
          : 'Found events from unexpected authors'
      };
    }
  },
  {
    name: 'Test 5: Author + hashtag filter combined',
    filter: {
      kinds: [34236],
      authors: [TEST_AUTHORS[0]],
      '#t': ['comedy'],
      limit: 5
    },
    validate: (events) => {
      if (events.length === 0) {
        return { pass: true, message: 'No matching events (acceptable)' };
      }
      const correctAuthor = events.every(e => e.pubkey === TEST_AUTHORS[0]);
      const hasHashtag = events.every(e =>
        e.tags.some(t => t[0] === 't' && t[1] === 'comedy')
      );
      return {
        pass: correctAuthor && hasHashtag,
        message: correctAuthor && hasHashtag
          ? `Found ${events.length} events matching both filters`
          : 'Some events failed filter criteria'
      };
    }
  },
  {
    name: 'Test 6: FLUTTER_INTEGRATION.md example #11 (author top videos)',
    filter: {
      kinds: [34236],
      authors: [TEST_AUTHORS[0]],
      sort: { field: 'loop_count', dir: 'desc' },
      limit: 10
    },
    validate: (events) => {
      if (events.length === 0) {
        return { pass: true, message: 'No events from this author (acceptable)' };
      }
      const allMatch = events.every(e => e.pubkey === TEST_AUTHORS[0]);
      if (!allMatch) {
        return { pass: false, message: 'Wrong author' };
      }

      const loops = events.map(e => {
        const loopsTag = e.tags.find(t => t[0] === 'loops');
        return loopsTag ? parseInt(loopsTag[1]) : 0;
      });

      const isSorted = loops.every((val, i, arr) => i === 0 || arr[i - 1] >= val);
      return {
        pass: allMatch && isSorted,
        message: allMatch && isSorted
          ? `Flutter example works: ${events.length} events, sorted by loops`
          : 'Flutter example validation failed'
      };
    }
  }
];

// Run a single test
function runTest(testCase) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY_URL);
    const events = [];
    let subscriptionId = `test-${currentTest}`;

    const timeout = setTimeout(() => {
      ws.close();
      resolve({
        name: testCase.name,
        pass: false,
        message: 'Timeout - no response from relay'
      });
    }, TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subscriptionId, testCase.filter]));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);

      if (msg[0] === 'EVENT' && msg[1] === subscriptionId) {
        events.push(msg[2]);
      } else if (msg[0] === 'EOSE' && msg[1] === subscriptionId) {
        clearTimeout(timeout);
        ws.close();

        const result = testCase.validate(events);
        resolve({
          name: testCase.name,
          pass: result.pass,
          message: result.message,
          eventCount: events.length
        });
      } else if (msg[0] === 'CLOSED' && msg[1] === subscriptionId) {
        clearTimeout(timeout);
        ws.close();
        resolve({
          name: testCase.name,
          pass: false,
          message: `Subscription closed: ${msg[2]}`
        });
      } else if (msg[0] === 'NOTICE') {
        clearTimeout(timeout);
        ws.close();
        resolve({
          name: testCase.name,
          pass: false,
          message: `Notice from relay: ${msg[1]}`
        });
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        name: testCase.name,
        pass: false,
        message: `WebSocket error: ${err.message}`
      });
    });
  });
}

// Run all tests sequentially
async function runAllTests() {
  console.log('🧪 Author Filtering Tests\n');
  console.log(`Testing against: ${RELAY_URL}`);
  console.log(`Test authors: ${TEST_AUTHORS.join(', ')}\n`);

  for (let i = 0; i < testCases.length; i++) {
    currentTest = i;
    console.log(`Running test ${i + 1}/${testCases.length}: ${testCases[i].name}`);

    const result = await runTest(testCases[i]);
    tests.push(result);

    const status = result.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${status}: ${result.message}`);
    if (result.eventCount !== undefined) {
      console.log(`  Events received: ${result.eventCount}`);
    }
    console.log();
  }

  // Print summary
  console.log('━'.repeat(60));
  const passed = tests.filter(t => t.pass).length;
  const failed = tests.filter(t => !t.pass).length;

  console.log(`\n📊 Test Summary: ${passed}/${tests.length} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('Failed tests:');
    tests.filter(t => !t.pass).forEach(t => {
      console.log(`  ✗ ${t.name}: ${t.message}`);
    });
    process.exit(1);
  } else {
    console.log('✓ All tests passed!');
    process.exit(0);
  }
}

// Execute tests
runAllTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
