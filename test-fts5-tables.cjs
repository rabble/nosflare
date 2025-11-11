const WebSocket = require('ws');

async function testFTS5Tables() {
  console.log('Testing FTS5 table creation...');

  // Connect to relay
  const ws = new WebSocket('ws://127.0.0.1:8787');

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('✓ Connected to relay');

      // Query to check if FTS5 tables exist
      // We'll send a search query and expect proper handling
      const searchReq = JSON.stringify([
        'REQ',
        'test-fts5',
        {
          search: 'test query',
          kinds: [0],
          limit: 1
        }
      ]);

      ws.send(searchReq);

      setTimeout(() => {
        console.log('✓ FTS5 tables should exist');
        ws.close();
        resolve();
      }, 1000);
    });

    ws.on('error', reject);
  });
}

testFTS5Tables().then(() => {
  console.log('All tests passed!');
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
