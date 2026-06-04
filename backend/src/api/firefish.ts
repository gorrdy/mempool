import bitcoinApi from './bitcoin/bitcoin-api-factory';
import logger from '../logger';

// Only transactions touching one of these addresses (as input or output) are shown:
// in the projected mempool blocks (see index.ts) and in already-mined blocks (see
// bitcoin.routes.ts). An empty list disables Firefish filtering entirely.
export const FIREFISH_ADDRESSES: string[] = [
  'bc1qszttxl5jq5eyydpwvq7a6fa54at7cffp9acpyl',           // fee bump
  'bc1qy020q6fn5tyv28gh22mnhl7s5eqd7jew5jmp4v',           // escrow fee bump
  'bc1qa2zns3cjnw4jqsu2ylqp3szt3puvvjmfggdp46hv9qx5t4qjyxyq603s6z', // liquidator
];

let txidCache: { txids: Set<string>; time: number } | null = null;
const TXID_CACHE_TTL_MS = 60_000;

// Set of all txids (confirmed + mempool) touching the Firefish addresses, queried from the
// Electrum/Fulcrum address index and cached briefly. Used to filter the transactions shown
// for already-mined blocks (intersect a block's txids with this set).
export async function $getFirefishTxids(): Promise<Set<string>> {
  if (!FIREFISH_ADDRESSES.length) {
    return new Set();
  }
  const now = Date.now();
  if (txidCache && (now - txidCache.time) < TXID_CACHE_TTL_MS) {
    return txidCache.txids;
  }
  try {
    const fn = (bitcoinApi as any).$getTxidsForAddresses;
    if (typeof fn === 'function') {
      const txids = new Set<string>(await fn.call(bitcoinApi, FIREFISH_ADDRESSES));
      txidCache = { txids, time: now };
      return txids;
    }
  } catch (e) {
    logger.warn('[firefish] $getFirefishTxids failed: ' + (e instanceof Error ? e.message : e));
  }
  // fall back to the last known set rather than hiding everything on a transient failure
  return txidCache?.txids || new Set();
}
