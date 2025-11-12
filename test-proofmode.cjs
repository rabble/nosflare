// Comprehensive ProofMode verification test
// Tests all verification levels and filter combinations

const WebSocket = require('ws');
const crypto = require('crypto');

const RELAY_URL = 'wss://relay.divine.video';

// Generate a test keypair
function generateKeypair() {
  const privkey = crypto.randomBytes(32).toString('hex');
  return { privkey };
}

// Create unsigned event skeleton
function createEvent(kind, content, tags) {
  return {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
    pubkey: '0'.repeat(64), // Dummy pubkey
  };
}

// Calculate event ID
function getEventHash(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// Sign event (dummy signature for testing)
function signEvent(event) {
  event.id = getEventHash(event);
  event.sig = '0'.repeat(128); // Dummy signature
  return event;
}

// Test cases for all ProofMode verification levels
const testCases = [
  {
    name: 'verified_mobile',
    description: 'Full ProofMode with hardware attestation',
    tags: [
      ['url', 'https://example.com/video1.mp4'],
      ['m', 'video/mp4'],
      ['loops', '1000'],
      ['likes', '50'],
      ['verification', 'verified_mobile'],
      ['proofmode', JSON.stringify({
        version: '1.0',
        timestamp: Date.now(),
        location: { lat: 37.7749, lon: -122.4194 },
        device: 'iPhone 14 Pro'
      })],
      ['device_attestation', 'AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNNOOOPPPQQQRRRSSSTTTUUUVVVWWWXXXYYYZZZ'],
      ['pgp_fingerprint', '1A2B3C4D5E6F7G8H9I0J']
    ]
  },
  {
    name: 'verified_web',
    description: 'ProofMode with PGP signature but no hardware attestation',
    tags: [
      ['url', 'https://example.com/video2.mp4'],
      ['m', 'video/mp4'],
      ['loops', '500'],
      ['likes', '25'],
      ['verification', 'verified_web'],
      ['proofmode', JSON.stringify({
        version: '1.0',
        timestamp: Date.now(),
        source: 'web_upload'
      })],
      ['pgp_fingerprint', 'AABBCCDDEEFF00112233']
    ]
  },
  {
    name: 'basic_proof',
    description: 'ProofMode manifest without any signatures',
    tags: [
      ['url', 'https://example.com/video3.mp4'],
      ['m', 'video/mp4'],
      ['loops', '250'],
      ['likes', '10'],
      ['verification', 'basic_proof'],
      ['proofmode', JSON.stringify({
        version: '1.0',
        timestamp: Date.now()
      })]
    ]
  },
  {
    name: 'unverified',
    description: 'No ProofMode tags at all',
    tags: [
      ['url', 'https://example.com/video4.mp4'],
      ['m', 'video/mp4'],
      ['loops', '100'],
      ['likes', '5']
    ]
  },
  {
    name: 'old_vine_import',
    description: 'Old Vine import (has d tag with vine_id)',
    tags: [
      ['d', 'eB3w9lIa2zQ'], // Vine ID
      ['url', 'https://example.com/vine_old.mp4'],
      ['m', 'video/mp4'],
      ['loops', '5000000'],
      ['likes', '150000']
    ]
  }
];

// Publish test events
async function publishTestEvents(ws) {
  console.log('📤 Publishing test events...\n');

  for (const testCase of testCases) {
    const event = createEvent(34236, `Test video: ${testCase.description}`, testCase.tags);
    signEvent(event);

    ws.send(JSON.stringify(['EVENT', event]));
    console.log(`  ✓ Published: ${testCase.name}`);

    // Wait a bit between publishes
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log('\n⏳ Waiting for events to be indexed...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// Test filtering by verification level
async function testVerificationFilter(ws, level, expectedNames) {
  return new Promise((resolve) => {
    const subId = `test-verification-${level}`;
    const results = [];

    ws.send(JSON.stringify([
      'REQ',
      subId,
      {
        kinds: [34236],
        verification: [level],
        limit: 10
      }
    ]));

    const messageHandler = (data) => {
      const msg = JSON.parse(data);
      if (msg[0] === 'EVENT' && msg[1] === subId) {
        const event = msg[2];
        const verificationTag = event.tags.find(t => t[0] === 'verification');
        const vineIdTag = event.tags.find(t => t[0] === 'd');
        results.push({
          verification: verificationTag?.[1] || (vineIdTag ? 'old_vine' : 'unverified'),
          content: event.content
        });
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        ws.removeListener('message', messageHandler);
        resolve(results);
      }
    };

    ws.on('message', messageHandler);
  });
}

// Test int# filters
async function testIntFilter(ws, filterName, filterValue, expectedCount) {
  return new Promise((resolve) => {
    const subId = `test-int-${filterName}`;
    const results = [];

    const filter = {
      kinds: [34236],
      limit: 20
    };
    filter[`int#${filterName}`] = filterValue;

    ws.send(JSON.stringify(['REQ', subId, filter]));

    const messageHandler = (data) => {
      const msg = JSON.parse(data);
      if (msg[0] === 'EVENT' && msg[1] === subId) {
        results.push(msg[2]);
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        ws.removeListener('message', messageHandler);
        resolve(results);
      }
    };

    ws.on('message', messageHandler);
  });
}

// Main test runner
async function runTests() {
  const ws = new WebSocket(RELAY_URL);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('✓ Connected to relay\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  PROOFMODE VERIFICATION TEST SUITE');
  console.log('═══════════════════════════════════════════════════════\n');

  // Step 1: Publish test events
  await publishTestEvents(ws);

  // Step 2: Test verification level filters
  console.log('🔍 Testing verification level filters...\n');

  const verifiedMobileResults = await testVerificationFilter(ws, 'verified_mobile', ['verified_mobile']);
  console.log(`  ✓ verified_mobile filter: ${verifiedMobileResults.length} results`);
  verifiedMobileResults.forEach(r => console.log(`    - ${r.verification}: ${r.content}`));

  const verifiedWebResults = await testVerificationFilter(ws, 'verified_web', ['verified_web']);
  console.log(`\n  ✓ verified_web filter: ${verifiedWebResults.length} results`);
  verifiedWebResults.forEach(r => console.log(`    - ${r.verification}: ${r.content}`));

  const basicProofResults = await testVerificationFilter(ws, 'basic_proof', ['basic_proof']);
  console.log(`\n  ✓ basic_proof filter: ${basicProofResults.length} results`);
  basicProofResults.forEach(r => console.log(`    - ${r.verification}: ${r.content}`));

  // Step 3: Test int# filters
  console.log('\n\n🔍 Testing int# filters...\n');

  const hasProofmodeResults = await testIntFilter(ws, 'has_proofmode', { eq: 1 });
  console.log(`  ✓ int#has_proofmode = 1: ${hasProofmodeResults.length} results`);
  console.log(`    Expected: 3 (verified_mobile, verified_web, basic_proof)`);

  const hasAttestationResults = await testIntFilter(ws, 'has_device_attestation', { eq: 1 });
  console.log(`\n  ✓ int#has_device_attestation = 1: ${hasAttestationResults.length} results`);
  console.log(`    Expected: 1 (verified_mobile only)`);

  const hasPgpResults = await testIntFilter(ws, 'has_pgp_signature', { eq: 1 });
  console.log(`\n  ✓ int#has_pgp_signature = 1: ${hasPgpResults.length} results`);
  console.log(`    Expected: 2 (verified_mobile, verified_web)`);

  const noProofmodeResults = await testIntFilter(ws, 'has_proofmode', { eq: 0 });
  console.log(`\n  ✓ int#has_proofmode = 0: ${noProofmodeResults.length} results`);
  console.log(`    Expected: 2+ (unverified + old_vine_import + any existing videos without ProofMode)`);

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  let allPassed = true;

  // Check verified_mobile
  if (verifiedMobileResults.length === 1 && verifiedMobileResults[0].verification === 'verified_mobile') {
    console.log('  ✅ verified_mobile filtering: PASS');
  } else {
    console.log('  ❌ verified_mobile filtering: FAIL');
    allPassed = false;
  }

  // Check verified_web
  if (verifiedWebResults.length === 1 && verifiedWebResults[0].verification === 'verified_web') {
    console.log('  ✅ verified_web filtering: PASS');
  } else {
    console.log('  ❌ verified_web filtering: FAIL');
    allPassed = false;
  }

  // Check basic_proof
  if (basicProofResults.length === 1 && basicProofResults[0].verification === 'basic_proof') {
    console.log('  ✅ basic_proof filtering: PASS');
  } else {
    console.log('  ❌ basic_proof filtering: FAIL');
    allPassed = false;
  }

  // Check has_proofmode
  if (hasProofmodeResults.length >= 3) {
    console.log('  ✅ int#has_proofmode filtering: PASS');
  } else {
    console.log('  ❌ int#has_proofmode filtering: FAIL');
    allPassed = false;
  }

  // Check has_device_attestation
  if (hasAttestationResults.length >= 1) {
    console.log('  ✅ int#has_device_attestation filtering: PASS');
  } else {
    console.log('  ❌ int#has_device_attestation filtering: FAIL');
    allPassed = false;
  }

  // Check has_pgp_signature
  if (hasPgpResults.length >= 2) {
    console.log('  ✅ int#has_pgp_signature filtering: PASS');
  } else {
    console.log('  ❌ int#has_pgp_signature filtering: FAIL');
    allPassed = false;
  }

  console.log('\n═══════════════════════════════════════════════════════\n');

  if (allPassed) {
    console.log('🎉 ALL TESTS PASSED!\n');
  } else {
    console.log('⚠️  SOME TESTS FAILED - Check implementation\n');
  }

  ws.close();
  process.exit(allPassed ? 0 : 1);
}

// Run tests with error handling
runTests().catch(err => {
  console.error('❌ Test error:', err);
  process.exit(1);
});

setTimeout(() => {
  console.error('❌ Test timeout after 30 seconds');
  process.exit(1);
}, 30000);
