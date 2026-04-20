const crypto = require('crypto');

/**
 * Mining utilities for blockchain lab
 */

class MiningUtils {
  /**
   * Calculate SHA256 hash of a block using canonical JSON (sorted keys)
   * This ensures the same hash is calculated regardless of key order
   */
  static hashBlock(block) {
    // Create a canonical representation with sorted keys
    const canonical = this.canonicalizeObject(block);
    const blockString = JSON.stringify(canonical);
    return crypto.createHash('sha256').update(blockString).digest('hex');
  }

  /**
   * Recursively sort object keys for canonical JSON representation
   */
  static canonicalizeObject(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => this.canonicalizeObject(item));
    } else if (obj !== null && typeof obj === 'object') {
      const sorted = {};
      Object.keys(obj).sort().forEach(key => {
        sorted[key] = this.canonicalizeObject(obj[key]);
      });
      return sorted;
    }
    return obj;
  }

  /**
   * Mine a block by finding a valid nonce (real Proof of Work)
   * This simulates actual PoW mining
   */
  static mineBlock(block, difficulty, maxIterations = 10000000, progressCallback = null) {
    let nonce = 0;
    let hash = '';
    
    const startTime = Date.now();
    const blockCopy = JSON.parse(JSON.stringify(block));
    
    while (nonce < maxIterations) {
      blockCopy.nonce = nonce;
      hash = this.hashBlock(blockCopy);
      
      // Check if hash meets difficulty requirement
      if (this.isValidHash(hash, difficulty)) {
        return {
          success: true,
          nonce: nonce,
          hash: hash,
          iterations: nonce,
          timeMs: Date.now() - startTime,
          hashrate: Math.floor(nonce / ((Date.now() - startTime) / 1000))
        };
      }
      
      nonce++;
      
      // Callback for progress updates (every 1000 attempts)
      if (progressCallback && nonce % 1000 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const hashrate = Math.floor(nonce / elapsed);
        progressCallback({
          nonce: nonce,
          hashrate: hashrate,
          estimated_remaining: this.estimateTimeRemaining(hashrate, nonce, difficulty)
        });
      }
    }
    
    return {
      success: false,
      nonce: nonce,
      hash: hash,
      iterations: nonce,
      timeMs: Date.now() - startTime,
      hashrate: Math.floor(nonce / ((Date.now() - startTime) / 1000))
    };
  }

  /**
   * Check if a hash meets difficulty requirements
   */
  static isValidHash(hash, difficulty) {
    if (!difficulty) return false;
    
    const leadingZeros = difficulty.leadingZeros || 4;
    
    // Check leading zeros
    for (let i = 0; i < leadingZeros; i++) {
      if (hash[i] !== '0') return false;
    }
    
    // Check secondary difficulty if applicable
    if (difficulty.secondaryHex) {
      const nextChar = hash.charAt(leadingZeros);
      if (nextChar > difficulty.secondaryHex) return false;
    }
    
    return true;
  }

  /**
   * Estimate time remaining for mining
   */
  static estimateTimeRemaining(currentHashrate, currentNonce, difficulty) {
    if (currentHashrate === 0) return Infinity;
    
    // Rough estimate: expected nonces needed based on difficulty
    const expectedNonces = Math.pow(16, difficulty.leadingZeros || 4) * 2;
    const remaining = Math.max(0, expectedNonces - currentNonce);
    const secondsRemaining = remaining / currentHashrate;
    
    return secondsRemaining;
  }

  /**
   * Simulate CPU usage constraints
   * Returns delay in milliseconds based on CPU limit percentage
   */
  static getCpuLimitDelay(cpuPercentage) {
    // Maps CPU percentage to delay
    // 100% CPU = 0ms delay (max speed)
    // 50% CPU = 10ms delay
    // 10% CPU = 100ms delay
    const delayMs = (100 - cpuPercentage) * 1;
    return Math.max(0, delayMs);
  }

  /**
   * Calculate cumulative difficulty (work required)
   */
  static calculateCumulativeDifficulty(chain) {
    let total = 0;
    
    chain.forEach(block => {
      const difficulty = block.difficulty || { leadingZeros: 4 };
      const workForBlock = Math.pow(16, difficulty.leadingZeros);
      total += workForBlock;
    });
    
    return total;
  }

  /**
   * Validate that a block's hash is correct
   */
  static validateBlockHash(block) {
    const blockCopy = JSON.parse(JSON.stringify(block));
    const originalHash = blockCopy.hash;
    delete blockCopy.hash;  // Remove hash field entirely, don't just empty it
    
    const calculatedHash = this.hashBlock(blockCopy);
    
    if (calculatedHash !== originalHash) {
      const canonical = this.canonicalizeObject(blockCopy);
      const canonicalStr = JSON.stringify(canonical);
      
      console.error(`Hash mismatch:`);
      console.error(`  Original hash:    ${originalHash}`);
      console.error(`  Calculated hash:  ${calculatedHash}`);
      console.error(`  Canonical JSON:   ${canonicalStr}`);
      console.error(`  Block data (no hash):`, blockCopy);
    }
    
    return calculatedHash === originalHash;
  }

  /**
   * Calculate network statistics
   */
  static calculateNetworkStats(chain, participants) {
    const stats = {
      blockHeight: chain.length,
      totalBlocks: chain.length,
      totalWork: this.calculateCumulativeDifficulty(chain),
      participantCount: participants.size,
      averageBlockTime: 0,
      totalHashpower: 0,
      minerDistribution: {}
    };
    
    // Calculate block times
    let totalBlockTime = 0;
    for (let i = 1; i < chain.length; i++) {
      totalBlockTime += chain[i].timestamp - chain[i-1].timestamp;
    }
    stats.averageBlockTime = chain.length > 1 ? totalBlockTime / (chain.length - 1) : 0;
    
    // Count blocks per miner
    chain.forEach(block => {
      if (!stats.minerDistribution[block.miner]) {
        stats.minerDistribution[block.miner] = 0;
      }
      stats.minerDistribution[block.miner]++;
    });
    
    return stats;
  }
}

module.exports = MiningUtils;
