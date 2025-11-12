const WebSocket = require('ws');
const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('✓ Connected - querying top videos by loop_count...\n');
  ws.send(JSON.stringify(['REQ', 'top-loops', {
    kinds: [34236],
    sort: { field: 'loop_count', dir: 'desc' },
    limit: 10
  }]));
});

let eventCount = 0;
const videos = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] === 'EVENT') {
    eventCount++;
    const event = msg[2];
    const loops = event.tags.find(t => t[0] === 'loops')?.[1] || '0';
    const likes = event.tags.find(t => t[0] === 'likes')?.[1] || '0';
    const views = event.tags.find(t => t[0] === 'views')?.[1] || '0';
    const vineId = event.tags.find(t => t[0] === 'd')?.[1] || 'unknown';
    
    videos.push({ vineId, loops: parseInt(loops), likes: parseInt(likes), views: parseInt(views) });
  } else if (msg[0] === 'EOSE') {
    console.log(`📊 Top ${eventCount} Videos by Loop Count:\n`);
    console.log('Rank | Vine ID     | Loops  | Likes | Views');
    console.log('-----|-------------|--------|-------|-------');
    
    videos.sort((a, b) => b.loops - a.loops).forEach((v, i) => {
      const rank = String(i + 1).padStart(4);
      const vineId = v.vineId.padEnd(11);
      const loops = String(v.loops).padStart(6);
      const likes = String(v.likes).padStart(5);
      const views = String(v.views).padStart(5);
      console.log(`${rank} | ${vineId} | ${loops} | ${likes} | ${views}`);
    });
    
    console.log(`\n✓ Query complete - ${eventCount} events returned`);
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('✗ Error:', err.message);
});

setTimeout(() => {
  console.log('⏱ Timeout - closing connection');
  ws.close();
}, 5000);
