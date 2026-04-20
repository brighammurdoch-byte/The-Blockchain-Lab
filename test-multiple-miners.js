/**
 * Test multiple miners joining simultaneously
 */

const http = require('http');

const SERVER_URL = 'http://localhost:3000';
const NUM_MINERS = 3;

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

async function testMultipleMiners() {
  console.log('=== Test: Multiple Miners Joining ===\n');
  
  try {
    // Step 1: Create a session
    console.log('Step 1: Creating session...');
    const sessionData = await httpRequest('POST', '/lab/create', {});
    if (!sessionData.success) {
      throw new Error('Failed to create session: ' + sessionData.error);
    }
    const { sessionId, joinCode } = sessionData;
    console.log(`✓ Session created: ${sessionId}`);
    console.log(`  Join Code: ${joinCode}\n`);
    
    // Step 2: Join multiple miners
    const miners = [];
    for (let i = 0; i < NUM_MINERS; i++) {
      console.log(`Step ${i + 2}: Miner ${i + 1} joining...`);
      const joinResult = await httpRequest('POST', '/lab/join', {
        joinCode: joinCode,
        role: 'miner'
      });
      
      if (!joinResult.success) {
        throw new Error(`Miner ${i + 1} failed to join: ${joinResult.error}`);
      }
      
      const userId = joinResult.userId;
      console.log(`✓ Miner ${i + 1} joined with userId: ${userId}`);
      
      miners.push({
        userId,
        sessionId
      });
    }
    
    console.log(`\n✓ All ${NUM_MINERS} miners successfully joined via HTTP\n`);
    
    // Step 3: Verify session state
    console.log('Step ' + (NUM_MINERS + 2) + ': Verifying session state...');
    const sessionState = await httpRequest('GET', `/lab/session/${sessionId}`, null);
    
    if (!sessionState.success) {
      throw new Error('Failed to get session state: ' + sessionState.error);
    }
    
    console.log(`✓ Session state retrieved`);
    console.log(`  Block Height: ${sessionState.blockchain.chain.length}`);
    console.log(`  Participants: ${sessionState.participantCount}`);
    
    if (sessionState.participantCount !== NUM_MINERS) {
      throw new Error(`Expected ${NUM_MINERS} participants, got ${sessionState.participantCount}`);
    }
    
    console.log(`✓ All ${NUM_MINERS} miners are in the session\n`);
    
    // Step 4: Verify each miner can get their chain state
    console.log(`Step ${NUM_MINERS + 3}: Verifying chain access for each miner...`);
    for (let i = 0; i < miners.length; i++) {
      const chainState = await httpRequest('GET', `/lab/my-chain/${miners[i].sessionId}/${miners[i].userId}`, null);
      if (!chainState.success) {
        throw new Error(`Miner ${i + 1} failed to get chain state: ${chainState.error}`);
      }
      console.log(`✓ Miner ${i + 1} chain height: ${chainState.height}`);
    }
    
    console.log(`\n=== TEST PASSED ===`);
    console.log(`✓ ${NUM_MINERS} miners successfully joined the session`);
    console.log(`✓ All miners can access their blockchain state`);
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    process.exit(1);
  }
}

// Run test
testMultipleMiners();
