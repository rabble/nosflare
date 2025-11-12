const WebSocket = require('ws');
const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('Testing query with sort parameter...');
  ws.send(JSON.stringify(['REQ', 'sorted', {
    kinds: [34236],
    sort: { field: 'loop_count', dir: 'desc' }
  }]));
});

let eventCount = 0;
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 'EVENT') {
    eventCount++;
    const loops = msg[2].tags.find(t => t[0] === 'loops')?.[1];
    console.log(`  Event ${eventCount}: loops=${loops}`);
  } else if (msg[0] === 'EOSE') {
    console.log(`✓ EOSE received - ${eventCount} events`);
    ws.close();
  } else if (msg[0] === 'NOTICE') {
    console.log(`⚠️  NOTICE: ${msg[1]}`);
    ws.close();
  }
});

setTimeout(() => {
  console.log('⚠️  Timeout');
  ws.close();
}, 3000);
