const { parseSearchQuery, buildFTSQuery } = require('./dist/search-parser.cjs');

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

// Test 6: Empty query string edge case
const result6 = parseSearchQuery('');
assertEquals(result6.terms, [], 'Empty query returns empty terms');
assertEquals(result6.filters, {}, 'Empty query returns empty filters');

// Test 7: Empty hashtag edge case
const result7 = parseSearchQuery('# test');
assertEquals(result7.terms, ['test'], 'Empty hashtag ignored');

console.log('\n✓ All parseSearchQuery tests passed!');

// buildFTSQuery tests
console.log('\nTesting buildFTSQuery...');

// Test 1: Empty array returns empty string
const fts1 = buildFTSQuery([]);
assertEquals(fts1, '', 'Empty array returns empty string');

// Test 2: Single term returns "term*"
const fts2 = buildFTSQuery(['bitcoin']);
assertEquals(fts2, 'bitcoin*', 'Single term with prefix match');

// Test 3: Multiple terms returns "term1* OR term2* OR term3*"
const fts3 = buildFTSQuery(['bitcoin', 'nostr', 'lightning']);
assertEquals(fts3, 'bitcoin* OR nostr* OR lightning*', 'Multiple terms with OR operator');

// Test 4: Two terms
const fts4 = buildFTSQuery(['dance', 'music']);
assertEquals(fts4, 'dance* OR music*', 'Two terms with OR operator');

console.log('\n✓ All buildFTSQuery tests passed!');
