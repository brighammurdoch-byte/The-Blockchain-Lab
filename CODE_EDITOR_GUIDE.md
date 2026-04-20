# Blockchain Lab - Code & Demos Guide

## Overview

Your Blockchain Lab now includes two powerful educational features:

1. **Validator Code Editor** - View and modify the actual validation code running on each participant's computer
2. **Guided Demos** - Step-by-step tutorials for understanding attacks, forks, and consensus mechanisms

## Feature 1: Validator Code Editor

### What Can You Do?

The `blockValidator.js` file contains the actual code that:
- Validates blocks (checks Proof-of-Work)
- Prevents double-spending
- Maintains chain integrity
- Can be modified to create forks and simulate attacks

### How to Access

1. Join as a **Participant** in the lab
2. Click the **"Your Validator Code"** tab
3. Click **"Open Code Editor in New Tab"**

### Key Functions to Modify

#### 1. `validateBlockHash()` - Proof-of-Work Difficulty
**Located in:** code-editor.pug accordion

**Default Code:**
```javascript
// Requires exactly 3 leading zeros
const requiredLeadingZeros = 3;
```

**Experiments:**
- Change to `4` → HARD FORK - blocks are harder to mine, network incompatible
- Change to `2` → Soft fork - blocks easier to mine, network stays compatible

**What You'll Learn:**
- Why mining difficulty matters
- How Bitcoin adjusts difficulty
- Why Ethereum reduced block time

---

#### 2. `validateTransaction()` - Double-Spend Prevention
**Located in:** blockValidator.js lines 45-67

**Current Behavior:**
Checks that sender has enough coins before allowing transaction

**Experiment Ideas:**
- Remove the balance check
- Result: Users can send infinite coins ✗ BROKEN
- This is why every blockchain needs this check

**Real-World Parallel:**
Bitcoin had to prevent double-spending from day one, or the whole system fails

---

#### 3. `validatePreviousHash()` - Chain Integrity
**Located in:** blockValidator.js lines 69-85

**What It Does:**
Ensures each block links to the previous block's exact hash

**Experiment:**
- Remove this check
- Result: Chain fragments into separate pieces ✗ BROKEN

**Why It Matters:**
This is literally the "chain" in "blockchain" - without it, history isn't chained together

---

#### 4. `enableSoftFork()` - Backward Compatible Changes
**Located in:** blockValidator.js lines 258-280

**Example:**
```javascript
// Add support for optional "memo" field in transactions
if (tx.memo && tx.memo.length > 100) {
  return { valid: false, reason: 'Memo too long' };
}
```

**Why This Works:**
- Old nodes: ignore the memo field
- New nodes: validate the memo
- **Result:** Network stays unified ✓ SOFT FORK SUCCESS

**Real-World:** Bitcoin SegWit, Taproot updates

---

#### 5. `enableHardFork()` - Network-Breaking Changes
**Located in:** blockValidator.js lines 282-300

**Example:**
```javascript
// Change required leading zeros from 3 to 4
const requiredLeadingZeros = 4;
```

**What Happens:**
- Old nodes: REJECT blocks with 4 zeros
- New nodes: ONLY accept blocks with 4 zeros
- **Result:** Network splits into two separate blockchains ✗ HARD FORK

**Real-World:** Bitcoin → Bitcoin Cash (2017), Ethereum → ETC (2016)

---

## Feature 2: Guided Demos

### Available Demos

#### SOFT FORKS (Can modify code without breaking network)

1. **Soft Fork: Extended Transaction Format**
   - Add optional "memo" field to transactions
   - Old nodes accept new blocks without understanding memo
   - Network stays unified
   - **Time:** 10-15 minutes

2. **Soft Fork: Larger Block Size**
   - Increase block size limit
   - Keep blocks under old limit so old nodes accept them
   - Learn why backward compatibility matters
   - **Time:** 5-10 minutes

---

#### HARD FORKS (Permanently split the network)

3. **Hard Fork: Increase Difficulty (Recommended first demo!)**
   - Change required leading zeros from 3 to 4
   - Watch your blockchain split into two separate chains
   - One group mines 3-zero blocks, one mines 4-zero blocks
   - **Time:** 10 minutes
   - **Setup:** Have students split into Group A (keep original) and Group B (activate hard fork)

4. **Hard Fork: Require Digital Signatures**
   - Introduce cryptographic signatures required for transactions
   - Old nodes reject all new blocks (can't validate signatures)
   - Network incompatibility ✗
   - **Time:** 15 minutes

---

#### BLOCKCHAIN IMPROVEMENT PROPOSALS (Not Yet Implemented)

5. **BIP: Transaction Fees**
   - Problem: Network allows spam (free transactions)
   - Solution: Add voluntary fees
   - Miners prioritize high-fee transactions
   - Discussion: Should students pay coins to transact?

6. **BIP: Block Time Targeting**
   - Problem: Mining time is irregular
   - Solution: Adjust difficulty to target 30-second blocks
   - Real-world:Bitcoin targets 10 minutes, adjusts every 2 weeks
   - Discussion: What's optimal block time?

---

#### ATTACKS (See why attacks work or fail)

7. **51% Attack (Team Collusion) - WILL SUCCEED** ⭐ Interactive!
   - The admin initiates a "Team Collusion" split.
   - ~50% of the class is assigned to the Collusion Team and automatically mines a secret fork.
   - Watch the side-by-side network tree as the chains race.
   - When the Collusion chain outpaces the Honest chain, the network reorganizes to YOUR version!
   - Coins sent on original chain are now invalid.
   - **Setup:** Instructor clicks "Initiate Team Collusion" on the Admin Dashboard.
   - **Time:** 15-20 minutes

8. **Contentious Hard Fork Simulation** ⭐ Interactive!
   - A visual demonstration of Bitcoin vs. Bitcoin Cash.
   - Admin proposes a network Hard Fork at a specific block height.
   - Miners get an interactive prompt to "Accept" or "Reject" the new rules.
   - Miners who vote differently will physically reject each other's blocks, permanently splitting the network!
   - **Setup:** Instructor clicks "Propose Hard Fork" on the Admin Dashboard.
   - **Time:** 10 minutes

9. **51% Attack - WILL FAIL** ⚠️ Educational!
   - You have 27% hashrate, others have 73%
   - Try to fork from an earlier block
   - Your chain grows slower: 73% > 27%
   - After 10 minutes, you're 17 blocks behind (impossible to catch up)
   - Attack fails because you don't have majority power
   - **Key Lesson:** Proof-of-Work is secure against minority attacks
   - **Time:** 15-20 minutes

10. **Double-Spend Attack** ⭐ Automated!
   - Click the "Simulate Double Spend" button in the Code Editor.
   - The script automatically broadcasts a normal transaction to the network...
   - ...AND instantly creates a secret fork with a conflicting transaction!
   - If your secret fork wins the race, your double-spend succeeds.
   - **Setup:** Go to the "Your Validator Code" tab and click "Simulate Double Spend".
   - **Time:** 15 minutes

10. **Selfish Mining Attack**
    - Mine blocks privately without broadcasting
    - When honest miners about to catch up, release your blocks
    - You get disproportionate rewards
    - Works with 33-40% power in ideal conditions
    - **Advanced topic**

11. **Eclipse Attack**
    - Not easy to simulate in Blockchain Lab
    - Concept: Isolate a node with fake peers
    - Node sees fake blockchain
    - Practical protection: Use multiple sources
    - **Educational context only**

---

## How to Run a Demo

### Step 1: Choose Your Demo
- Open the **"Guided Demos"** tab in your Participant view
- Read through the description
- Click **"View Details"** to see code modifications needed

### Step 2: Understand the Setup
Each demo shows:
- **What code to modify** (with exact file location)
- **Before/After code** (what changes)
- **Expected outcome** (what will happen)
- **Why it matters** (blockchain concept explained)

### Step 3: Implement in Code Editor
- Open the **"Your Validator Code"** tab
- Open the full code editor
- Find the function mentioned in the demo
- Make the change specified
- Click **"Submit Modified Code"** when done

### Step 4: Observe the Network
Watch the effect of your change:
- **Soft Fork:** Network continues, some blocks have new format
- **Hard Fork:** Your chain splits - you're on one fork, others on another
- **Attack:** Your hashrate can override other chains
- **Failed Attack:** Your chain can't catch up

### Step 5: Reset and Try Again
- Click **"Reset to Original"** to restore original code
- Try a different modification
- Experiment until you understand the concept

---

## Example Walkthrough: Hard Fork Difficulty Demo

### The Setup
"Increase required leading zeros from 3 to 4"

### Steps to Complete

1. **Read the Demo**
   - Opens in guided demos browser
   - Explains: "New blocks must have 4 leading zeros instead of 3"
   - Shows expected outcome: "Network splits into two chains"

2. **Open Code Editor**
   - Click "Your Validator Code" → "Open Code Editor"
   - Ace editor loads with blockValidator.js
   - Ctrl+F to find "requiredLeadingZeros"

3. **Make the Change**
   ```javascript
   // BEFORE:
   const requiredLeadingZeros = 3;
   
   // AFTER:
   const requiredLeadingZeros = 4;
   ```

4. **Submit**
   - Click "Submit Modified Code"
   - Your validator is now MODIFIED
   - Network status shows: "⚠ Your validator is now MODIFIED"

5. **Observe**
   - Your mining becomes MUCH harder (4 zeros vs 3)
   - Admin sees: "Participant X modified validator"
   - Mining status changes:
     - You mining: Very slow (few blocks)
     - Others mining: Normal speed (many blocks)
   - Eventually you notice: TWO separate chains!
   - Both groups building their own blockchains independently

6. **The Learning** 💡
   - Your 4-zero chain: Blocks: G→B1→B2→...
   - Others' 3-zero chain: Blocks: G→B1→B2→B3→B4→...
   - Both think the other is wrong
   - This is exactly what happened when Bitcoin → Bitcoin Cash split
   - Miners had to choose a side; can't be on both chains

---

## Real-World Blockchain Examples

### Bitcoin Hard Forks
- **2017 Bitcoin vs Bitcoin Cash**
  - Core developers wanted SegWit
  - Cash developers wanted bigger blocks
  - Could not agree → HARD FORK
  - Two separate cryptocurrencies exist today

- **2016 Ethereum vs Ethereum Classic**
  - DAO hack required fund recovery
  - Some wanted to "unhack" the blockchain
  - Others said "code is law, can't change it"
  - HARD FORK → Two Ethereum cryptocurrencies

### Bitcoin Soft Forks
- **SegWit (2017):** New transaction format, backward compatible
- **Taproot (2021):** New signature type, old nodes still validate

### 51% Attacks in Reality
- **Ethereum Classic:** 51% attacked multiple times in 2020
  - Small network = easy to get 51% power
  - Cost ~$100k to attack

- **Bitcoin:** Never successfully 51% attacked
  - Would cost $15+ billion
  - Network too large and secure

---

## Prevention & Security

### Soft Fork Safety
- Participants with original code still validate new blocks
- No forced upgrade required
- Rollout can be gradual

### Hard Fork Safety
- Requires community consensus before implementation
- All nodes must upgrade simultaneously
- No consensus = network splits (sometimes intentional)

### 51% Attack Prevention
- More miners = more secure
  - Bitcoin: 100,000+ mining operations worldwide
  - Small coins: Only 10-100 miners = vulnerable

- Economic incentive against attacks
  - Cost of 51% hardware > coins you can steal
  - Attempting attack crashes coin value anyway

### Double-Spend Prevention
- Deep chain confirmation (6+ blocks)
- Exponentially harder to undo as blocks build
- 51% attacker can ONLY undo to past blocks, not future

---

## Teaching Tips

### Lesson 1: Why Consensus is Hard (20 min)
1. Everyone builds blockchain normally (5 min mining)
2. Ask: "What if we want to change a rule?"
3. Have half the class hard fork
4. See network naturally split
5. Discuss: How does Bitcoin avoid this?

### Lesson 2: Why Mining Difficulty Matters (15 min)
1. Check current difficulty in admin panel
2. Have one student lower it to 2 zeros
3. Blocks suddenly mine much faster
4. Ask: Why would this be bad?
5. Explain: Difficulty controls block time

### Lesson 3: Can I Hack the Blockchain? (25 min)
1. Instructor clicks "Initiate Team Collusion" to split the network into teams
2. Watch the Collusion team mine their secret fork to overtake the main chain
3. Show how the 🔄 Chain Reorg reverses transactions
4. Discuss: Why Bitcoin is safe from this
5. Why big networks and decentralization are important

### Lesson 4: What's a Fork? (20 min)
1. Soft fork: Change that's backward compatible
2. Hard fork: Breaking incompatible change
3. Have class make soft fork (add optional field)
4. Then make hard fork (change required leading zeros)
5. See the difference in network stability

---

## Troubleshooting

### "My code won't validate"
- Check JavaScript syntax
- Make sure brackets are matched
- Look for typos in function names

### "Nothing happened after I submitted code"
- Check browser console (F12) for JavaScript errors
- Your code modifications might not affect current game state
- Try mining a few new blocks to see effects

### "My chain is different from everyone else's"
- This might be the fork you intended!
- Check your code - did you make a HARD FORK change?
- If so, this is expected behavior

### "Can't find the code I need to change"
- Use Ctrl+F in code editor to search
- Look for the function name from the demo description
- Block functions are usually around line 45-300

---

## Next Steps

1. **Start with Soft Fork demo** - Safe experiments
2. **Progress to Hard Fork** - See network effects
3. **Try 51% Attack (Success)** - Understand why Bitcoin secures networks
4. **Try 51% Attack (Fail)** - Learn why minority attacks don't work
5. **Design your own** - What rule change would improve the chain?

---

## Files Modified

- `lib/blockValidator.js` - Core validation rules you'll modify
- `lib/guidedDemos.js` - All demo content and instructions
- `routes/lab.js` - API endpoints for demos and code
- `views/lab/code-editor.pug` - Full code editor interface
- `views/lab/demos.pug` - Guided demos browser
- `views/lab/participate.pug` - Added tabs to access new features

---

## API Reference (For Instructors)

### Get Validator Code
```
GET /lab/validator-code
Returns: { success, code, filename, keyFunctions }
```

### Submit Modified Code
```
POST /lab/validator-code
Body: { sessionId, userId, modifiedCode }
Returns: { success, status }
```

### List All Demos
```
GET /lab/demos
Returns: { success, demos[], categories[] }
```

### Get Specific Demo
```
GET /lab/demos/:demoName
Example: /lab/demos/hard-fork-difficulty
Returns: { success, demo }
```

---

**Happy experimenting! Remember: Understanding blockchain through hands-on attack and fork scenarios is the best way to learn.**
