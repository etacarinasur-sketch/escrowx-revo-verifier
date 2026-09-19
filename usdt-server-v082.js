'use strict';

const http = require('http');
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
// V082 TEST: USDT custody receiver moved to the Binance-managed deposit address configured in EscrowX Administration.
const USDT_RECEIVER = '0xbf94435dc4e7233c50691e6bcabf52b778be4751';
const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const BSC_CHAIN_ID = 56;
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDT_DECIMALS = 18;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_RE = /^0x[a-fA-F0-9]{64}$/;

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.end(JSON.stringify(payload));
}

function normalizeAddress(a) { return String(a || '').trim().toLowerCase(); }
function padAddressTopic(a) { return '0x' + normalizeAddress(a).slice(2).padStart(64, '0'); }
function topicAddress(topic) { return '0x' + String(topic || '').replace(/^0x/, '').slice(-40); }
function hexToBigInt(x) { return BigInt(String(x || '0')); }
function formatUnits(value, decimals) {
  const n = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
function decimalToUnits(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) throw new Error('Invalid USDT amount.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > USDT_DECIMALS) throw new Error('USDT amount has more than 18 decimal places.');
  return BigInt(whole) * (10n ** 18n) + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

async function rpc(method, params = []) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(BSC_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error(`BSC RPC HTTP ${r.status}.`);
    const p = await r.json();
    if (p.error) throw new Error(p.error.message || 'BSC RPC returned an error.');
    return p.result;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('BSC RPC request timed out.');
    throw e;
  } finally { clearTimeout(timer); }
}

async function verifyUSDT(body) {
  const amountInput = String(body.amount ?? '').trim();
  const txHash = String(body.txHash || '').trim();
  const from = String(body.from || '').trim();
  const receiver = String(body.receiver || USDT_RECEIVER).trim();
  if (!TX_RE.test(txHash)) throw new Error('Enter a valid BSC transaction hash.');
  if (!ADDRESS_RE.test(from)) throw new Error('Enter a valid USDT sender address.');
  if (!ADDRESS_RE.test(receiver)) throw new Error('USDT custody receiver is not a valid BSC address.');
  if (normalizeAddress(receiver) !== normalizeAddress(USDT_RECEIVER)) throw new Error('USDT receiver does not match the configured ESCROW X custody address.');
  const requestedUnits = decimalToUnits(amountInput);
  if (requestedUnits <= 0n) throw new Error('Enter a valid USDT amount.');

  const chainIdHex = await rpc('eth_chainId');
  const chainId = Number.parseInt(chainIdHex, 16);
  if (chainId !== BSC_CHAIN_ID) throw new Error(`Connected RPC is not BSC Mainnet. Chain ID returned: ${chainId}.`);

  const tx = await rpc('eth_getTransactionByHash', [txHash]);
  if (!tx) throw new Error('BSC transaction was not found. No balance was changed.');
  const txFrom = normalizeAddress(tx.from);
  if (txFrom !== normalizeAddress(from)) throw new Error('Blockchain sender does not match the submitted USDT sender. No balance was changed.');

  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) throw new Error('BSC transaction is not confirmed yet. No balance was changed.');
  if (String(receipt.status || '').toLowerCase() !== '0x1') throw new Error('BSC transaction failed. No balance was changed.');

  const contract = normalizeAddress(USDT_CONTRACT);
  const wantedTo = normalizeAddress(receiver);
  const wantedFromTopic = padAddressTopic(from).toLowerCase();
  const wantedToTopic = padAddressTopic(receiver).toLowerCase();
  const transfers = [];
  for (const log of (receipt.logs || [])) {
    if (normalizeAddress(log.address) !== contract) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topics.length < 3) continue;
    const logFromTopic = String(topics[1] || '').toLowerCase();
    const logToTopic = String(topics[2] || '').toLowerCase();
    if (logFromTopic !== wantedFromTopic || logToTopic !== wantedToTopic) continue;
    const units = hexToBigInt(log.data || '0x0');
    transfers.push({ units, logIndex: Number.parseInt(String(log.logIndex || '0x0'), 16) || 0 });
  }
  if (!transfers.length) throw new Error('No matching USDT Transfer event from the submitted sender to the ESCROW X custody address was found. No balance was changed.');

  const matching = transfers.find(x => x.units === requestedUnits);
  if (!matching) {
    const actual = formatUnits(transfers[0].units, USDT_DECIMALS);
    throw new Error(`Amount mismatch: blockchain shows ${actual} USDT, but you entered ${amountInput} USDT. No balance was changed.`);
  }

  const latestHex = await rpc('eth_blockNumber');
  const latest = Number.parseInt(latestHex, 16);
  const blockNumber = Number.parseInt(String(receipt.blockNumber || '0x0'), 16);
  const blockData = await rpc('eth_getBlockByNumber', [String(receipt.blockNumber || '0x0'), false]);
  const blockTimestamp = Number.parseInt(String(blockData?.timestamp || '0x0'), 16);
  if(!Number.isFinite(blockTimestamp) || blockTimestamp <= 0) throw new Error('BSC block timestamp could not be verified.');
  const confirmations = Math.max(0, latest - blockNumber + 1);
  if (confirmations < 2) throw new Error(`USDT transaction is confirmed but only has ${confirmations} BSC confirmation(s). Wait for at least 2 confirmations and retry. No balance was changed.`);

  return {
    ok: true,
    realConnector: true,
    txHash: txHash.toLowerCase(),
    from: txFrom,
    to: wantedTo,
    amount: formatUnits(matching.units, USDT_DECIMALS),
    amountUnits: matching.units.toString(),
    status: 'SUCCESS',
    action: 'TRANSFER',
    asset: 'USDT',
    network: 'BNB Smart Chain · BEP-20',
    chainId: BSC_CHAIN_ID,
    tokenContract: USDT_CONTRACT,
    decimals: USDT_DECIMALS,
    blockIndex: blockNumber,
    blockTimestamp,
    confirmations,
    logIndex: matching.logIndex,
    verificationMode: 'BNB SMART CHAIN RPC · USDT TRANSFER EVENT'
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    try {
      const chainIdHex = await rpc('eth_chainId');
      const chainId = Number.parseInt(chainIdHex, 16);
      return json(res, 200, { ok: chainId === BSC_CHAIN_ID, rpcConnected: true, chainId, network: 'BNB Smart Chain Mainnet', tokenContract: USDT_CONTRACT, receiver: USDT_RECEIVER });
    } catch (e) {
      return json(res, 503, { ok: false, rpcConnected: false, error: e.message });
    }
  }
  if (req.method === 'POST' && req.url === '/usdt-verify-server') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 100000) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const proof = await verifyUSDT(body);
        return json(res, 200, proof);
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message || 'USDT transaction could not be verified.' });
      }
    });
    return;
  }
  return json(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(PORT, () => console.log(`ESCROW X USDT verifier v082 listening on port ${PORT}`));
