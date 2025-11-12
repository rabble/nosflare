// Test relay sorting WITHOUT client-side re-sorting
const WebSocket = require('ws');
const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('✓ Testing relay sort order (NO client-side sorting)...\n');
  ws.send(JSON.stringify(['REQ', 'test-order', {
    kinds: [34236],
    sort: { field: 'loop_count', dir: 'desc' },
    limit: 10
  }]));
});

const videos = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 'EVENT') {
    const event = msg[2];
    const loops = event.tags.find(t => t[0] === 'loops')?.[1] || '0';
    const vineId = event.tags.find(t => t[0] === 'd')?.[1] || 'unknown';

    // Store in ORDER RECEIVED from relay (no sorting!)
    videos.push({ vineId, loops: parseInt(loops), order: videos.length + 1 });
  } else if (msg[0] === 'EOSE') {
    console.log('📊 Videos in ORDER RECEIVED from relay:\n');
    console.log('Order | Vine ID     | Loops');
    console.log('------|-------------|----------');

    videos.forEach(v => {
      console.log(`${String(v.order).padStart(5)} | ${v.vineId.padEnd(11)} | ${v.loops}`);
    });

    // Check if relay sent them pre-sorted
    let isSorted = true;
    for (let i = 1; i < videos.length; i++) {
      if (videos[i].loops > videos[i-1].loops) {
        isSorted = false;
        console.log(`\n✗ Position ${i+1} has MORE loops than position ${i} - relay NOT sorting!`);
        break;
      }
    }

    if (isSorted) {
      console.log('\n✓ Relay IS sorting correctly (descending order)');
    }

    ws.close();
    process.exit(isSorted ? 0 : 1);
  }
});

setTimeout(() => {
  ws.close();
  process.exit(1);
}, 5000);
