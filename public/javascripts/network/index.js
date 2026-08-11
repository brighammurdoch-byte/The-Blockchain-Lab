/**
 * Networking Layer Entry Point
 *
 * This file re-exports the main classes so other parts of the app
 * can do:
 *
 *   import { NetworkManager } from './network/index.js';
 */

export { NetworkManager } from './NetworkManager.js';
export { SimulatedTransport } from './NetworkManager.js';
export { SimulatedAdminRelayTransport } from './SimulatedAdminRelayTransport.js';
export { Persistence } from './Persistence.js';

// Future:
// export { P2PTransport } from './P2PTransport.js';
