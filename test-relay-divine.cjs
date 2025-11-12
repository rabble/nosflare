const WebSocket = require('ws');
const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('✓ Connected to relay.divine.video');
  ws.send(JSON.stringify(['REQ', 'test', { kinds: [34236], limit: 5 }]));
});

let eventCount = 0;
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 'EVENT') {
    eventCount++;
    const eventId = msg[2].id.substring(0, 16);
    console.log(`  Event ${eventCount}: ${eventId}...`);
  } else if (msg[0] === 'EOSE') {
    console.log(`✓ Total events: ${eventCount}`);
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('✗ Connection error:', err.message);
});

setTimeout(() => { ws.close(); }, 3000);
