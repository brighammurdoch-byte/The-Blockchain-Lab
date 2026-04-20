/**
 * Test mining functionality - simulates miners finding blocks
 */

const crypto = require('crypto');
const http = require('http');

// Test constants
const NUM_MINERS = 3;
const TARGET_BLOCKS = 100;
const DIFFICULTY = { leadingZeros: 4, secondaryHex: '8' };

// Helper: Calculate SHA256
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Helper: Check if hash meets difficulty
function isValidHash(hash, difficulty) {
  const zeros = difficulty.leadingZeros || 4;
  for (let i = 0; i < zeros; i++) {
    if (hash[i] !== '0') return false;
  }
  
  // Check secondary difficulty constraint
  if (difficulty.secondaryHex) {
    const nextChar = hash.charAt(zeros);
    if (nextChar.toLowerCase() > difficulty.secondaryHex.toLowerCase()) return false;
  }
  
  return true;
}

// Helper: Mine a block
function mineBlock(blockData) {
  let nonce = 0;
  const maxNonce = 10000000; // Safety limit
  
  while (nonce < maxNonce) {
    const blockObj = {
      index: blockData.index,
      timestamp: blockData.timestamp,
      nonce: nonce,
      previousHash: blockData.previousHash,
      transactions: blockData.transactions || [],
      miner: blockData.miner,
      difficulty: blockData.difficulty,
      forkId: blockData.forkId || 'classic'
    };
    
    const blockStr = JSON.stringify(blockObj);
    const hash = sha256(blockStr);
    
    if (isValidHash(hash, blockData.difficulty)) {
      return {
        ...blockData,
        nonce: nonce,
        hash: hash,
        timestamp: blockObj.timestamp
      };
    }
    
    nonce++;
    
    // Show progress every 100k attempts
    if (nonce % 100000 === 0) {
      const iterations = nonce;
      process.stdout.write(`  Mining... ${iterations.toLocaleString()} nonces tried\r`);
    }
  }
  
  return null; // Failed to mine
}

// Helper: HTTP request
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

async function testMining() {
  console.log('=== Mining Performance Test ===\n');
  console.log(`Target: ${TARGET_BLOCKS} blocks with ${NUM_MINERS} miners`);
  console.log(`Difficulty: ${DIFFICULTY.leadingZeros} leading zeros, secondary: ${DIFFICULTY.secondaryHex}\n`);
  
  try {
    // Step 1: Create session
    console.log('Step 1: Creating session...');
    const sessionData = await httpRequest('POST', '/lab/create', {});
    if (!sessionData.success) {
      throw new Error('Failed to create session: ' + sessionData.error);
    }
    const { sessionId, joinCode } = sessionData;
    console.log(`✓ Session created: ${sessionId}\n`);
    
    // Step 2: Join miners
    console.log(`Step 2: Joining ${NUM_MINERS} miners...`);
    const miners = [];
    for (let i = 0; i < NUM_MINERS; i++) {
      const joinResult = await httpRequest('POST', '/lab/join', {
        joinCode: joinCode,
        role: 'miner'
      });
      
      if (!joinResult.success) {
        throw new Error(`Miner ${i + 1} failed to join: ${joinResult.error}`);
      }
      
      miners.push({
        userId: joinResult.userId,
        sessionId: sessionId,
        blocksMinedCount: 0
      });
    }
    console.log(`✓ All ${NUM_MINERS} miners joined\n`);
    
    // Step 3: Mine blocks
    console.log(`Step 3: Mining blocks...\n`);
    const startTime = Date.now();
    let totalBlocksMined = 0;
    let blocksMined = [0, 0, 0]; // Per miner
    
    while (totalBlocksMined < TARGET_BLOCKS) {
      // Get current session state
      const sessionState = await httpRequest('GET', `/lab/session/${sessionId}`, null);
      if (!sessionState.success) {
        throw new Error('Failed to get session state');
      }
      
      const networkHeight = sessionState.blockchain.chain.length;
      
      // Each miner tries to mine blocks
      for (let minerIdx = 0; minerIdx < NUM_MINERS; minerIdx++) {
        const miner = miners[minerIdx];
        
        // Get miner's personal chain
        const chainState = await httpRequest('GET', `/lab/my-chain/${sessionId}/${miner.userId}`, null);
        if (!chainState.success) {
          console.log(`✗ Failed to get chain for miner ${minerIdx + 1}`);
          continue;
        }
        
        const minerHeight = chainState.height;
        
        // Try to mine a block on top of miner's current tip
        const blockData = {
          index: minerHeight,
          timestamp: Date.now(),
          previousHash: chainState.tip,
          transactions: sessionState.blockchain.pendingTransactions || [],
          miner: miner.userId,
          difficulty: sessionState.adminSettings.currentDifficulty || DIFFICULTY,
          forkId: 'classic'
        };
        
        console.log(`\nMiner ${minerIdx + 1}: Mining block #${blockData.index}...`);
        const minedBlock = mineBlock(blockData);
        
        if (!minedBlock) {
          console.log(`  ✗ Failed to mine block (nonce exhausted)`);
          continue;
        }
        
        console.log(`  ✓ Block mined! Hash: ${minedBlock.hash.substring(0, 16)}...`);
        console.log(`    Nonce: ${minedBlock.nonce}, Time: ${(Date.now() - startTime) / 1000}s`);
        
        // Submit block to server
        const submitResult = await httpRequest('POST', '/lab/submit-block', {
          sessionId: sessionId,
          block: minedBlock,
          minerUserId: miner.userId
        });
        
        if (submitResult && submitResult.success) {
          console.log(`  ✓ Block submitted to network`);
          blocksMined[minerIdx]++;
          totalBlocksMined++;
        } else {
          console.log(`  ✗ Failed to submit block: ${submitResult?.error || 'Unknown error'}`);
        }
        
        if (totalBlocksMined >= TARGET_BLOCKS) {
          break;
        }
      }
      
      // Show progress
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Progress: ${totalBlocksMined}/${TARGET_BLOCKS} blocks (${elapsed.toFixed(1)}s elapsed)`);
      console.log(`Miner blocks: [${blocksMined[0]}, ${blocksMined[1]}, ${blocksMined[2]}]`);
      console.log(`Network height: ${networkHeight}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }
    
    // Final summary
    const totalTime = (Date.now() - startTime) / 1000;
    const avgTimePerBlock = totalTime / TARGET_BLOCKS;
    
    console.log(`\n✓ Mining test complete!`);
    console.log(`\nSummary:`);
    console.log(`  Total blocks mined: ${totalBlocksMined}`);
    console.log(`  Total time: ${totalTime.toFixed(1)}s`);
    console.log(`  Avg time per block: ${avgTimePerBlock.toFixed(2)}s`);
    console.log(`  Blocks per miner: [${blocksMined[0]}, ${blocksMined[1]}, ${blocksMined[2]}]`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    process.exit(1);
  }
}

// Run test
testMining();
