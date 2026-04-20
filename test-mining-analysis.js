/**
 * Mining Difficulty Analysis
 * Analyzes expected mining times for current difficulty settings
 */

const crypto = require('crypto');

// Load blockchain lab to get current settings
const BlockchainLab = require('./lib/blockchainLab');
const blockchainLab = new BlockchainLab();

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

console.log('=== MINING DIFFICULTY ANALYSIS ===\n');
console.log('Current Settings:');
console.log(`  DIFFICULTY_LEADING_ZEROS: ${blockchainLab.adminSettings.difficultyLeading}`);
console.log(`  DIFFICULTY_SECONDARY: ${blockchainLab.adminSettings.difficultySecondary} (0x${blockchainLab.adminSettings.difficultySecondary.toString(16)})`);
console.log(`  Current Difficulty: ${blockchainLab.adminSettings.currentDifficulty.displayName}\n`);

// Calculate expected difficulty
const leadingZeros = blockchainLab.adminSettings.difficultyLeading;
const secondaryHex = parseInt(blockchainLab.adminSettings.difficultySecondary.toString(16), 16);
const secondaryBits = 16 - Math.log2(secondaryHex + 1);

console.log('Difficulty Analysis:');
console.log(`  Leading zeros requirement: ${leadingZeros}`);
console.log(`  Each leading zero requires ~16x more hashes`);
console.log(`  Expected minimum hashes for leading zeros: 16^${leadingZeros} = ${Math.pow(16, leadingZeros).toLocaleString()}`);
console.log(`  Secondary hex value: 0x${secondaryHex.toString(16)}`);
console.log(`  Secondary hex bits: ${secondaryBits.toFixed(2)} bits`);
console.log(`  Combined factor: ~2^${(leadingZeros * 4 + secondaryBits).toFixed(1)}\n`);

// Estimate hashrate and mining times
console.log('Mining Time Estimates (Browser SHA256):');
console.log('  Typical browser SHA256 hashrate: 50,000 - 200,000 H/s');
console.log('  With CPU throttling at 50%: 25,000 - 100,000 H/s\n');

const expectedHashes = Math.pow(16, leadingZeros) * ((16 - secondaryHex) / 16);
const lowHashrate = 50000;
const midHashrate = 100000;
const highHashrate = 200000;

console.log(`Expected hashes needed: ~${expectedHashes.toLocaleString()}`);
console.log(`\nEstimated time per block:`);
console.log(`  At 50K H/s:   ${(expectedHashes / lowHashrate).toFixed(1)}s`);
console.log(`  At 100K H/s:  ${(expectedHashes / midHashrate).toFixed(1)}s`);
console.log(`  At 200K H/s:  ${(expectedHashes / highHashrate).toFixed(1)}s\n`);

// Test actual mining speed
console.log('Testing actual mining speed...\n');

let nonce = 0;
let counted = 0;
const startTime = Date.now();
const blockData = {
  index: 1,
  timestamp: Date.now(),
  nonce: 0,
  previousHash: '0'.repeat(64),
  transactions: [],
  miner: 'test',
  difficulty: blockchainLab.adminSettings.currentDifficulty,
  forkId: 'classic'
};

while (counted < 10) {
  const blockObj = {
    index: blockData.index,
    timestamp: blockData.timestamp,
    nonce: nonce,
    previousHash: blockData.previousHash,
    transactions: blockData.transactions,
    miner: blockData.miner,
    difficulty: blockData.difficulty,
    forkId: blockData.forkId
  };
  
  const hash = sha256(JSON.stringify(blockObj));
  
  if (isValidHash(hash, blockData.difficulty)) {
    const elapsed = (Date.now() - startTime) / 1000;
    const hashrate = Math.floor((nonce + 1) / elapsed);
    console.log(`Block ${counted + 1}:`);
    console.log(`  Hash: ${hash.substring(0, 16)}...`);
    console.log(`  Nonce: ${nonce.toLocaleString()}`);
    console.log(`  Hashrate: ${hashrate.toLocaleString()} H/s`);
    
    counted++;
    nonce = 0; // Reset for next block
    blockData.index++;
    blockData.previousHash = hash;
  } else {
    nonce++;
  }
}

const totalTime = (Date.now() - startTime) / 1000;
console.log(`\nTotal time for 10 blocks: ${totalTime.toFixed(1)}s`);
console.log(`Average time per block: ${(totalTime / 10).toFixed(1)}s`);
console.log(`Average hashrate: ${(nonce / (totalTime / 10)).toLocaleString()} H/s\n`);

// Recommendations
console.log('=== RECOMMENDATIONS ===\n');

if (totalTime / 10 > 10) {
  console.log('⚠️  Mining is SLOW for classroom use');
  console.log('   Consider reducing difficulty:\n');
  
  const newLeadingRecommended = Math.max(2, leadingZeros - 1);
  const newDiff = blockchainLab.calculateDifficulty(newLeadingRecommended, secondaryHex);
  console.log(`   Option 1: Reduce leading zeros to ${newLeadingRecommended}`);
  console.log(`   - Expected time per block: ~${(totalTime / 10 / Math.pow(16, leadingZeros - newLeadingRecommended)).toFixed(1)}s\n`);
  
  if (secondaryHex > 0) {
    const newSecondaryRecommended = Math.floor(secondaryHex / 2);
    console.log(`   Option 2: Reduce secondary hex to 0x${newSecondaryRecommended.toString(16)}`);
    console.log(`   - Expected time per block: ~${(totalTime / 10 * 0.5).toFixed(1)}s\n`);
  }
} else if (totalTime / 10 < 1) {
  console.log('✓ Mining is FAST - difficulty is appropriate');
} else {
  console.log('✓ Mining speed is reasonable for classroom use');
}

console.log('Suggestions:');
console.log('1. Set DIFFICULTY_LEADING_ZEROS=2 or 3 for classroom use');
console.log('2. Ensure miners keep browser tab active (not backgrounded)');
console.log('3. Reduce CPU throttling (set cpuUsage slider higher)');
console.log('4. Use Firefox instead of Chrome for better JavaScript performance');
