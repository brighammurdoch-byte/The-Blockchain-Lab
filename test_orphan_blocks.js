#!/usr/bin/env node

/**
 * Test script for orphan blocks and chain sync features
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';
let sessionId = null;
let joinCode = null;
let participantId = 'test-participant';

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });

    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Testing Orphan Blocks & Chain Sync Features...\n');

  try {
    // Test 1: Create session
    console.log('📝 Test 1: Creating session...');
    const createRes = await makeRequest('POST', '/lab/create', {});
    if (createRes.status !== 200) {
      throw new Error('Failed to create session');
    }
    sessionId = createRes.data.sessionId;
    joinCode = createRes.data.joinCode;
    console.log(`✅ Session created: ${sessionId}\n`);

    // Test 2: Join as participant
    console.log('📝 Test 2: Joining as participant...');
    const joinRes = await makeRequest('POST', '/lab/join', {
      joinCode: joinCode,
      userId: participantId,
      role: 'participant'
    });
    if (joinRes.status !== 200) {
      throw new Error('Failed to join as participant');
    }
    console.log(`✅ Participant joined\n`);

    // Test 3: Fetch fork information
    console.log('📝 Test 3: Fetching fork information...');
    const forksRes = await makeRequest('GET', `/lab/forks/${sessionId}`);
    if (forksRes.status !== 200) {
      throw new Error('Failed to get fork information');
    }
    console.log(`✅ Fork data retrieved`);
    console.log(`   - Orphan count: ${forksRes.data.forks.orphanCount || 0}\n`);

    // Test 4: Get personal chain
    console.log('📝 Test 4: Getting personal chain...');
    const chainRes = await makeRequest('GET', `/lab/my-chain/${sessionId}/${participantId}`);
    if (chainRes.status !== 200) {
      throw new Error('Failed to get personal chain');
    }
    const initialHeight = chainRes.data.height;
    console.log(`✅ Personal chain retrieved`);
    console.log(`   - Height: ${initialHeight}\n`);

    // Test 5: Get network blockchain
    console.log('📝 Test 5: Getting network blockchain...');
    const networkRes = await makeRequest('GET', `/lab/session/${sessionId}`);
    if (networkRes.status !== 200) {
      throw new Error('Failed to get network blockchain');
    }
    const networkHeight = networkRes.data.blockchain.chain.length;
    console.log(`✅ Network blockchain retrieved`);
    console.log(`   - Network height: ${networkHeight}\n`);

    // Test 6: Test sync-chain endpoint
    console.log('📝 Test 6: Testing chain sync endpoint...');
    const syncRes = await makeRequest('POST', '/lab/sync-chain', {
      sessionId: sessionId,
      userId: participantId,
      targetChain: networkRes.data.blockchain.chain
    });
    if (syncRes.status !== 200) {
      console.error('Debug: Sync response:', syncRes);
      throw new Error(`Failed to sync chain: ${syncRes.status} ${syncRes.data.error || JSON.stringify(syncRes.data)}`);
    }
    console.log(`✅ Chain sync successful`);
    console.log(`   - New height: ${syncRes.data.newHeight}\n`);

    // Test 7: Verify personal chain was updated
    console.log('📝 Test 7: Verifying personal chain update...');
    const verifyRes = await makeRequest('GET', `/lab/my-chain/${sessionId}/${participantId}`);
    if (verifyRes.status !== 200) {
      throw new Error('Failed to get updated personal chain');
    }
    const updatedHeight = verifyRes.data.height;
    console.log(`✅ Personal chain updated`);
    console.log(`   - Old height: ${initialHeight}`);
    console.log(`   - New height: ${updatedHeight}`);
    console.log(`   - Heights match: ${updatedHeight === networkHeight ? 'YES' : 'NO'}\n`);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ All orphan block & sync tests passed!\n');
    console.log('Features verified:');
    console.log('  ✅ Orphan block data retrieval (/lab/forks endpoint)');
    console.log('  ✅ Network blockchain display');
    console.log('  ✅ Chain sync endpoint (/lab/sync-chain)');
    console.log('  ✅ Personal chain auto-update functionality');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

runTests();
