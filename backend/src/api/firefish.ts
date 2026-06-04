import bitcoinApi from './bitcoin/bitcoin-api-factory';
import logger from '../logger';
import config from '../config';
import pLimit from '../utils/p-limit';
import * as fs from 'fs';

// This instance is a Firefish-only explorer: only transactions related to Firefish are tracked,
// counted and shown. "Related" means a tx that, as input or output, touches one of these addresses,
// plus the prefund txs that fund escrow-setups (see below). An empty list disables all filtering.
export const FIREFISH_ADDRESSES: string[] = [
  'bc1qszttxl5jq5eyydpwvq7a6fa54at7cffp9acpyl',           // fee bump
  'bc1qy020q6fn5tyv28gh22mnhl7s5eqd7jew5jmp4v',           // escrow fee bump
  'bc1qa2zns3cjnw4jqsu2ylqp3szt3puvvjmfggdp46hv9qx5t4qjyxyq603s6z', // liquidator
];

const DUST_MAX_SATS = 512;
const INDEX_FILE = config.MEMPOOL.CACHE_DIR + '/firefish-index.json';
const ADDRESS_REFRESH_TTL_MS = 60_000;
const BACKFILL_CONCURRENCY = 32;

// ---- index state -------------------------------------------------------------------------------
// The Firefish set is the single source of truth for "which txs are Firefish". Block counts and the
// block view both derive a block's Firefish txs by intersecting the block's txids with this set, so
// they are always consistent. The set has two parts:
//  - addressTxids: txs touching a Firefish address, from the Electrum/Fulcrum address index (cheap,
//    refreshed on a throttle).
//  - prefundTxids: parents of escrow-setups (their output funds the escrow-setup's input). These
//    don't touch a Firefish address, so they are discovered from escrow-setups: backfilled once over
//    the full history (persisted to disk) and seeded live as new blocks are processed.
let addressTxids: Set<string> = new Set();
let prefundTxids: Set<string> = new Set();

let addressRefreshTime = 0;
let backfillDone = false;
let backfillRunning = false;

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

// ---- persistence (the expensive prefund backfill is cached so restarts are instant) ------------
function loadIndexFromDisk(): void {
  try {
    if (!fs.existsSync(INDEX_FILE)) { return; }
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw && Array.isArray(raw.prefunds)) {
      prefundTxids = new Set<string>(raw.prefunds);
      backfillDone = !!raw.backfillDone;
      logger.info(`[firefish] loaded ${prefundTxids.size} prefunds from disk (backfillDone=${backfillDone})`);
    }
  } catch (e) {
    logger.warn('[firefish] failed to load index from disk: ' + (e instanceof Error ? e.message : e));
  }
}

function saveIndexToDisk(): void {
  try {
    const obj = { backfillDone, prefunds: [...prefundTxids] };
    fs.writeFileSync(INDEX_FILE, JSON.stringify(obj));
  } catch (e) {
    logger.warn('[firefish] failed to save index to disk: ' + (e instanceof Error ? e.message : e));
  }
}

// ---- address index (cheap: all txids touching the Firefish addresses) --------------------------
async function $refreshAddressIndex(force = false): Promise<void> {
  if (!FIREFISH_ADDRESSES.length) { return; }
  const now = Date.now();
  if (!force && (now - addressRefreshTime) < ADDRESS_REFRESH_TTL_MS) { return; }
  addressRefreshTime = now;
  try {
    const fn = (bitcoinApi as any).$getTxidsForAddresses;
    if (typeof fn !== 'function') { return; }
    addressTxids = new Set<string>(await fn.call(bitcoinApi, FIREFISH_ADDRESSES));
  } catch (e) {
    logger.warn('[firefish] address index refresh failed: ' + (e instanceof Error ? e.message : e));
  }
}

// ---- prefund backfill (one-time, full history; persisted) --------------------------------------
// Escrow-setups appear in the escrow-fee-bump address history; each escrow-setup's input is a
// prefund. Fetch the escrow-setups once, record their input txids, persist.
async function $backfillPrefunds(): Promise<void> {
  if (backfillDone || backfillRunning || !FIREFISH_ADDRESSES.length) { return; }
  backfillRunning = true;
  try {
    const getTxids = (bitcoinApi as any).$getTxidsForAddresses;
    const getTx = (bitcoinApi as any).$getRawTransaction;
    if (typeof getTxids !== 'function' || typeof getTx !== 'function') { return; }
    const txids: string[] = await getTxids.call(bitcoinApi, [FIREFISH_ADDRESSES[1]]);
    logger.info(`[firefish] prefund backfill: scanning ${txids.length} escrow-fee-bump txs...`);
    const limit = pLimit(BACKFILL_CONCURRENCY);
    let processed = 0;
    await Promise.all(txids.map((txid) => limit(async () => {
      let tx;
      try {
        tx = await getTx.call(bitcoinApi, txid, false, false);
      } catch (e) {
        return;
      }
      if (isEscrowSetup(tx)) {
        for (const vin of tx.vin || []) {
          if (vin.txid) {
            prefundTxids.add(vin.txid);
          }
        }
      }
      processed++;
      if (processed % 5000 === 0) {
        logger.info(`[firefish] prefund backfill ${processed}/${txids.length} (${prefundTxids.size} prefunds)`);
      }
    })));
    backfillDone = true;
    saveIndexToDisk();
    logger.info(`[firefish] prefund backfill complete: ${prefundTxids.size} prefunds`);
  } catch (e) {
    logger.warn('[firefish] prefund backfill failed: ' + (e instanceof Error ? e.message : e));
  } finally {
    backfillRunning = false;
  }
}

// ---- public API --------------------------------------------------------------------------------

// Refresh the cheap address index (throttled) and kick off the one-time prefund backfill in the
// background if it hasn't run yet. Safe to call every main-loop iteration.
export async function $updateFirefishIndex(): Promise<void> {
  if (!FIREFISH_ADDRESSES.length) { return; }
  await $refreshAddressIndex();
  if (!backfillDone) {
    void $backfillPrefunds();
  }
}

// Set of all Firefish txids (address-touching + prefunds). A block's Firefish txs = its txids that
// are in this set; both the count and the block view use this, so they always agree.
export async function $getFirefishTxids(): Promise<Set<string>> {
  if (!FIREFISH_ADDRESSES.length) { return new Set(); }
  await $refreshAddressIndex();
  const result = new Set<string>(addressTxids);
  for (const t of prefundTxids) {
    result.add(t);
  }
  return result;
}

// Sync accessor for the prefund txid set (used by getTransactionFlags for the PREFUND_TX label and
// by the mempool filter).
export function getPrefundTxids(): Set<string> {
  return prefundTxids;
}

// Seed prefunds from a block as it is processed: the input txids of any escrow-setup in the block
// are prefunds. Catches prefunds of new escrow-setups (same-block or earlier) without waiting for a
// re-backfill. Height is irrelevant — membership in the set is what counts.
export function registerBlockPrefunds(transactions: any[]): void {
  if (!FIREFISH_ADDRESSES.length || !transactions || !transactions.length) { return; }
  let changed = false;
  for (const tx of transactions) {
    if (isEscrowSetup(tx)) {
      for (const vin of tx.vin || []) {
        if (vin.txid && !prefundTxids.has(vin.txid)) {
          prefundTxids.add(vin.txid);
          changed = true;
        }
      }
    }
  }
  if (changed && backfillDone) {
    saveIndexToDisk();
  }
}

// load persisted prefunds at startup
loadIndexFromDisk();
