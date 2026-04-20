const crypto = require('crypto');

/**
 * BLOCKCHAIN LAB - CONSENSUS CODE VALIDATOR
 * 
 * This is the code that runs on each participant's computer to validate blocks.
 * Students can view and modify this code to:
 * - Understand how blockchain validation works
 * - Experiment with attacks (51% attacks, double spending, etc.)
 * - Create soft forks (compatible changes)
 * - Create hard forks (incompatible changes)
 * - Propose improvement proposals (BIPs)
 */

class BlockValidator {
  constructor(config = {}) {
    // Validation parameters - students can change these!
    this.config = {
      requiredLeadingZeros: config.leadingZeros || 4,
      secondaryDifficulty: config.secondaryHex || '8',
      maxBlockSize: config.maxBlockSize || 1000000, // bytes
      maxTransactionsPerBlock: config.maxTransactions || 500,
      maxNonce: config.maxNonce || 4294967295, // 2^32
      allowFutureTx: config.allowFutureTx || false,
      ...config
    };
  }

  _canonicalizeObject(obj) {
    if (Array.isArray(obj)) {
        return obj.map(item => this._canonicalizeObject(item));
    } else if (obj !== null && typeof obj === 'object') {
        const sorted = {};
        Object.keys(obj).sort().forEach(key => {
            sorted[key] = this._canonicalizeObject(obj[key]);
        });
        return sorted;
    }
    return obj;
  }

  /**
   * CRITICAL: Validate a single block
   * This must pass for block to be accepted
   */
  validateBlockHash(block) {
    // Recreate the block without the hash
    const blockCopy = {
      index: block.index,
      timestamp: block.timestamp,
      nonce: block.nonce,
      previousHash: block.previousHash,
      transactions: block.transactions,
      miner: block.miner,
      difficulty: block.difficulty,
      forkId: block.forkId
    };

    // Canonicalize before hashing to ensure consistent key order
    const canonical = this._canonicalizeObject(blockCopy);

    // Calculate what the hash SHOULD be
    const expectedHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');

    // Check if it matches
    return expectedHash === block.hash;
  }

  /**
   * Verify hash meets difficulty requirement
   */
  validateDifficulty(hash, difficulty) {
    const requiredZeros = difficulty.leadingZeros || this.config.requiredLeadingZeros;
    const secondaryHex = difficulty.secondaryHex || this.config.secondaryDifficulty;

    // Check leading zeros
    for (let i = 0; i < requiredZeros; i++) {
      if (hash[i] !== '0') {
        return {
          valid: false,
          reason: `Hash does not have ${requiredZeros} leading zeros`,
          details: `Found: ${hash.substring(0, requiredZeros)}`
        };
      }
    }

    // Check secondary hex digit
    if (hash[requiredZeros] > secondaryHex) {
      return {
        valid: false,
        reason: `Secondary difficulty not met: 0x${hash[requiredZeros]} > 0x${secondaryHex}`,
        details: `Hash: ${hash}`
      };
    }

    return { valid: true };
  }

  /**
   * FORK POINT: Validate chain linkage
   * Change this to accept blocks from competing chains!
   */
  validatePreviousHash(block, previousBlock) {
    if (!previousBlock) {
      return { valid: true, note: 'Genesis block' };
    }

    // STANDARD VALIDATION (comment out for soft fork)
    if (block.previousHash !== previousBlock.hash) {
      return {
        valid: false,
        reason: 'Previous hash does not match',
        expected: previousBlock.hash,
        got: block.previousHash
      };
    }

    // SOFT FORK: Accept alternate chains with different history
    // const isFork = block.previousHash !== previousBlock.hash;
    // if (isFork) {
    //   return { valid: true, warning: 'Fork accepted - chain reorganization', fork: true };
    // }

    return { valid: true };
  }

  /**
   * Transaction validation
   * Change rules here to accept invalid transactions (attack vector)
   */
  validateTransaction(tx, allTransactions = []) {
    // Check required fields
    if (!tx.id || !tx.from || !tx.to || tx.amount === undefined) {
      return { valid: false, reason: 'Missing required fields' };
    }

    // Check amount is positive
    if (tx.amount <= 0) {
      return { valid: false, reason: 'Amount must be positive' };
    }

    // ATTACK VECTOR: Double spending
    // Check if sender sent more coins than they have in previous blocks
    // (Disabled below for demonstration)
    const totalSent = allTransactions
      .filter(t => t.from === tx.from)
      .reduce((sum, t) => sum + t.amount, 0);

    // Uncomment to disable double-spend protection (accepts attack)
    // return { valid: true, warning: 'Double-spend check disabled!' };

    return { valid: true };
  }

  /**
   * Full block validation
   */
  validateFullBlock(block, previousBlock, allBlocks = []) {
    const results = {
      blockHashValid: this.validateBlockHash(block),
      difficultyValid: this.validateDifficulty(block.hash, block.difficulty),
      previousHashValid: this.validatePreviousHash(block, previousBlock),
      transactionsValid: true,
      transactionErrors: []
    };

    // Validate all transactions
    block.transactions?.forEach((tx, idx) => {
      const txValid = this.validateTransaction(tx, block.transactions);
      if (!txValid.valid) {
        results.transactionsValid = false;
        results.transactionErrors.push({
          index: idx,
          ...txValid
        });
      }
    });

    return {
      isValid: results.blockHashValid && results.difficultyValid && 
               results.previousHashValid && results.transactionsValid,
      details: results
    };
  }

  /**
   * Validate entire chain
   */
  validateChain(chain) {
    const results = {
      isValid: true,
      errors: [],
      warnings: [],
      forkDetected: false
    };

    for (let i = 1; i < chain.length; i++) {
      const currentBlock = chain[i];
      const previousBlock = chain[i - 1];
      const blockValidation = this.validateFullBlock(currentBlock, previousBlock, chain);

      if (!blockValidation.isValid) {
        results.isValid = false;
        results.errors.push({
          blockIndex: i,
          ...blockValidation.details
        });
      }
    }

    return results;
  }

  /**
   * SOFT FORK: Accept new validation rule, old nodes can still validate
   * Example: stricter transaction format
   */
  enableSoftFork(forkName) {
    if (forkName === 'segwit-style') {
      // Soft fork: accept transactions with new optional field
      // Old validators still see it as valid
      this.config.allowExtendedTransactionData = true;
      return { success: true, message: 'Soft fork enabled: Extended transaction data' };
    }
    if (forkName === 'larger-blocks') {
      // Soft fork: increase max block size (backward compatible if not used)
      this.config.maxBlockSize = 2000000;
      return { success: true, message: 'Soft fork enabled: Larger block size available' };
    }
    return { success: false, message: 'Unknown soft fork' };
  }

  /**
   * HARD FORK: Incompatible change, all nodes must upgrade
   * Example: require all transactions to have sender's digital signature
   */
  enableHardFork(forkName) {
    if (forkName === 'require-signatures') {
      // Hard fork: require digital signatures on all transactions
      // Old nodes CANNOT validate - they will reject these blocks
      this.config.requireSignatures = true;
      return { success: true, message: 'Hard fork enabled: Signatures now required (old nodes cannot sync!)' };
    }
    if (forkName === 'increase-difficulty') {
      // Hard fork: permanently increase difficulty
      this.config.requiredLeadingZeros = 4;
      return { success: true, message: 'Hard fork: Difficulty permanently increased to 4' };
    }
    return { success: false, message: 'Unknown hard fork' };
  }

  /**
   * IMPROVEMENT PROPOSAL (BIP-style)
   * Describe a change without implementing it yet
   */
  static generateBIP(title, description, impact) {
    return {
      type: 'BIP (Blockchain Improvement Proposal)',
      title,
      description,
      impact, // How it affects the network
      status: 'draft',
      proposedAt: new Date().toISOString()
    };
  }
}

module.exports = BlockValidator;
