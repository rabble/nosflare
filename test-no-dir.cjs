// Test what happens when dir is not specified
const WebSocket = require('ws');
const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('✓ Testing sort WITHOUT dir parameter...\n');
  ws.send(JSON.stringify(['REQ', 'test-no-dir', {
    kinds: [34236],
    sort: { field: 'loop_count' },  // NO dir specified!
    limit: 5
  }]));
});

const videos = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 'EVENT') {
    const event = msg[2];
    const loops = event.tags.find(t => t[0] === 'loops')?.[1] || '0';
    videos.push(parseInt(loops));
  } else if (msg[0] === 'EOSE') {
    console.log('Loops received (in order):');
    videos.forEach((loops, i) => console.log(`  ${i+1}. ${loops.toLocaleString()}`));

    const isDesc = videos.every((val, i, arr) => i === 0 || arr[i-1] >= val);
    const isAsc = videos.every((val, i, arr) => i === 0 || arr[i-1] <= val);

    if (isDesc) console.log('\n✓ Default is DESC (highest first)');
    else if (isAsc) console.log('\n✗ Default is ASC (lowest first)');
    else console.log('\n✗ Not sorted at all!');

    ws.close();
  }
});

setTimeout(() => ws.close(), 5000);
