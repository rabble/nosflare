const WebSocket = require('ws');

const ws = new WebSocket('wss://relay.divine.video');

ws.on('open', () => {
  console.log('✓ Connected - querying top videos by likes...\n');

  ws.send(JSON.stringify([
    'REQ',
    'test-likes',
    {
      kinds: [34236],
      sort: { field: 'likes', dir: 'desc' },
      limit: 10
    }
  ]));
});

const videos = [];

ws.on('message', (data) => {
  const [type, subId, event] = JSON.parse(data);

  if (type === 'EVENT' && subId === 'test-likes') {
    const loops = event.tags.find(t => t[0] === 'loops');
    const likes = event.tags.find(t => t[0] === 'likes');
    const vineId = event.tags.find(t => t[0] === 'd');

    videos.push({
      vineId: vineId ? vineId[1] : '?',
      loops: loops ? parseInt(loops[1]) : 0,
      likes: likes ? parseInt(likes[1]) : 0
    });
  } else if (type === 'EOSE' && subId === 'test-likes') {
    console.log('📊 Top 10 Videos by Likes:\n');
    console.log('Rank | Vine ID     | Likes  | Loops');
    console.log('-----|-------------|--------|----------');

    videos.forEach((v, i) => {
      console.log(`${(i+1).toString().padStart(4)} | ${v.vineId} | ${v.likes.toString().padStart(6)} | ${v.loops.toString().padStart(8)}`);
    });

    // Verify sorting
    let isSorted = true;
    for (let i = 1; i < videos.length; i++) {
      if (videos[i].likes > videos[i-1].likes) {
        console.log(`\n✗ SORT ERROR: Video ${i+1} has ${videos[i].likes} likes > video ${i} has ${videos[i-1].likes} likes`);
        isSorted = false;
      }
    }

    if (isSorted) {
      console.log(`\n✓ Sort by likes is CORRECT (descending)`);
    }

    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  ws.close();
  process.exit(0);
}, 5000);
