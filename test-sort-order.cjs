#!/usr/bin/env node
// ABOUTME: Integration test to verify sort order correctness
// ABOUTME: Tests that events are returned in correct descending/ascending order

const WebSocket = require('ws');
const RELAY_URL = 'wss://nosflare.protestnet.workers.dev';

function verifySortOrder(events, field, direction) {
  if (events.length === 0) {
    console.log(`  ⚠️  No events to verify (database empty?)`);
    return { valid: true, reason: 'no-data' };
  }

  if (events.length === 1) {
    console.log(`  ✓ Only 1 event, sort order trivially correct`);
    return { valid: true, reason: 'single-event' };
  }

  const getMetric = (event) => {
    const tag = event.tags.find(t => t[0] === field.replace('loop_count', 'loops'));
    return tag ? parseInt(tag[1], 10) || 0 : 0;
  };

  const values = events.map(e => getMetric(e));
  console.log(`  Values: [${values.join(', ')}]`);

  for (let i = 0; i < values.length - 1; i++) {
    const current = values[i];
    const next = values[i + 1];

    if (direction === 'desc') {
      if (current < next) {
        return {
          valid: false,
          reason: `Sort order violation: ${current} < ${next} at position ${i}`,
          values
        };
      }
    } else {
      if (current > next) {
        return {
          valid: false,
          reason: `Sort order violation: ${current} > ${next} at position ${i}`,
          values
        };
      }
    }
  }

  return { valid: true, reason: 'correct-order', values };
}

function testSort(name, filter, sortField, sortDir) {
  return new Promise((resolve) => {
    console.log(`\n${name}`);
    console.log(`  Filter: ${JSON.stringify(filter)}`);

    const ws = new WebSocket(RELAY_URL);
    const events = [];

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', 'test', filter]));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      const [type, ...args] = msg;

      if (type === 'EVENT') {
        events.push(args[1]);
      } else if (type === 'EOSE') {
        const result = verifySortOrder(events, sortField, sortDir);
        console.log(result.valid
          ? `  ✓ Sort order CORRECT (${result.reason})`
          : `  ✗ Sort order FAILED: ${result.reason}`
        );
        ws.close();
        resolve({ success: result.valid, events: events.length, ...result });
      } else if (type === 'CLOSED') {
        console.log(`  ✗ CLOSED: ${args[1]}`);
        ws.close();
        resolve({ success: false, error: args[1] });
      }
    });

    ws.on('error', (err) => {
      console.log(`  ✗ WebSocket error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });

    setTimeout(() => {
      ws.close();
      resolve({ success: false, error: 'timeout' });
    }, 5000);
  });
}

async function runSortTests() {
  console.log('=== Sort Order Integration Tests ===');

  const tests = [
    {
      name: 'Test 1: loop_count DESC (default)',
      filter: { kinds: [34236], sort: { field: 'loop_count', dir: 'desc' }, limit: 10 },
      sortField: 'loop_count',
      sortDir: 'desc'
    },
    {
      name: 'Test 2: loop_count ASC',
      filter: { kinds: [34236], sort: { field: 'loop_count', dir: 'asc' }, limit: 10 },
      sortField: 'loop_count',
      sortDir: 'asc'
    },
    {
      name: 'Test 3: likes DESC',
      filter: { kinds: [34236], sort: { field: 'likes', dir: 'desc' }, limit: 10 },
      sortField: 'likes',
      sortDir: 'desc'
    },
    {
      name: 'Test 4: views DESC',
      filter: { kinds: [34236], sort: { field: 'views', dir: 'desc' }, limit: 10 },
      sortField: 'views',
      sortDir: 'desc'
    },
    {
      name: 'Test 5: loop_count DESC with int# filter',
      filter: {
        kinds: [34236],
        'int#loop_count': { gte: 100 },
        sort: { field: 'loop_count', dir: 'desc' },
        limit: 10
      },
      sortField: 'loop_count',
      sortDir: 'desc'
    }
  ];

  const results = [];
  for (const test of tests) {
    const result = await testSort(test.name, test.filter, test.sortField, test.sortDir);
    results.push(result);
  }

  console.log('\n=== Summary ===');
  const passed = results.filter(r => r.success).length;
  const total = results.length;
  console.log(`${passed}/${total} tests passed`);

  if (passed === total) {
    console.log('✓ All sort order tests PASSED');
  } else {
    console.log('✗ Some sort order tests FAILED');
    process.exit(1);
  }
}

runSortTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
