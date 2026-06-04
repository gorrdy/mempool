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
// The index is the single source of truth for "which txs are Firefish, and in which block". It is
// built cheaply from the Electrum/Fulcrum address history (which gives a block height per tx, so no
// per-tx fetch is needed for counts) plus a one-time prefund backfill (persisted to disk).
let addrHeightTxids: Map<number, Set<string>> = new Map(); // address-touching FF txids per height (from Fulcrum)
let prefundsAtHeight: Map<number, Set<string>> = new Map(); // prefund txids per height
let confirmedTxids: Set<string> = new Set();               // all confirmed FF txids (address + prefund), for filtering
let prefundHeight: Map<string, number> = new Map();        // prefund txid -> block height (0 if unconfirmed); persisted
let prefundTxids: Set<string> = new Set();                 // all prefund txids (for labeling + mempool filter)

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

function addPrefund(txid: string, height: number): void {
  prefundHeight.set(txid, height > 0 ? height : 0);
  prefundTxids.add(txid);
  if (height > 0) {
    let set = prefundsAtHeight.get(height);
    if (!set) { set = new Set(); prefundsAtHeight.set(height, set); }
    set.add(txid);
    confirmedTxids.add(txid);
  }
}

// ---- persistence (the expensive prefund backfill is cached so restarts are instant) ------------
function loadIndexFromDisk(): void {
  try {
    if (!fs.existsSync(INDEX_FILE)) { return; }
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw && raw.prefundHeight) {
      for (const [txid, h] of Object.entries(raw.prefundHeight)) {
        addPrefund(txid, Number(h));
      }
      backfillDone = !!raw.backfillDone;
      logger.info(`[firefish] loaded ${prefundHeight.size} prefunds from disk (backfillDone=${backfillDone})`);
    }
  } catch (e) {
    logger.warn('[firefish] failed to load index from disk: ' + (e instanceof Error ? e.message : e));
  }
}

function saveIndexToDisk(): void {
  try {
    const obj = { backfillDone, prefundHeight: Object.fromEntries(prefundHeight) };
    fs.writeFileSync(INDEX_FILE, JSON.stringify(obj));
  } catch (e) {
    logger.warn('[firefish] failed to save index to disk: ' + (e instanceof Error ? e.message : e));
  }
}

// ---- address index (cheap: all history with heights, no per-tx fetch) --------------------------
async function $refreshAddressIndex(force = false): Promise<void> {
  if (!FIREFISH_ADDRESSES.length) { return; }
  const now = Date.now();
  if (!force && (now - addressRefreshTime) < ADDRESS_REFRESH_TTL_MS) { return; }
  addressRefreshTime = now;
  try {
    const fn = (bitcoinApi as any).$getHistoryWithHeights;
    if (typeof fn !== 'function') { return; }
    const history: { txid: string; height: number }[] = await fn.call(bitcoinApi, FIREFISH_ADDRESSES);
    const newAddr = new Map<number, Set<string>>();
    const newConfirmed = new Set<string>();
    for (const { txid, height } of history) {
      if (height > 0) {
        let set = newAddr.get(height);
        if (!set) { set = new Set(); newAddr.set(height, set); }
        set.add(txid);
        newConfirmed.add(txid);
      }
    }
    // keep confirmed prefunds in the filter set (their heights live in prefundsAtHeight)
    for (const [txid, h] of prefundHeight) {
      if (h > 0) { newConfirmed.add(txid); }
    }
    addrHeightTxids = newAddr;
    confirmedTxids = newConfirmed;
  } catch (e) {
    logger.warn('[firefish] address index refresh failed: ' + (e instanceof Error ? e.message : e));
  }
}

// ---- prefund backfill (one-time, full history; persisted) --------------------------------------
// Escrow-setups appear in the escrow-fee-bump address history; each escrow-setup's input is a
// prefund (co-confirmed in the same block). Fetch them once, record prefund -> height, persist.
async function $backfillPrefunds(): Promise<void> {
  if (backfillDone || backfillRunning || !FIREFISH_ADDRESSES.length) { return; }
  backfillRunning = true;
  try {
    const getHist = (bitcoinApi as any).$getHistoryWithHeights;
    const getTx = (bitcoinApi as any).$getRawTransaction;
    if (typeof getHist !== 'function' || typeof getTx !== 'function') { return; }
    const hist: { txid: string; height: number }[] = await getHist.call(bitcoinApi, [FIREFISH_ADDRESSES[1]]);
    logger.info(`[firefish] prefund backfill: scanning ${hist.length} escrow-fee-bump txs...`);
    const limit = pLimit(BACKFILL_CONCURRENCY);
    let processed = 0;
    await Promise.all(hist.map(({ txid, height }) => limit(async () => {
      let tx;
      try {
        tx = await getTx.call(bitcoinApi, txid, false, false);
      } catch (e) {
        return;
      }
      if (isEscrowSetup(tx)) {
        for (const vin of tx.vin || []) {
          if (vin.txid) {
            addPrefund(vin.txid, height);
          }
        }
      }
      processed++;
      if (processed % 5000 === 0) {
        logger.info(`[firefish] prefund backfill ${processed}/${hist.length} (${prefundHeight.size} prefunds)`);
      }
    })));
    backfillDone = true;
    saveIndexToDisk();
    logger.info(`[firefish] prefund backfill complete: ${prefundHeight.size} prefunds`);
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

// Set of all Firefish txids (address-touching + prefunds) for filtering a block's transactions.
export async function $getFirefishTxids(): Promise<Set<string>> {
  if (!FIREFISH_ADDRESSES.length) { return new Set(); }
  await $refreshAddressIndex();
  const result = new Set<string>(confirmedTxids);
  for (const t of prefundTxids) {
    result.add(t); // include any unconfirmed/mempool prefunds too
  }
  return result;
}

// Number of Firefish txs in the block at the given height (address-touching + prefunds), from the
// index — consistent with $getFirefishTxids and available for every block, including older ones.
export function getFirefishCountForHeight(height: number): number {
  const a = addrHeightTxids.get(height);
  const p = prefundsAtHeight.get(height);
  if (!p || p.size === 0) { return a ? a.size : 0; }
  if (!a || a.size === 0) { return p.size; }
  const union = new Set<string>(a);
  for (const t of p) { union.add(t); }
  return union.size;
}

// Sync accessor for the prefund txid set (used by getTransactionFlags for the PREFUND_TX label).
export function getPrefundTxids(): Set<string> {
  return prefundTxids;
}

// Force-refresh the address index from Fulcrum (used when a new block is processed, so its txs are
// in the index before its count is computed).
export async function $refreshFirefishForBlock(): Promise<void> {
  if (!FIREFISH_ADDRESSES.length) { return; }
  await $refreshAddressIndex(true);
}

// Seed prefunds from a confirmed block as it is processed: any input of an escrow-setup that is
// itself a tx in the same block is a prefund (co-confirmed). Keeps new blocks consistent without
// waiting for the periodic backfill.
export function registerBlockPrefunds(transactions: any[], height: number): void {
  if (!FIREFISH_ADDRESSES.length || !transactions || !transactions.length || height <= 0) { return; }
  const blockTxids = new Set<string>(transactions.map((t) => t.txid));
  let changed = false;
  for (const tx of transactions) {
    if (isEscrowSetup(tx)) {
      for (const vin of tx.vin || []) {
        if (vin.txid && blockTxids.has(vin.txid) && !prefundHeight.has(vin.txid)) {
          addPrefund(vin.txid, height);
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
