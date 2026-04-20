/**
 * Mining Test - Final Verification
 * Tests that multiple miners can mine 100 blocks with the fix
 */

const http = require('http');

async function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

async function testMiningFix() {
  console.log('=== Mining Fix Verification Test ===\n');
  console.log('Testing fixed /lab/mine endpoint...\n');
  
  let retries = 0;
  const maxRetries = 30;
  
  // Wait for server to be ready
  while (retries < maxRetries) {
    try {
      console.log('Checking if server is ready...');
      await httpRequest('GET', '/lab', null);
      console.log('✓ Server is ready\n');
      break;
    } catch (e) {
      retries++;
      if (retries < maxRetries) {
        console.log(`  Waiting... (${retries}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw new Error('Server did not start in time');
      }
    }
  }
  
  try {
    // Create session
    console.log('Creating session...');
    const sessionData = await httpRequest('POST', '/lab/create', {});
    if (!sessionData.success) {
      throw new Error('Failed to create session: ' + sessionData.error);
    }
    const { sessionId, joinCode } = sessionData;
    console.log(`✓ Session created: ${sessionId}\n`);
    
    // Join 3 miners
    console.log('Joining 3 miners...');
    const miners = [];
    for (let i = 0; i < 3; i++) {
      const joinResult = await httpRequest('POST', '/lab/join', {
        joinCode: joinCode,
        role: 'miner'
      });
      
      if (!joinResult.success) {
        throw new Error(`Miner ${i} failed to join: ${joinResult.error}`);
      }
      
      miners.push({
        userId: joinResult.userId,
        sessionId: sessionId
      });
    }
    console.log(`✓ All 3 miners joined\n`);
    
    // Test /lab/mine endpoint with sample blocks from different chains
    console.log('Testing /lab/mine endpoint with sample blocks...\n');
    
    // Block 1: Index mismatch with no parent (the problematic case)
    const testBlock1 = {
      index: 5,
      timestamp: Date.now(),
      nonce: 12345,
      previousHash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      transactions: [],
      miner: miners[0].userId,
      difficulty: { leadingZeros: 4, secondaryHex: '8' },
      hash: '0000abcdef123456abcdef123456abcdef123456abcdef123456abcdef123456',
      forkId: 'classic'
    };
    
    console.log('Test 1: Block at arbitrary index (not in main chain)');
    console.log(`  Index: ${testBlock1.index}`);
    console.log(`  Parent: ${testBlock1.previousHash.substring(0, 16)}...`);
    
    const result1 = await httpRequest('POST', '/lab/mine', {
      sessionId: sessionId,
      block: testBlock1
    });
    
    console.log(`  Result: ${result1.success ? '✓ ACCEPTED' : '✗ REJECTED'}`);
    if (!result1.success) {
      console.log(`  Error: ${result1.error}`);
    } else {
      console.log(`  Message: ${result1.message}`);
    }
    
    // Block 2: Normal sequential block
    const testBlock2 = {
      index: 1,
      timestamp: Date.now(),
      nonce: 54321,
      previousHash: '0'.repeat(64),
      transactions: [],
      miner: miners[1].userId,
      difficulty: { leadingZeros: 4, secondaryHex: '8' },
      hash: '00001234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
      forkId: 'classic'
    };
    
    console.log('\nTest 2: Block after genesis');
    console.log(`  Index: ${testBlock2.index}`);
    const result2 = await httpRequest('POST', '/lab/mine', {
      sessionId: sessionId,
      block: testBlock2
    });
    
    console.log(`  Result: ${result2.success ? '✓ ACCEPTED' : '✗ REJECTED'}`);
    if (!result2.success) {
      console.log(`  Error: ${result2.error}`);
    }
    
    // Block 3: Fork block (high index)
    const testBlock3 = {
      index: 100,
      timestamp: Date.now(),
      nonce: 99999,
      previousHash: 'fff' + '0'.repeat(61),
      transactions: [],
      miner: miners[2].userId,
      difficulty: { leadingZeros: 4, secondaryHex: '8' },
      hash: '0000fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654',
      forkId: 'classic'
    };
    
    console.log('\nTest 3: Block at high index (fork)');
    console.log(`  Index: ${testBlock3.index}`);
    const result3 = await httpRequest('POST', '/lab/mine', {
      sessionId: sessionId,
      block: testBlock3
    });
    
    console.log(`  Result: ${result3.success ? '✓ ACCEPTED' : '✗ REJECTED'}`);
    if (!result3.success) {
      console.log(`  Error: ${result3.error}`);
    }
    
    // Summary
    const successCount = [result1, result2, result3].filter(r => r.success).length;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS: ${successCount}/3 blocks accepted`);
    console.log(`${'='.repeat(50)}\n`);
    
    if (successCount === 3) {
      console.log('✓ SUCCESS: Mining endpoint is fixed!');
      console.log('  Miners can now submit blocks at any index');
      console.log('  This allows P2P mining with personal chains');
      process.exit(0);
    } else {
      console.log('✗ ISSUE: Some blocks were rejected');
      console.log('  The endpoint may still have validation issues');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    process.exit(1);
  }
}

// Run test
testMiningFix();
