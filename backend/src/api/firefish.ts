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
//  - prefund txids: parents of escrow-setups / top-ups (their output funds that tx's input). These
//    don't touch a Firefish address, so they are discovered from the escrow-setups/top-ups:
//    backfilled once over the full history (persisted to disk) and seeded live as blocks are
//    processed. They are split by what they fund: escrowPrefundTxids (fund an escrow-setup) vs
//    topupPrefundTxids (fund a top-up), so the two can be labelled distinctly.
let addressTxids: Set<string> = new Set();
let escrowPrefundTxids: Set<string> = new Set();
let topupPrefundTxids: Set<string> = new Set();
// cached union (addressTxids + both prefund sets); invalidated (set null) whenever a set changes
let firefishUnionCache: Set<string> | null = null;

let addressRefreshTime = 0;
let backfillDone = false;
let backfillRunning = false;

// Classify a tx by its output to the escrow (escrow-fee-bump) address:
//  - 'escrow': a non-dust (>= 512 sats) output — that big output IS the escrow => escrow-setup.
//  - 'topup': only a dust (< 512 sats) output — a fee bump on an existing escrow.
//  - null: no escrow-fee-bump output.
// In both the 'escrow' and 'topup' cases the tx's funding input is a prefund (distinguished by kind).
function escrowFundingKind(tx: any): 'escrow' | 'topup' | null {
  let topup = false;
  for (const vout of tx.vout || []) {
    if (vout.scriptpubkey_address === FIREFISH_ADDRESSES[1] && vout.value > 0) {
      if (vout.value >= DUST_MAX_SATS) {
        return 'escrow'; // a big escrow-fee-bump output wins => escrow-setup
      }
      topup = true;
    }
  }
  return topup ? 'topup' : null;
}

// ---- persistence (the expensive prefund backfill is cached so restarts are instant) ------------
function loadIndexFromDisk(): void {
  try {
    if (!fs.existsSync(INDEX_FILE)) { return; }
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw && (Array.isArray(raw.escrowPrefunds) || Array.isArray(raw.topupPrefunds))) {
      escrowPrefundTxids = new Set<string>(raw.escrowPrefunds || []);
      topupPrefundTxids = new Set<string>(raw.topupPrefunds || []);
      backfillDone = !!raw.backfillDone;
      logger.info(`[firefish] loaded ${escrowPrefundTxids.size} escrow + ${topupPrefundTxids.size} top-up prefunds from disk (backfillDone=${backfillDone})`);
    }
  } catch (e) {
    logger.warn('[firefish] failed to load index from disk: ' + (e instanceof Error ? e.message : e));
  }
}

function saveIndexToDisk(): void {
  try {
    const obj = { backfillDone, escrowPrefunds: [...escrowPrefundTxids], topupPrefunds: [...topupPrefundTxids] };
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
    firefishUnionCache = null; // address set changed
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
      const kind = escrowFundingKind(tx);
      if (kind) {
        const set = kind === 'escrow' ? escrowPrefundTxids : topupPrefundTxids;
        for (const vin of tx.vin || []) {
          if (vin.txid) {
            set.add(vin.txid);
          }
        }
      }
      processed++;
      if (processed % 5000 === 0) {
        logger.info(`[firefish] prefund backfill ${processed}/${txids.length} (${escrowPrefundTxids.size} escrow + ${topupPrefundTxids.size} top-up)`);
      }
    })));
    backfillDone = true;
    firefishUnionCache = null; // prefund sets changed
    saveIndexToDisk();
    logger.info(`[firefish] prefund backfill complete: ${escrowPrefundTxids.size} escrow + ${topupPrefundTxids.size} top-up prefunds`);
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
  return getFirefishTxidsSync();
}

// Synchronous snapshot of the full Firefish txid set, cached and rebuilt only when a set changes.
// Used where awaiting isn't convenient (e.g. filtering projected mempool block contents during
// template building). Read-only — callers must not mutate the returned set.
export function getFirefishTxidsSync(): Set<string> {
  if (!firefishUnionCache) {
    const union = new Set<string>(addressTxids);
    for (const t of escrowPrefundTxids) {
      union.add(t);
    }
    for (const t of topupPrefundTxids) {
      union.add(t);
    }
    firefishUnionCache = union;
  }
  return firefishUnionCache;
}

// Sync accessors for the prefund txid sets, used by getTransactionFlags (to label PREFUND_ESCROW vs
// PREFUND_TOPUP) and by the mempool filter.
export function getEscrowPrefundTxids(): Set<string> {
  return escrowPrefundTxids;
}
export function getTopupPrefundTxids(): Set<string> {
  return topupPrefundTxids;
}

// Seed prefunds from a block as it is processed: the input txids of any escrow-setup / top-up in the
// block are prefunds (recorded by kind). Catches prefunds of new escrow-setups/top-ups without
// waiting for a re-backfill. Height is irrelevant — membership in the set is what counts.
export function registerBlockPrefunds(transactions: any[]): void {
  if (!FIREFISH_ADDRESSES.length || !transactions || !transactions.length) { return; }
  let changed = false;
  for (const tx of transactions) {
    const kind = escrowFundingKind(tx);
    if (!kind) { continue; }
    const set = kind === 'escrow' ? escrowPrefundTxids : topupPrefundTxids;
    for (const vin of tx.vin || []) {
      if (vin.txid && !set.has(vin.txid)) {
        set.add(vin.txid);
        changed = true;
      }
    }
  }
  if (changed) {
    firefishUnionCache = null; // prefund sets changed
    if (backfillDone) {
      saveIndexToDisk();
    }
  }
}

// load persisted prefunds at startup
loadIndexFromDisk();
