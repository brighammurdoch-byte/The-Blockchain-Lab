/**
 * GUIDED DEMO SYSTEM
 * 
 * Provides interactive demonstrations of:
 * - Soft forks
 * - Hard forks
 * - Improvement proposals
 * - Attacks (51%, double-spend, etc.)
 * 
 * Each demo includes:
 * - Setup instructions
 * - Expected outcomes
 * - Code modifications needed
 * - Educational explanations
 */

class GuidedDemoSystem {
  constructor() {
    this.demos = {
      // SOFT FORK DEMOS
      'soft-fork-transaction-format': this.createSoftForkDemo(),
      'soft-fork-larger-blocks': this.createLargerBlocksDemo(),

      // HARD FORK DEMOS
      'hard-fork-difficulty': this.createDifficultyHardForkDemo(),
      'hard-fork-signatures': this.createSignatureHardForkDemo(),

      // IMPROVEMENT PROPOSALS
      'bip-transaction-fees': this.createTransactionFeesBIP(),
      'bip-block-time-target': this.createBlockTimeBIP(),

      // ATTACK DEMOS
      'attack-51-percent': this.create51PercentAttackDemo(),
      'attack-double-spend': this.createDoubleSpendDemo(),
      'attack-selfish-mining': this.createSelfishMiningDemo(),
      'attack-eclipse': this.createEclipseAttackDemo(),

      // SUCCESS/FAIL ATTACKS
      'attack-51-will-succeed': this.create51SuccessDemo(),
      'attack-51-will-fail': this.create51FailDemo(),
    };
  }

  // ==================== SOFT FORK DEMOS ====================

  createSoftForkDemo() {
    return {
      name: 'Soft Fork: Extended Transaction Format',
      category: 'soft-fork',
      difficulty: 'Intermediate',
      timeEstimate: '10-15 minutes',
      
      overview: `
A SOFT FORK is a backward-compatible upgrade. Old nodes running the original code 
will still accept blocks from upgraded nodes - they just won't enforce the new rule.

Think of it like email: if Gmail starts storing extra metadata in emails, 
Outlook can still receive and read those emails (it just ignores the extra stuff).
      `,

      setup: {
        description: 'Modify the BlockValidator to accept new optional transaction fields',
        steps: [
          'Open BlockValidator.js on your validator',
          'Find the validateTransaction() function',
          'Add support for optional "memo" field in transactions',
          'Transactions WITH memo are new-style, WITHOUT are old-style',
          'Both should be accepted (backward compatible)'
        ]
      },

      codeModification: {
        location: 'lib/blockValidator.js - validateTransaction()',
        before: `
validateTransaction(tx) {
  if (!tx.id || !tx.from || !tx.to || tx.amount === undefined) {
    return { valid: false, reason: 'Missing required fields' };
  }
  return { valid: true };
}
        `,
        after: `
validateTransaction(tx) {
  // Required fields (always checked)
  if (!tx.id || !tx.from || !tx.to || tx.amount === undefined) {
    return { valid: false, reason: 'Missing required fields' };
  }
  
  // Optional NEW field - this is the soft fork!
  // Old nodes ignore it, new nodes support it
  if (tx.memo && tx.memo.length > 100) {
    return { valid: false, reason: 'Memo too long' };
  }
  
  return { valid: true };
}
        `
      },

      expectedOutcome: `
- Miners with upgraded validator WILL mine blocks with memo field
- Miners with old validator WILL STILL accept blocks with memo field
- Both node types continue to agree on the chain
- This is a successful soft fork!
      `,

      whyItWorks: `
Soft forks work because they ADD restrictions, not remove them.
A soft fork is "backward compatible" - it doesn't break old code.

Real example: Bitcoin's SegWit was a soft fork.
It modified how transaction data is stored, but old nodes could still validate blocks.
      `,

      realWorldExample: 'Bitcoin SegWit (2017), Taproot (2021)',

      demo: {
        studentA: { validator: 'old', description: 'Keep original validator' },
        studentB: { validator: 'new-with-memo', description: 'Activate soft fork validator' },
        expected: 'Both agree on same chain, some blocks have new memo field'
      }
    };
  }

  createLargerBlocksDemo() {
    return {
      name: 'Soft Fork: Larger Block Size',
      category: 'soft-fork',
      difficulty: 'Beginner',
      timeEstimate: '5-10 minutes',

      overview: `
Increase the block size limit, but make it optional.

Why is this a soft fork? Because old validators set max 1MB blocks,
and new validators set max 2MB. New nodes might create 1.5MB blocks,
but old nodes can still validate them (as long as they don't exceed 1MB).

If a new node creates a 1.8MB block, old nodes REJECT it - chain splits!
      `,

      codeModification: {
        location: 'lib/blockValidator.js - constructor',
        change: 'maxBlockSize: config.maxBlockSize || 2000000 (was 1000000)',
        softForkReason: 'Larger blocks are still accepted by old nodes if they stay under 1MB'
      },

      expectedOutcome: 'New blocks stay under 1MB, chain remains unified',

      learningPoint: 'Soft forks are "forward compatible changes that old code still understands"'
    };
  }

  // ==================== HARD FORK DEMOS ====================

  createDifficultyHardForkDemo() {
    return {
      name: 'Hard Fork: Increase Difficulty',
      category: 'hard-fork',
      difficulty: 'Beginner',
      timeEstimate: '10 minutes',

      overview: `
A HARD FORK is NOT backward compatible. Old nodes CANNOT validate new blocks.

When one group of miners hard forks (upgrades), they permanently split from the other group.
The BlockchainLab will show you TWO separate chains!

This is what happened when Bitcoin → Bitcoin Cash split in 2017.
They couldn't agree on block size, so they split into separate blockchains.
      `,

      setup: {
        steps: [
          'Group A: Keep original validator (3 leading zeros)',
          'Group B: Enable hard fork to 4 leading zeros',
          'Watch what happens when both try to mine'
        ]
      },

      codeModification: {
        location: 'lib/blockValidator.js - enableHardFork()',
        before: 'requiredLeadingZeros: 3',
        after: 'requiredLeadingZeros: 4',
        consequence: 'Old nodes CANNOT validate blocks with 4 zeros - chain FORKS'
      },

      expectedOutcome: `
CHAIN FORK! You'll see:
- Group A's chain (3 zeros) continues normally
- Group B's chain (4 zeros) is harder to mine, slower growth
- The two groups NO LONGER AGREE on the true chain
- Each thinks the other is invalid
- This is called a "hard fork" because it's permanent and incompatible
      `,

      whyItMatters: `
Hard forks are contentious because:
1. Miners must choose: follow old or new rules?
2. Exchanges must choose: which is "real" Bitcoin?
3. Users are forced to pick a side
4. Coins split into two separate assets

Hard forks require community consensus to avoid chaos.
      `,

      realWorldExample: 'Bitcoin → Bitcoin Cash (2017), Ethereum → ETC (2016)',

      demo: {
        setup: 'Have students split into two groups',
        groupA: { name: 'Bitcoin Core', difficulty: 3, description: 'Keep original' },
        groupB: { name: 'Bitcoin Cash', difficulty: 4, description: 'Hard fork to 4' },
        result: 'Watch network naturally split into two chains'
      }
    };
  }

  createSignatureHardForkDemo() {
    return {
      name: 'Hard Fork: Require Digital Signatures',
      category: 'hard-fork',
      difficulty: 'Advanced',
      timeEstimate: '15 minutes',

      overview: `
Imagine the network decides ALL transactions must be digitally signed
for security. This requires new code that:

1. Generates public/private key pairs for each user
2. Signs all transactions with private key
3. Validates signatures on received transactions

Any node NOT supporting signatures would reject these blocks.
HARD FORK!
      `,

      codeModification: {
        location: 'lib/blockValidator.js - enableHardFork()',
        change: 'requireSignatures: true',
        consequence: 'All transactions MUST have digital signature or block REJECTED'
      },

      expectedOutcome: `
Old nodes (without signature support): REJECT all new blocks ❌
New nodes (with signature support): ACCEPT new blocks ✅

The network splits into:
- Old chain: No signatures, old nodes mine it
- New chain: All signed, new nodes mine it
      `,

      implementation: `
To implement (optional challenge):
1. Use Node's crypto.sign() and crypto.verify()
2. Each participant has privateKey and publicKey
3. When sending transaction:
   - Sign with your privateKey
   - Include signature in transaction
4. When validating:
   - Use publicKey to verify signature
   - Reject if signature invalid
      `,

      learningPoint: 'Why Bitcoin has specific format - incompatible changes require hard fork'
    };
  }

  // ==================== IMPROVEMENT PROPOSAL DEMOS ====================

  createTransactionFeesBIP() {
    return {
      name: 'BIP: Transaction Fees (Proposal, not yet implemented)',
      category: 'bip',
      difficulty: 'Intermediate',
      timeEstimate: '10 minutes',

      title: 'Blockchain Improvement Proposal #001: Transaction Fees',

      proposal: `
CURRENT ISSUE:
- All transactions are free
- Miners have no incentive to prioritize
- Network could be spammed with low-value transactions

PROPOSED SOLUTION:
- Each transaction includes a "fee" field
- Miners get the fees from transactions they include
- Transactions with higher fees get priority
- This creates an incentive for miners to include more transactions
      `,

      implementation: `
Phase 1 (Soft Fork):
- Add optional "fee" field to transactions
- Miners can start collecting fees

Phase 2 (Hard Fork if needed):
- Make fees mandatory
- Establish minimum fee thresholds
- Define fee adjustment algorithm
      `,

      pros: [
        'Fair prioritization - pay more to go faster',
        'Incentivizes honest mining',
        'Reduces spam attacks',
        'Block size management'
      ],

      cons: [
        'Can be unfair to poor users',
        'Fees might grow over time',
        'Complex to implement correctly'
      ],

      whyBitcoinDoesThis: 'Bitcoin transaction fees exist to prevent spam and incentivize mining (especially after block rewards diminish)',

      discussion: 'Should Blockchain Lab charge fees for transactions?'
    };
  }

  createBlockTimeBIP() {
    return {
      name: 'BIP: Target Block Time (Proposal)',
      category: 'bip',
      difficulty: 'Intermediate',

      proposal: `
CURRENT ISSUE:
- Block time is random
- If network gets faster computers, blocks come too quickly
- If slower computers join, blocks slow down

PROPOSED SOLUTION:
- Target: 1 new block every 30 seconds
- Adjust difficulty automatically:
  - Too many blocks in last hour? Increase difficulty
  - Too few blocks? Decrease difficulty
- Keeps mining time consistent regardless of hardware
      `,

      realWorldExample: 'Bitcoin targets 10 minutes per block, adjusts every 2 weeks',

      implementation: `
Algorithm:
1. Track last 144 blocks and their mining times
2. Calculate average block time
3. If average < 30s: increase difficulty by X%
4. If average > 30s: decrease difficulty by X%
5. Repeat every block

This keeps mining roughly constant!
      `,

      discussion: 'What should Blockchain Lab target? 10 seconds? 30 seconds?'
    };
  }

  // ==================== ATTACK DEMOS ====================

  create51PercentAttackDemo() {
    return {
      name: 'Attack: 51% Attack Explained',
      category: 'attack',
      attackType: 'consensus-attack',
      difficulty: 'Intermediate',
      timeEstimate: '20 minutes',

      overview: `
A 51% ATTACK happens when someone controls 51%+ of mining power.
They can:
1. Create an alternative blockchain starting from some earlier block
2. Mine faster than the rest of the network
3. Eventually have the longest chain
4. Network accepts THEIR version as the truth
5. Reverse transactions that happened on the original chain
      `,

      realWorldExample: 'Bitcoin would need $15+ billion worth of mining hardware to 51% attack',

      setup: {
        participants: 3,
        distribution: { attacker: '60% hashrate', honest1: '25%', honest2: '15%' },
        steps: [
          '1. Let honest miners build chain to block #10',
          '2. Attacker mines a competing chain from block #5',
          '3. Even though attacker started behind, with 60% power they eventually overtake',
          '4. When attacker chain is longest, network accepts it',
          '5. Blocks #6-10 on honest chain are now INVALID'
        ]
      },

      timelineVisualization: `
Honest chain:   G - B1 - B2 - B3 - B4 - B5 [stop here for fork point]
Attack chain:   G - B1 - B2 - B3 - B4 - B5 - AB6 - AB7 - AB8 - AB9 - AB10
                                          ↑
                                    Fork point: block #5

Since attacker has 60% power:
- Honest miners: 40% speed producing honest blocks
- Attacker: 60% speed producing attack blocks
- Attack blocks are added 1.5x faster than honest blocks
- Eventually attack chain is longer
- Network switches to attack chain
- Blocks 6-10 from honest chain are lost!
      `,

      protections: `
Why 51% attack is hard in practice:
1. Hardware cost: $15B+ for Bitcoin
2. Time cost: Takes hours/days to catch up
3. Detectable: Network sees unusual difficulty/chain behavior
4. Costly: Attacker gets no benefit, just breaks things
5. Fork risk: If attack fails halfway, attacker loses money
      `,

      learningPoint: `
More miners = more secure blockchain.
This is why Bitcoin uses 100,000+ computers worldwide.
Small networks (with few miners) are VULNERABLE to 51% attacks!
      `
    };
  }

  create51SuccessDemo() {
    return {
      name: '51% Attack - WILL SUCCEED',
      category: 'attack',
      attackType: '51-percent-attack',
      difficulty: 'Advanced',
      timeEstimate: '15-20 minutes',

      setup: {
        scenario: 'You WILL control 51% of hashrate - attack WILL work',
        steps: [
          '1. Start with 2-3 honest participants',
          '2. You mine with 100% CPU (61% of total), others use 50%',
          '3. Build chain to block 10',
          '4. Do something valuable on the honest chain (big transaction)',
          '5. Fork from block 5 in your competing chain',
          '6. Keep mining - you\'re 1.5x faster than honest miners',
          '7. When your chain reaches block 20, network reorganizes to YOUR chain',
          '8. The valuable transaction on blocks 11-15 is REVERSED',
          '9. You can now spend those coins again (double-spend!)',
          '10. Attack succeeds ✓'
        ]
      },

      expectedOutcome: `
Your forked chain becomes the longest chain.
The network reorganizes to YOUR version.
Blocks 6-10 from the original chain disappear.
Any transactions in those blocks are ORPHANED.
You can now send some coins twice (double-spend).
This is a successful 51% attack!
      `,

      proofOfWork: `
The key insight: Proof-of-Work means "longest chain wins"
With majority hashrate, you can produce longest chain fastest
Therefore, everyone follows YOUR chain, not the original
      `,

      consequence: `
User lost ~5 Bitcoin.
They sent coins on the original chain.
Those coins were in the orphaned blocks.
Coins reverted to their original state.
In reality, they'd likely pull off exchange and lose the coins to attacker.

Total damage: $250,000+ (in real Bitcoin)
      `,

      prevention: `
Why real Bitcoin is safe:
- 51% attack costs $15+ billion in hash power
- Even if successful, only temporary disruption
- Honest miners would immediately respond
- Market would lose confidence, coin value crashed
- Attacker's gain < cost

For a 51% attack to be profitable:
- Cost of attack < Coins you can steal

Bitcoin: $15B cost > coins you can steal
Therefore, 51% attacks are economically irrational
      `
    };
  }

  create51FailDemo() {
    return {
      name: '51% Attack - WILL FAIL',
      category: 'attack',
      attackType: '51-percent-attack',
      difficulty: 'Advanced',
      timeEstimate: '15-20 minutes',

      setup: {
        scenario: 'You NO NOT have 51% - attack WILL fail',
        steps: [
          '1. Start with 3 honest participants',
          '2. You mine with 40% CPU (27% of total)',
          '3. Others mine with 50-75% CPU (73% combined)',
          '4. All build chain together to block 20',
          '5. You try to fork from block 10',
          '6. You start mining your competing chain',
          '7. But honest miners are faster (73% > 27%)',
          '8. Honest chain reaches block 30 while you\'re at block 22',
          '9. Your chain is behind and falling further back',
          '10. After 20 minutes, you give up',
          '11. Attack fails ✗ - honest chain wins'
        ]
      },

      expectedOutcome: `
Your fork falls behind.
Honest chain keeps growing faster.
After a certain point, it's mathematically impossible to catch up.
Everyone sees the original chain as longest.
Your fork is ignored (orphaned chain).
Attack fails - you wasted computing power and got nothing.
      `,

      mathBehindIt: `
Honest chain growth rate = 73% of network speed
Your chain growth rate = 27% of network speed

If both at same height:
- For every 1 block you mine, they mine 2.7x blocks
- You fall behind approximately 1.7 blocks per minute
- After 10 minutes, you're 17 blocks behind
- Impossible to catch up without 51% power

This is the fundamental security of Proof-of-Work!
      `,

      learningPoint: `
With <51% power, 51% attacks are IMPOSSIBLE.
The honest majority will always produce longest chain fastest.
This is why Proof-of-Work is secure against majority attacks.
You need MAJORITY power to attack successfully.
      `
    };
  }

  createDoubleSpendDemo() {
    return {
      name: 'Attack: Double Spending',
      category: 'attack',
      attackType: 'double-spend-attack',
      difficulty: 'Intermediate',
      timeEstimate: '10-15 minutes',

      overview: `
In a blockchain without proper validation, you can "double spend":
- Send 10 coins to Alice (she thinks she got 10 coins)
- Send the SAME 10 coins to Bob (he thinks he got 10 coins)
- Both think they received coins, but you only had 10!

This attack requires 51% power to be successful permanently,
but can be temporary with minority power if nodes have weak validation.
      `,

      setup: {
        steps: [
          '1. Start with 100 coins',
          '2. Send 50 coins to Alice - block 11 (on honest chain)',
          '3. Alice confirms receipt after 3 blocks',
          '4. Now create fork from block 10',
          '5. Mine alternate chain where you send 50 coins to Bob',
          '6. Your chain catches up and becomes longest',
          '7. Alice\'s transaction is orphaned',
          '8. You still have your original 100 coins back',
          '9. You sent coins twice and have them back - double spent!'
        ]
      },

      vulnerability: `
In Blockchain Lab, double-spending is prevented by:
1. Ledger: Each transaction reduces balance
2. Chain history: Can't change past transactions
3. Consensus: Longest chain is the truth

To double-spend successfully, you need 51% power to:
1. Reverse your own transaction on original chain
2. Make competing chain longest
3. Network accepts your version (where coins didn't go to Alice)
4. You and Bob both think you have the coins
      `,

      defense: `
Once a transaction is deep in chain (6+ blocks):
- Attacker needs MORE than 51% to reverse
- Even 50% power can't override established history
- The older the transaction, the safer it is

Bitcoin rule: Wait 6 confirmations before trusting a transaction
This makes double-spend effectively impossible even with 50% power
      `
    };
  }

  createSelfishMiningDemo() {
    return {
      name: 'Attack: Selfish Mining',
      category: 'attack',
      attackType: 'selfish-mining-attack',
      difficulty: 'Advanced',
      timeEstimate: '20 minutes',

      overview: `
SELFISH MINING is more subtle than 51% attack:
- You don't need 51% power
- You mine blocks privately without broadcasting
- When honest miners are about to catch up, you release yours
- You gain advantage in block reward race

This works with just 33% power in some scenarios!
      `,

      setup: {
        scenario: 'You have 35% hashrate, others have 65%',
        steps: [
          '1. You privately mine block 11',
          '2. Honest network publishes their block 11 (different)',
          '3. They don\'t know about your block 11 - it\'s a tie',
          '4. While they extend THEIR chain, you keep mining privately',
          '5. You mine private blocks 12, 13...',
          '6. Honest chain: blocks 11H, 12H, now 13H...',
          '7. Your chain: blocks 11S, 12S, 13S, 14S (private)',
          '8. When you\'re significantly ahead, release your chain',
          '9. Your chain has more total blocks - network reorg to yours',
          '10. You get credit for blocks 11, 12, 13, 14 (they get nothing)',
          '11. Over time, you get disproportionate share of rewards'
        ]
      },

      whyItWorks: `
The attacker has an advantage:
- Private chain: Known to only attacker
- Public chain: Known to all, but has more participants
- Attacker extends private chain before broadcast
- When released, if longer by even 1 block, network accepts it

This wastes computational power of honest miners!
They compute blocks that don't count.
Attacker gets extra advantage without 51% power.
      `,

      counterplay: `
Bitcoin defenses against selfish mining:
1. Frequent block broadcasting (harder to hide)
2. First-seen-wins rule (first block valid even if tie)
3. SPV (fast block validation - less latency advantage)
4. GHOST protocol (rewards all blocks, not just longest chain)
      `,

      difficulty: 'This is a sophisticated attack used by mining pools in practice'
    };
  }

  createEclipseAttackDemo() {
    return {
      name: 'Attack: Eclipse Attack (P2P Network)',
      category: 'attack',
      attackType: 'eclipse-attack',
      difficulty: 'Advanced',
      timeEstimate: '15-20 minutes',

      overview: `
An ECLIPSE ATTACK targets the P2P network layer, not the blockchain itself:
- Attacker creates fake network peers
- Isolates a real peer by surrounding it with fake peers
- That isolated peer only receives fake blockchain data
- They see a fake chain while real network continues elsewhere

This is attacking the NETWORK, not the chain consensus!
      `,

      setup: {
        target: 'New participants or light clients',
        attack: 'Surround them with fake peers',
        result: 'They believe fake blockchain is real'
      },

      howItWorks: `
This attack is hard to fully simulate in Blockchain Lab,
but the concept is important:

Real P2P attack flow:
1. Victim joins network
2. First 5 peers attacker controls
3. Victim thinks these are real peers
4. Victim receives blocks from these peers
5. Attacker feeds victim fake blocks
6. Victim builds fake chain
7. Victim sends coins thinking transaction is safe
8. Actually sent to attacker on fake network
9. Coins never truly transferred on real blockchain

Protection: Get blockchain data from multiple independent sources
      `,

      prevention: `
Bitcoin defenses:
1. Fetch blocks from multiple sources
2. Verify blocks against multiple peers
3. Assume peers might be adversarial
4. Use random connection addresses
5. DNSSeed from trusted sources (not single server)
      `,

      learningPoint: `
Blockchain is only as secure as its network!
Consensus algorithm (PoW) is secure,
but if your node is isolated, you might miss the real blockchain.

Therefore: Decentralization of network is critical!
      `
    };
  }

  /**
   * GET DEMO BY NAME
   */
  getDemo(demoName) {
    return this.demos[demoName] || null;
  }

  /**
   * LIST ALL AVAILABLE DEMOS
   */
  listAllDemos() {
    return Object.keys(this.demos).map(key => ({
      id: key,
      name: this.demos[key].name,
      category: this.demos[key].category || 'uncategorized',
      difficulty: this.demos[key].difficulty || 'Normal'
    }));
  }

  /**
   * FILTER DEMOS
   */
  filterDemos(category) {
    return Object.keys(this.demos)
      .filter(key => this.demos[key].category === category)
      .map(key => ({
        id: key,
        name: this.demos[key].name
      }));
  }
}

module.exports = GuidedDemoSystem;
