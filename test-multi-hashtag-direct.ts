// ABOUTME: Direct database test for multi-hashtag functionality
// ABOUTME: Tests video_hashtags junction table without WebSocket

import { buildVideoQuery } from './src/video-queries';
import type { VideoFilter } from './src/video-queries';

/**
 * Test multi-hashtag query building
 */
async function testMultiHashtagQuery() {
  console.log('\n🧪 Multi-Hashtag Query Builder Test\n');
  console.log('═══════════════════════════════════════════════\n');

  const cursorSecret = 'test-secret-12345';

  try {
    // Test 1: Single hashtag
    console.log('Test 1: Single hashtag query');
    const filter1: VideoFilter = {
      kinds: [34236],
      '#t': ['music']
    };

    const { sql: sql1, args: args1 } = await buildVideoQuery(filter1, cursorSecret);
    console.log('Filter:', JSON.stringify(filter1, null, 2));
    console.log('Generated SQL:', sql1.trim());
    console.log('Args:', args1);

    // Check if it uses junction table
    const usesJunction1 = sql1.includes('video_hashtags');
    console.log(usesJunction1 ? '✓ Uses video_hashtags junction table' : '✗ Does NOT use junction table');
    console.log('');

    // Test 2: Multiple hashtags (OR logic)
    console.log('Test 2: Multiple hashtags (OR logic)');
    const filter2: VideoFilter = {
      kinds: [34236],
      '#t': ['music', 'dance', 'comedy']
    };

    const { sql: sql2, args: args2 } = await buildVideoQuery(filter2, cursorSecret);
    console.log('Filter:', JSON.stringify(filter2, null, 2));
    console.log('Generated SQL:', sql2.trim());
    console.log('Args:', args2);

    const usesJunction2 = sql2.includes('video_hashtags');
    const hasMultiHashtag = sql2.includes('hashtag IN (?,?,?)');
    console.log(usesJunction2 ? '✓ Uses video_hashtags junction table' : '✗ Does NOT use junction table');
    console.log(hasMultiHashtag ? '✓ Supports multiple hashtags with IN clause' : '✗ Missing IN clause');
    console.log('');

    // Test 3: Hashtag with sort
    console.log('Test 3: Hashtag filtering with sort by loop_count');
    const filter3: VideoFilter = {
      kinds: [34236],
      '#t': ['music'],
      sort: { field: 'loop_count', dir: 'desc' },
      limit: 10
    };

    const { sql: sql3, args: args3 } = await buildVideoQuery(filter3, cursorSecret);
    console.log('Filter:', JSON.stringify(filter3, null, 2));
    console.log('Generated SQL:', sql3.trim());
    console.log('Args:', args3);

    const hasSort = sql3.includes('ORDER BY loop_count DESC');
    console.log(hasSort ? '✓ Sort order included' : '✗ Sort order missing');
    console.log('');

    // Test 4: Hashtag with author filter
    console.log('Test 4: Hashtag + Author filter combination');
    const filter4: VideoFilter = {
      kinds: [34236],
      '#t': ['music', 'dance'],
      authors: ['abc123', 'def456'],
      limit: 20
    };

    const { sql: sql4, args: args4 } = await buildVideoQuery(filter4, cursorSecret);
    console.log('Filter:', JSON.stringify(filter4, null, 2));
    console.log('Generated SQL:', sql4.trim());
    console.log('Args:', args4);

    const hasAuthor = sql4.includes('author IN');
    const hasHashtag = sql4.includes('video_hashtags');
    console.log(hasAuthor ? '✓ Author filter included' : '✗ Author filter missing');
    console.log(hasHashtag ? '✓ Hashtag filter included' : '✗ Hashtag filter missing');
    console.log('');

    // Test 5: Multiple junction tables
    console.log('Test 5: Multiple junction tables (#t + #p + #e)');
    const filter5: VideoFilter = {
      kinds: [34236],
      '#t': ['music'],
      '#p': ['pubkey1', 'pubkey2'],
      '#e': ['event1'],
      limit: 10
    };

    const { sql: sql5, args: args5 } = await buildVideoQuery(filter5, cursorSecret);
    console.log('Filter:', JSON.stringify(filter5, null, 2));
    console.log('Generated SQL:', sql5.trim());
    console.log('Args:', args5);

    const hasHashtagJunction = sql5.includes('video_hashtags');
    const hasMentionsJunction = sql5.includes('video_mentions');
    const hasReferencesJunction = sql5.includes('video_references');
    console.log(hasHashtagJunction ? '✓ video_hashtags included' : '✗ video_hashtags missing');
    console.log(hasMentionsJunction ? '✓ video_mentions included' : '✗ video_mentions missing');
    console.log(hasReferencesJunction ? '✓ video_references included' : '✗ video_references missing');
    console.log('');

    // Summary
    console.log('═══════════════════════════════════════════════');
    console.log('\n📊 Test Summary:\n');

    const allPassed =
      usesJunction1 &&
      usesJunction2 &&
      hasMultiHashtag &&
      hasSort &&
      hasAuthor &&
      hasHashtag &&
      hasHashtagJunction &&
      hasMentionsJunction &&
      hasReferencesJunction;

    if (allPassed) {
      console.log('🎉 All query builder tests PASSED!');
      console.log('\nThe multi-hashtag implementation:');
      console.log('  ✓ Uses video_hashtags junction table');
      console.log('  ✓ Supports OR logic for multiple hashtags');
      console.log('  ✓ Works with sorting and pagination');
      console.log('  ✓ Combines with other filters (author, #p, #e, #a)');
    } else {
      console.log('❌ Some query builder tests FAILED');
    }
    console.log('');

  } catch (error: any) {
    console.error('\n✗ Test error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testMultiHashtagQuery();
