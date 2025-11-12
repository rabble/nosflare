const WebSocket = require('ws');
const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('Testing basic query for kind 34236...');
  ws.send(JSON.stringify(['REQ', 'basic', { kinds: [34236] }]));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Received:', msg[0]);
  if (msg[0] === 'EVENT') {
    console.log('  Event ID:', msg[2].id.substring(0, 16) + '...');
  } else if (msg[0] === 'EOSE') {
    console.log('✓ EOSE received');
    ws.close();
  }
});

setTimeout(() => {
  console.log('⚠️  Timeout - closing');
  ws.close();
}, 3000);
