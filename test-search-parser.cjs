const { parseSearchQuery } = require('./dist/search-parser.cjs');

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`❌ ${message}`);
    console.error('Expected:', expected);
    console.error('Actual:', actual);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

console.log('Testing search query parser...');

// Test 1: Simple keyword query
const result1 = parseSearchQuery('bitcoin nostr');
assertEquals(result1.terms, ['bitcoin', 'nostr'], 'Simple keyword parsing');
assertEquals(result1.filters, {}, 'No filters for simple query');

// Test 2: Type filter
const result2 = parseSearchQuery('type:user rabble');
assertEquals(result2.type, 'user', 'Type filter parsed');
assertEquals(result2.terms, ['rabble'], 'Remaining terms after type');

// Test 3: Hashtag extraction
const result3 = parseSearchQuery('#dance #music video');
assertEquals(result3.filters.hashtags, ['dance', 'music'], 'Hashtags extracted');
assertEquals(result3.terms, ['video'], 'Terms without hashtags');

// Test 4: Author filter
const result4 = parseSearchQuery('author:abc123 content');
assertEquals(result4.filters.author, 'abc123', 'Author filter parsed');
assertEquals(result4.terms, ['content'], 'Terms after author');

// Test 5: Complex query
const result5 = parseSearchQuery('type:video #cooking author:rabble min_likes:100 italian food');
assertEquals(result5.type, 'video', 'Complex: type');
assertEquals(result5.filters.hashtags, ['cooking'], 'Complex: hashtags');
assertEquals(result5.filters.author, 'rabble', 'Complex: author');
assertEquals(result5.filters.min_likes, 100, 'Complex: min_likes');
assertEquals(result5.terms, ['italian', 'food'], 'Complex: remaining terms');

console.log('\n✓ All parser tests passed!');
