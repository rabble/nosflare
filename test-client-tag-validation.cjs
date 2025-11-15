/**
 * Test script for client tag validation
 * 
 * This tests the new client tag requirement for events.
 * Valid client tags: "divine.video", "divine-web", "divine", "openvine"
 */

const WebSocket = require('ws');

const RELAY_URL = 'wss://relay.divine.video';

// Helper to generate a simple test event
function createTestEvent(clientTag) {
  const event = {
    id: '0'.repeat(64), // Dummy ID
    pubkey: 'd49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: clientTag ? [['client', clientTag]] : [],
    content: 'Test event for client tag validation',
    sig: '0'.repeat(128) // Dummy signature (will fail verification but that's expected)
  };
  return event;
}

async function testClientTagValidation() {
  console.log('🧪 Testing Client Tag Validation\n');
  console.log('Valid client tags: divine.video, divine-web, divine, openvine\n');

  const tests = [
    { 
      name: 'Valid client tag: divine.video',
      event: createTestEvent('divine.video'),
      expectedFailure: 'signature verification' // Will fail signature, not client tag
    },
    { 
      name: 'Valid client tag: divine-web',
      event: createTestEvent('divine-web'),
      expectedFailure: 'signature verification'
    },
    { 
      name: 'Valid client tag: divine',
      event: createTestEvent('divine'),
      expectedFailure: 'signature verification'
    },
    { 
      name: 'Valid client tag: openvine',
      event: createTestEvent('openvine'),
      expectedFailure: 'signature verification'
    },
    { 
      name: 'Invalid client tag: random-app',
      event: createTestEvent('random-app'),
      expectedFailure: 'official app'
    },
    { 
      name: 'Missing client tag',
      event: createTestEvent(null),
      expectedFailure: 'official app'
    }
  ];

  for (const test of tests) {
    await new Promise((resolve) => {
      const ws = new WebSocket(RELAY_URL);

      ws.on('open', () => {
        console.log(`\n📤 Testing: ${test.name}`);
        const eventMessage = JSON.stringify(['EVENT', test.event]);
        ws.send(eventMessage);
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        
        if (message[0] === 'OK') {
          const [, eventId, accepted, reason] = message;
          
          if (accepted) {
            console.log(`   ✅ Event accepted (unexpected!)`);
          } else {
            console.log(`   ❌ Event rejected: ${reason}`);
            
            if (reason.includes(test.expectedFailure)) {
              console.log(`   ✓ Expected rejection reason matched`);
            } else {
              console.log(`   ⚠️  Expected "${test.expectedFailure}" but got different reason`);
            }
          }
          
          ws.close();
          setTimeout(resolve, 100);
        }
      });

      ws.on('error', (error) => {
        console.error(`   ❌ WebSocket error: ${error.message}`);
        ws.close();
        setTimeout(resolve, 100);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        console.log(`   ⏱️  Test timeout`);
        ws.close();
        resolve();
      }, 5000);
    });
  }

  console.log('\n✅ Client tag validation tests completed!\n');
}

// Run the tests
testClientTagValidation().catch(console.error);
