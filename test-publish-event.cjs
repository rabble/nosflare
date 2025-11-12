const WebSocket = require('ws');
const crypto = require('crypto');

// Simple test event (kind 1 for testing)
const testEvent = {
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: 'Test event from debugging',
  pubkey: '0000000000000000000000000000000000000000000000000000000000000001',
  id: '',
  sig: ''
};

// Generate fake ID (SHA256 of serialized event)
const serialized = JSON.stringify([
  0,
  testEvent.pubkey,
  testEvent.created_at,
  testEvent.kind,
  testEvent.tags,
  testEvent.content
]);
testEvent.id = crypto.createHash('sha256').update(serialized).digest('hex');

// Generate fake signature (64 bytes hex)
testEvent.sig = '0'.repeat(128);

const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('Connected - publishing test event...');
  ws.send(JSON.stringify(['EVENT', testEvent]));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Response:', JSON.stringify(msg));
  
  if (msg[0] === 'OK') {
    if (msg[2]) {
      console.log('✓ Event accepted!');
    } else {
      console.log('✗ Event rejected:', msg[3]);
    }
    ws.close();
  }
});

setTimeout(() => {
  console.log('⚠️  Timeout');
  ws.close();
}, 3000);
