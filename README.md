# Blockchain Demo
A web-based demonstration of blockchain concepts.

[![Blockchain 101 - Demo](https://img.youtube.com/vi/_160oMzblY8/0.jpg)](https://www.youtube.com/watch?v=_160oMzblY8)

This is a very basic visual introduction to the concepts behind a blockchain. We introduce 
the idea of an immutable ledger using an interactive web demo that is available here:

http://andersbrownworth.com/blockchain/

## 🔥 NEW: Blockchain Lab - Classroom Network Edition

**Blockchain Lab** transforms this demo into a full educational platform where students can participate in a real classroom blockchain network!

### Features:
- **Instructors** create isolated blockchain networks and control difficulty in real-time
- **Students** join via code (like Kahoot!) and choose to observe or participate
- **Observers** watch the network in real-time on any device (mobile-friendly)
- **Participants** actually mine blocks using their computer's CPU (with resource limits)
- **Real Proof-of-Work** - genuine SHA256 hashing and consensus mechanism
- **51% Attack Simulation** - demonstrates blockchain vulnerability
- **Transactions** - students can send coins to each other

Perfect for teaching at scale - your whole class works together on one blockchain!

### Quick Start - Blockchain Lab
```bash
npm install
npm start
# Then visit http://localhost:3000/lab
```

See [BLOCKCHAIN_LAB_README.md](BLOCKCHAIN_LAB_README.md) for complete documentation, deployment instructions, and educational materials.

### Advanced Features - Code Transparency & Guided Demos ✨

**NEW:** Students can now view and modify the actual validation code running on their computer!

#### 🔬 Validator Code Editor
- View the complete `blockValidator.js` that validates all blocks
- Modify validation rules to create forks, demonstrate attacks, etc.
- Experiment with:
  - **Soft Forks** - Backward-compatible upgrades
  - **Hard Forks** - Breaking changes that split the network
  - **Double-Spend attacks** - See consensus failures
  - **51% attacks** - Override the blockchain with majority hashrate

#### 📚 Guided Demos
11 complete educational scenarios including:
- **Soft Fork:** Extended transaction format, larger block size
- **Hard Fork:** Increase difficulty, require signatures
- **BIPs:** Transaction fees, block timing proposals
- **Attacks:** 51% success/failure, double-spend, selfish mining, eclipse attacks
- **Real-World Examples:** Bitcoin Cash fork, Ethereum Classic, SegWit

See [CODE_EDITOR_GUIDE.md](CODE_EDITOR_GUIDE.md) for detailed instructions on running demos and teaching lessons with code modification activities.

---

## Setup (Classic Demo)
Get the code:

```
git clone https://github.com/anders94/blockchain-demo.git
```

Install dependencies:

```
cd blockchain-demo
npm install
```
Run the server:

```
npm start
```

OR

```
./bin/www
```
#For windows: if the above command didn't work, use this (make sure you have Node.js installed in your system):
```
node ./bin/www      
```

Point a web browser at the demo:

```
http://localhost:3000
```

## Setup using Docker

Get the code:

```
git clone https://github.com/anders94/blockchain-demo.git
```

Run the Docker setup:

```
cd blockchain-demo
docker-compose up -d
```

Point a web browser at the demo:

```
http://localhost:3000
```

## Optional Configuration
You can adjust the "number of zeros" required by the demo by editing the first two lines of
`public/javascripts/blockchain.js`.

Because there are 16 possible characters in a hex value, each time you increment the difficulty
by one you make the puzzle 16 times harder. In my testing, a difficulty of 6 requires a
maximumNonce well over 500,000,000.

If you adjust the difficulty above 4, blocks will show up as not mined because the demo data
assumes 4 zeros for a signed block. For example, on the `http://localhost:3000/block` page
with a difficulty of 6, the first nonce that works is `8719932` yielding a hash of
`000000669445c22167511857d8f3b822b331c3342f25dfdcb326e35c1a7aa267`. This gets out of hand fairly
quickly though. Here's some time estimates at the various thresholds.

|digits|nonce|time estimate|
|------|-------|-------------|
|4|500,000|15 minutes
|5|8,000,000|4 hours
|6|128,000,000|3 days
|7|2,048,000,000|a month
|8|32,768,000,000|2 years
|9|524,288,000,000|30 years
|10|8,388,608,000,000|481 years
|11|134,217,728,000,000|7,690 years
|12|2,147,483,648,000,000|123,036 years
|13|34,359,738,368,000,000|1,968,581 years
|14|549,755,813,888,000,000|31,497,291 years
|15|8,796,093,022,208,000,000|503,956,662 years

In the production bitcoin blockchain, block `458,091` has the hash digest
`00000000000000000000011246f099d94f91628d71c9d75ad2f9a06e2beb7e92`. That's 21 zeros in a row!
That one block would take this software approximately 8,454,989,768,407,765 years to mine.

### Public Private Key Demo

The 2nd part of the 101 session:
* https://github.com/anders94/public-private-key-demo

## Credits

The original Blockchain Demo framework was created by **Anders Brownworth**.
- Original Web Demo: [andersbrownworth.com/blockchain](http://andersbrownworth.com/blockchain/)
- Original GitHub: [anders94/blockchain-demo](https://github.com/anders94/blockchain-demo)
- License: MIT

## Send Thanks

![](public/images/qr.png)

Bitcoin gratefully accepted: `1K3NvcuZzVTueHW1qhkG2Cm3viRkh2EXJp`
