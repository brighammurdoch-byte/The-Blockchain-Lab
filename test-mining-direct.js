/**
 * Direct mining test - tests the blockchain engine without Socket.io
 */

const crypto = require('crypto');

// Load the BlockchainLab module
const BlockchainLab = require('./lib/blockchainLab');
const blockchainLab = new BlockchainLab();

// Test constants
const NUM_MINERS = 3;
const TARGET_BLOCKS = 100;

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
  
  if (difficulty.secondaryHex) {
    const nextChar = hash.charAt(zeros);
    if (nextChar.toLowerCase() > difficulty.secondaryHex.toLowerCase()) return false;
  }
  
  return true;
}

// Helper: Mine a block
function mineBlock(blockData) {
  let nonce = 0;
  const maxNonce = 50000000; // Safety limit
  let lastLog = 0;
  
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
    if (nonce - lastLog > 100000) {
      process.stdout.write(`    ${nonce.toLocaleString()} nonces...\r`);
      lastLog = nonce;
    }
  }
  
  return null; // Failed to mine
}

async function testMining() {
  console.log('=== Direct Mining Test (Backend) ===\n');
  console.log(`Target: ${TARGET_BLOCKS} blocks with ${NUM_MINERS} miners\n`);
  
  try {
    // Step 1: Create session
    console.log('Step 1: Creating session...');
    const sessionData = blockchainLab.createSession();
    if (!sessionData) {
      throw new Error('Failed to create session');
    }
    const { sessionId, joinCode, blockchain: initialState } = sessionData;
    console.log(`✓ Session created: ${sessionId}`);
    console.log(`  Initial chain height: ${initialState.chain.length}\n`);
    
    // Step 2: Join miners
    console.log(`Step 2: Joining ${NUM_MINERS} miners...`);
    const miners = [];
    for (let i = 0; i < NUM_MINERS; i++) {
      const joinResult = blockchainLab.joinSession(joinCode, `miner_${i}`, 'miner');
      if (!joinResult.success) {
        throw new Error(`Miner ${i} failed to join: ${joinResult.error}`);
      }
      miners.push({
        userId: `miner_${i}`,
        sessionId: sessionId
      });
    }
    console.log(`✓ All ${NUM_MINERS} miners joined\n`);
    
    // Step 3: Mine blocks
    console.log(`Step 3: Mining blocks...\n`);
    const startTime = Date.now();
    let totalBlocksMined = 0;
    let blocksMined = Array(NUM_MINERS).fill(0);
    
    while (totalBlocksMined < TARGET_BLOCKS) {
      // Get session
      const session = blockchainLab.sessions.get(sessionId);
      const blockchain = session.blockchain;
      
      // Each miner tries to mine one block
      for (let minerIdx = 0; minerIdx < NUM_MINERS; minerIdx++) {
        const miner = miners[minerIdx];
        
        // Get the participant's personal chain
        const participantChain = blockchainLab.getParticipantChain(sessionId, miner.userId);
        const miningTip = participantChain.chain[participantChain.chain.length - 1];
        
        // Create block to mine
        const blockData = {
          index: participantChain.height,
          timestamp: Date.now(),
          previousHash: miningTip.hash,
          transactions: [],
          miner: miner.userId,
          difficulty: blockchain.difficulty,
          forkId: 'classic'
        };
        
        process.stdout.write(`Miner ${minerIdx + 1}: Mining block #${blockData.index}...`);
        const minedBlock = mineBlock(blockData);
        
        if (!minedBlock) {
          console.log(`\n  ✗ Failed to mine block`);
          continue;
        }
        
        console.log(`\n  ✓ Block mined!`);
        console.log(`    Hash: ${minedBlock.hash.substring(0, 16)}...`);
        console.log(`    Nonce: ${minedBlock.nonce}`);
        
        // Add block to participant's chain
        const updateSuccess = blockchainLab.updateParticipantChain(sessionId, miner.userId, minedBlock);
        if (!updateSuccess) {
          console.log(`  ✗ Failed to add block to chain`);
          continue;
        }
        
        blocksMined[minerIdx]++;
        totalBlocksMined++;
        
        // Notify others of the block (simulate broadcast)
        // In real system, this happens via Socket.io
        
        if (totalBlocksMined >= TARGET_BLOCKS) {
          break;
        }
      }
      
      // Show progress
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Progress: ${totalBlocksMined}/${TARGET_BLOCKS} blocks (${elapsed.toFixed(1)}s)`);
      console.log(`Blocks per miner: [${blocksMined.join(', ')}]`);
      console.log(`Network height: ${blockchain.chain.length}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }
    
    // Final summary
    const totalTime = (Date.now() - startTime) / 1000;
    const avgTimePerBlock = totalTime / TARGET_BLOCKS;
    
    console.log(`\n=== TEST COMPLETE ===`);
    console.log(`\nSummary:`);
    console.log(`  Total blocks mined: ${totalBlocksMined}`);
    console.log(`  Total time: ${totalTime.toFixed(1)}s`);
    console.log(`  Avg time per block: ${avgTimePerBlock.toFixed(2)}s`);
    console.log(`  Blocks per miner: [${blocksMined.join(', ')}]`);
    
    // Verify blockchain state
    const finalSession = blockchainLab.sessions.get(sessionId);
    console.log(`\nFinal blockchain state:`);
    console.log(`  Chain height: ${finalSession.blockchain.chain.length}`);
    console.log(`  Genesis + ${totalBlocksMined} blocks mined`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run test
testMining();
