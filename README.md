----
# The Blockchain Lab - Educational Blockchain Network

## Overview

**The Blockchain Lab** is an interactive educational platform that demonstrates how blockchain networks function at scale. It allows educators to create isolated classroom blockchain networks where students can participate as observers or miners, learning real-world blockchain concepts.

## Features

### For Instructors
- **Create isolated blockchain networks** - Each class gets its own session accessible via a join code
- **Adjust difficulty in real-time** - Set leading zeros and secondary difficulty parameters
- **Control mining rewards** - Adjust coin rewards for mined blocks
- **Lock/unlock parameters** - Choose whether students see a "hardcoded" blockchain or observe runtime changes
- **Monitor network activity** - View all participants, blocks mined, and network statistics
- **Simulate attacks** - Automatically split the class into teams to race a 51% Collusion Attack

### For Students (Observers)
- **Join with a code** - Simple code-based entry (like Kahoot)
- **Real-time network tree** - Watch side-by-side forks and branches as they happen
- **View network statistics** - Network hashrate, block height, participant count, average block time
- **See transaction pool** - Observe pending transactions waiting to be mined
- **Monitor admin controls** - See what parameters the instructor is using
- **Mobile-friendly** - View the network on any device (desktop, tablet, phone)

### For Students (Participants)
- **Mine blocks** - Participate in actual Proof-of-Work mining
- **Send transactions** - Create transactions to other students
- **CPU throttling** - Limit CPU usage to prevent system strain (10-100%)
- **Real-time mining stats** - See your hashrate, blocks mined, and balance
- **Continuous Optimistic Mining** - Zero-pause mining engine mimicking real-world nodes
- **Blockchain verification** - Watch your node verify and add blocks to the chain
- **Learn PoW mechanics** - Understand how miners secure a blockchain network

### Network Features
- **Real Proof-of-Work** - Actual SHA256 hashing with configurable difficulty
- **Consensus mechanism** - First miner to find valid nonce wins the block
- **Transaction pool** - Pending transactions included in mined blocks
- **51% attack simulation** - Attack becomes possible when one participant has >50% network hashrate
- **Distributed network** - Each participant's computer contributes computing power
- **Real-time updates** - WebSocket-based updates for all connected clients

## Getting Started

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/blockchain-demo-lab.git
   cd blockchain-demo-lab
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the server**
   ```bash
   npm start
   ```

The server will start on `http://localhost:3000`

### Local Usage

1. **Access the lab**: Open ```bash
   http://localhost:3000/lab
   ```

2. **Create a session (Instructor)**
   - Click "Create Session"
   - Your admin token will be displayed (save it!)
   - You'll be redirected to the admin dashboard
   - Share the join code with students

3. **Join a session (Student)**
   - Enter the join code
   - Select "Observer" or "Participant"
   - Click "Join"

## Architecture

### Backend
- **Express.js** - HTTP server and routing
- **Socket.io** - Real-time bidirectional communication
- **Node.js Crypto** - SHA256 hashing for mining
- **In-memory storage** - Session and blockchain state

### Frontend
- **Bootstrap 3** - Responsive UI framework
- **jQuery** - DOM manipulation
- **CryptoJS** - Client-side hashing (via sha256.js)
- **Socket.io client** - Real-time updates

### Key Components
- `lib/blockchainLab.js` - Core blockchain logic
- `lib/miningUtils.js` - Mining and validation utilities
- `lib/socketHandlers.js` - Real-time event handlers
- `routes/lab.js` - HTTP endpoints for lab operations
- `views/lab/` - Pug template views for UI

## How It Works

### Creating a Blockchain Session
1. Instructor creates a session
2. System generates a 6-character join code
3. Students join with the code
4. Admin can adjust difficulty and mining rewards

### Mining Process
1. Participant clicks "Start Mining"
2. System creates a candidate block with:
   - Previous block hash
   - Pending transactions
   - Current timestamp
   - Nonce (starts at 0)
3. Participant's computer repeatedly:
   - Calculates SHA256 hash of block
   - Increments nonce
   - Continues until hash meets difficulty requirement
4. When valid hash found:
   - Block is submitted to network
   - All participants receive notification
   - Block is added to blockchain
   - Participant receives mining reward

### Difficulty Settings
**Difficulty = Number of leading zeros in hash**

- Difficulty 3 = Hash must start with "000"
- Difficulty 4 = Hash must start with "0000"
- Secondary difficulty (0-15) = Additional hex digit constraint

Example: Difficulty 3 with secondary 0xF = "000F..." (more granular control)

### 51% Attack Simulation
When one participant controls >50% of network hashrate:
- Admin can initiate attack simulation
- Attacker can fork the blockchain from any block
- Network shows attack warning
- Demonstrates blockchain vulnerability

## Configuration

### Difficulty Levels

| Difficulty | Approx. Hashrate | Time to Mine |
|------------|-----------------|--------------|
| 2          | 500 H/s         | < 1 second   |
| 3          | 100 H/s         | 10 seconds   |
| 4          | 20 H/s          | 50 seconds   |
| 5          | 4 H/s           | 4 minutes    |

These are approximate and depend on device hardware.

### CPU Usage Limiting
Participants can limit CPU usage to prevent system strain:
- 100% = No delay (maximum speed)
- 50% = Recommended for background mining
- 10-20% = Minimal impact to other tasks

## Educational Value

### Concepts Demonstrated
1. **Proof-of-Work** - Students mine blocks by solving computational puzzles
2. **Difficulty adjustment** - See how harder puzzles take longer to solve
3. **Consensus** - First miner to solve block wins; others verify
4. **Transaction processing** - Transactions are pooled and included in blocks
5. **Chainverification** - Each block must reference previous block hash
6. **51% attack** - With >50% hashrate, attacker can control network
7. **Incentive mechanisms** - Miners reward for securing network
8. **Distributed systems** - Network works with participants coming and going

### Learning Outcomes
Students will understand:
- How cryptographic hashing works
- Why Proof-of-Work is important for security
- How difficulty is adjusted
- Economics of mining (reward vs. computation cost)
- Vulnerability of blockchains to 51% attacks
- Why decentralization matters

##Deployment

### Deploying to Cloud (Recommended)

The application is stateless and perfectly suited for cloud deployment.

#### Option 1: Railway (Easiest)
1. Create an account at railway.app
2. Connect your GitHub repository
3. Railway automatically detects Node.js and deploys
4. You get a public URL instantly

#### Option 2: Render
1. Create account at render.com
2. Create new Web Service
3. Connect GitHub repository
4. Set `npm start` as start command
5. Deploy

#### Option 3: Heroku
```bash
# Install Heroku CLI
# Then:
heroku login
heroku create blockchain-lab
git push heroku main
heroku open
```

#### Option 4: DigitalOcean App Platform
1. Connect GitHub repository
2. Set Node environment
3. Deploy when you push to main

### Environment Variables
```
PORT=3000 (default)
NODE_ENV=production
```

### Performance Notes
- Server is stateless (can be scaled horizontally)
- In-memory storage means sessions reset on restart
- For persistence, add a database (MongoDB, PostgreSQL)
- Current implementation supports 100+ concurrent connections per instance

## Testing the Lab

### Test Scenario 1: Simple Network
1. Create session
2. Join 2 students as participants
3. Start mining on both
4. First to mine block wins (should see similar mining times)
5. Increase difficulty - mining should take longer

### Test Scenario 2: Transactions
1. Create session with 3 participants
2. Participant A mines early blocks (builds balance)
3. Participant A sends 5 coins to Participant B
4. Transaction appears in pending pool
5. Next block includes the transaction
6. Participant B's balance increases

### Test Scenario 3: 51% Attack
1. Create session with 3 participants
2. Participant A uses high CPU (100%), others use low (20%)
3. Participant A quickly accumulates >50% hashrate
4. Admin initiates attack from early block
5. Network forks - shows two chain versions

## Troubleshooting

### Students can't see real-time updates
- Ensure Socket.io is not blocked by firewall
- Check that WebSocket connections are allowed
- Some corporate networks block WebSockets

### Mining very slow
- Decrease difficulty setting
- Some devices (especially mobile) will be slower
- Chrome/Firefox generally faster than Safari

### Students see old blockchain state
- Refresh the page (Ctrl+R)
- Clear browser cache
- Reconnect as observer/participant

## Development & Contribution

### Adding Features
The modular architecture makes it easy to add features:

**New blockchain feature?** Modify `lib/blockchainLab.js`
**New mining parameter?** Update `lib/miningUtils.js`
**New student facing feature?** Add route in `routes/lab.js` and view in `views/lab/`

### Code Structure
```
blockchain-demo/
├── lib/
│   ├── blockchainLab.js    # Core blockchain logic
│   ├── miningUtils.js       # Mining algorithms
│   └── socketHandlers.js    # Real-time events
├── public/
│   └── javascripts/lab/      # Client-side code
├── routes/
│   └── lab.js               # Lab HTTP routes
├── views/lab/                # UI templates
│   ├── index.pug            # Landing page
│   ├── admin.pug            # Admin dashboard
│   ├── observe.pug          # Observer view
│   └── participate.pug      # Participant mining view
└── app.js                   # Express app setup
```

## Future Enhancements

### Planned Features
- [ ] Database persistence (sessions survive server restart)
- [ ] User authentication and class management
- [ ] Adjustable block time targets
- [ ] Smart contract simulation
- [ ] More sophisticated attack types
- [ ] Leaderboards and scoring
- [ ] Export blockchain as JSON
- [ ] Replay blockchain with time controls
- [ ] Mobile-optimized participant mining UI
- [ ] Network topology visualization
- [ ] Transaction fee system
- [ ] Merkle tree visualization
- [ ] UTXO model exploration

### Known Limitations
- No persistence - sessions lost on server restart
- In-memory storage limits scale  - Single instance only (no load balancing)
- Very high difficulty may timeout on slow devices
- No transaction validation logic - simplified model

## Credits

**Original Blockchain Demo** by Anders Brownworth  
- Source: andersbrownworth.com/blockchain
- GitHub: anders94/blockchain-demo
- License: MIT

**Blockchain Lab** enhancements and additions
- Classroom network functionality
- Mining simulation for multiple participants
- Admin controls and monitoring
- Educational features and documentation

## License

MIT License - See LICENSE file for details

## Support & Questions

For issues, questions, or suggestions:
- Open an issue on GitHub
- Check existing documentation
- Try the troubleshooting section

## Attribution

When using this in your class, please credit:
- Anders Brownworth for the original blockchain demo
- The open-source community for Socket.io, Express, and related libraries

---

**Ready to start teaching blockchain?**

1. Deploy to cloud (Railway, Render, etc.)
2. Get the public URL
3. Create a session and generate join code
4. Share code with your class!

Have fun exploring blockchain technology with your students!
