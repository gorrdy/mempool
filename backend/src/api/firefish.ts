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
      // also track prefund txs (parents of escrow-setups), which don't touch a Firefish address
      for (const t of prefundTxids) {
        txids.add(t);
      }
      txidCache = { txids, time: now };
      return txids;
    }
  } catch (e) {
    logger.warn('[firefish] $getFirefishTxids failed: ' + (e instanceof Error ? e.message : e));
  }
  // fall back to the last known set rather than hiding everything on a transient failure
  return txidCache?.txids || new Set();
}

// ---- PREFUND tracking -------------------------------------------------------------------------
// A prefund tx is the parent of an escrow-setup: its output is spent as the escrow-setup's input.
// Prefund txs don't touch a Firefish address, so we discover them by scanning a recent window of
// escrow-setups and collecting their input txids, then track & label those.

const DUST_MAX_SATS = 512;
const PREFUND_WINDOW = 100;       // recent escrow-setups to scan
const PREFUND_TTL_MS = 300_000;   // refresh at most every 5 minutes

let prefundTxids: Set<string> = new Set();
let prefundTime = 0;

function isEscrowSetup(tx: any): boolean {
  let firefishOutput = false;
  let repayment = false;
  for (const vout of tx.vout || []) {
    const addr = vout.scriptpubkey_address;
    if (!addr) { continue; }
    if (addr === FIREFISH_ADDRESSES[0] && vout.value > 0 && vout.value < DUST_MAX_SATS) {
      repayment = true; // dust to fee-bump => repayment, not an escrow-setup
    }
    if (FIREFISH_ADDRESSES.includes(addr)) {
      firefishOutput = true;
    }
  }
  return firefishOutput && !repayment;
}

// Sync accessor for the last-known prefund txid set (used by getTransactionFlags).
export function getPrefundTxids(): Set<string> {
  return prefundTxids;
}

// Refresh the prefund set from a recent window of escrow-setups (their input txids). Throttled;
// safe to call every main-loop iteration.
export async function $refreshPrefundTxids(): Promise<void> {
  if (!FIREFISH_ADDRESSES.length) {
    return;
  }
  const now = Date.now();
  if (now - prefundTime < PREFUND_TTL_MS) {
    return;
  }
  prefundTime = now;
  try {
    const getRecent = (bitcoinApi as any).$getRecentHistoryTxids;
    const getTx = (bitcoinApi as any).$getRawTransaction;
    if (typeof getRecent !== 'function' || typeof getTx !== 'function') {
      return;
    }
    // escrow-setups pay to the escrow-fee-bump address, so scan its recent history
    const recent: string[] = await getRecent.call(bitcoinApi, FIREFISH_ADDRESSES[1], PREFUND_WINDOW);
    const set = new Set<string>();
    for (const txid of recent) {
      let tx;
      try {
        tx = await getTx.call(bitcoinApi, txid, false, false);
      } catch (e) {
        continue;
      }
      if (isEscrowSetup(tx)) {
        for (const vin of tx.vin || []) {
          if (vin.txid) {
            set.add(vin.txid);
          }
        }
      }
    }
    prefundTxids = set;
  } catch (e) {
    logger.warn('[firefish] $refreshPrefundTxids failed: ' + (e instanceof Error ? e.message : e));
  }
}
