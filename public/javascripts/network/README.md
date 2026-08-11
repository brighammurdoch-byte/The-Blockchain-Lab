# Blockchain Lab - Client-Side Networking Layer

Classroom networking for **The Blockchain Lab** without a backend session server.

## Modes

| Mode | Transport | Classroom use |
|------|-----------|---------------|
| `simulated` | BroadcastChannel only | Same-browser multi-tab prep |
| `admin-relay` | WebRTC (`p2pt`) hub + BroadcastChannel mirror | **Default** — instructor browser is the coordinator |
| `p2p` | WebRTC mesh gossip | Advanced — Full P2P teaching mode |

Landing always creates **admin-relay**. The admin dashboard **Network Mode** select switches hub vs mesh routing and broadcasts the choice to students.

## Files

- `NetworkManager.js` — mode facade
- `P2PAdminRelayTransport.js` — WebRTC via bundled `p2pt` (`hub` or `mesh` routing)
- `SimulatedAdminRelayTransport.js` — BroadcastChannel-only
- `AdminRelayCoordinator.js` — admin accepts blocks / sends initial state
- `RelayBlockchainState.js` — in-browser canonical chain (admin hub)
- `Persistence.js` — `localStorage` refresh survival

## Quick test

1. `npm start` in `blockchain-demo` (or open the GitHub Pages URL).
2. Create Session → admin dashboard.
3. **Open Test Miner Tab** (or join from another device with the code).
4. Change difficulty → Update Settings; start mining on the student tab.

## Static / GitHub Pages

```bash
npm run build:static
```

Output is `docs/` with `LAB_BASE_PATH` default `/The-Blockchain-Lab`. Override with:

```bash
LAB_BASE_PATH=/Your-Repo-Name npm run build:static
```
