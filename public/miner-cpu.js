// miner-cpu.js - CPU mining worker cho BTC (stratum)
importScripts('sha256.js');

let currentJob = null;
let currentTarget = new Uint8Array(32).fill(0xff); // giá trị tối thiểu ban đầu
let extraNonce2 = 0;
let running = false;
let hashrate = 0;
let shareCount = 0;
const REPORT_INTERVAL = 1000; // ms

// Chuyển target dạng hex (64 chars) thành Uint8Array 32 bytes big-endian
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Tạo coinbase transaction và tính merkle root
function buildMerkleRoot(coinb1, coinb2, merkleBranch, extraNonce1, extraNonce2) {
  // Coinbase = coinb1 + extraNonce1 + extraNonce2 + coinb2
  const coinbaseHex = coinb1 + extraNonce1 + extraNonce2.toString(16).padStart(8, '0') + coinb2;
  const coinbaseBytes = hexToBytes(coinbaseHex);
  const coinbaseHash = sha256d(coinbaseBytes);

  let merkleRoot = coinbaseHash;
  for (const branch of merkleBranch) {
    const branchBytes = hexToBytes(branch);
    const combined = new Uint8Array(64);
    combined.set(merkleRoot, 0);
    combined.set(branchBytes, 32);
    merkleRoot = sha256d(combined);
  }
  return merkleRoot;
}

// Xây dựng block header 80 bytes từ job và nonce
function buildHeader(version, prevHash, merkleRoot, ntime, nbits, nonce) {
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);

  // version (4 bytes little-endian)
  view.setInt32(0, parseInt(version, 16), true);
  // prevHash (32 bytes, big-endian giữ nguyên do hex decode)
  header.set(hexToBytes(prevHash), 4);
  // merkleRoot (32 bytes)
  header.set(merkleRoot, 36);
  // ntime (4 bytes little-endian)
  view.setInt32(68, parseInt(ntime, 16), true);
  // nbits (4 bytes)
  view.setInt32(72, parseInt(nbits, 16), true);
  // nonce (4 bytes little-endian)
  view.setInt32(76, nonce, true);

  return header;
}

// Tính target từ nbits (dạng hex string như "1a05db8b")
function targetFromNbits(nbits) {
  const num = parseInt(nbits, 16);
  const exp = (num >> 24) & 0xff;
  const mant = num & 0x00ffffff;
  if (exp <= 3) return new Uint8Array(32).fill(0);
  const target = new Uint8Array(32);
  target[32 - exp] = (mant >> 16) & 0xff;
  target[32 - exp + 1] = (mant >> 8) & 0xff;
  target[32 - exp + 2] = mant & 0xff;
  return target;
}

// Tính target từ difficulty share (difficulty do pool gửi)
function targetFromDifficulty(diff) {
  if (!diff || diff <= 0) diff = 1;
  const maxTarget = hexToBytes('00000000ffff0000000000000000000000000000000000000000000000000000');
  const diffBig = BigInt(Math.floor(diff));
  const maxBig = BigInt('0x' + Array.from(maxTarget).map(b => b.toString(16).padStart(2, '0')).join(''));
  const targetBig = maxBig / diffBig;
  const targetHex = targetBig.toString(16).padStart(64, '0');
  return hexToBytes(targetHex);
}

// So sánh hash với target: hash <= target (big-endian)
function isHashValid(hash, target) {
  for (let i = 0; i < 32; i++) {
    if (hash[i] < target[i]) return true;
    if (hash[i] > target[i]) return false;
  }
  return true; // bằng
}

// Xử lý message từ main thread
self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type === 'stratum') {
    try {
      const data = JSON.parse(msg.data);
      if (data.method === 'mining.notify') {
        const params = data.params;
        currentJob = {
          jobId: params[0],
          prevHash: params[1],
          coinb1: params[2],
          coinb2: params[3],
          merkleBranch: params[4],
          version: params[5],
          nbits: params[6],
          ntime: params[7],
          cleanJobs: params[8]
        };
        // Lấy target từ nbits nếu chưa có difficulty riêng
        currentTarget = targetFromNbits(currentJob.nbits);
        extraNonce2 = Math.floor(Math.random() * 0xffffffff);
        if (!running) {
          running = true;
          mineLoop();
        }
      } else if (data.method === 'mining.set_difficulty') {
        const diff = data.params[0];
        currentTarget = targetFromDifficulty(diff);
      }
    } catch (ex) { /* ignore parse errors */ }
  }
};

// Vòng lặp mine chính
function mineLoop() {
  if (!running || !currentJob) return;

  const startTime = performance.now();
  let hashCount = 0;
  const BATCH_SIZE = 2000;

  function step() {
    if (!running || !currentJob) return;
    const job = currentJob;
    const extraNonce1 = ''; // nếu pool gửi extraNonce1 riêng thì bổ sung
    const merkleRoot = buildMerkleRoot(job.coinb1, job.coinb2, job.merkleBranch, extraNonce1, extraNonce2);
    let nonce = Math.floor(Math.random() * 0xffffffff);

    for (let i = 0; i < BATCH_SIZE; i++) {
      const header = buildHeader(job.version, job.prevHash, merkleRoot, job.ntime, job.nbits, nonce);
      const hash = sha256d(header);
      if (isHashValid(hash, currentTarget)) {
        // Share found
        const share = {
          id: 4,
          method: 'mining.submit',
          params: [job.jobId, extraNonce1 + extraNonce2.toString(16).padStart(8, '0'), job.ntime, nonce.toString(16)]
        };
        self.postMessage({ type: 'share', data: share });
        shareCount++;
      }
      nonce++;
      hashCount++;
    }

    extraNonce2++;
    const elapsed = performance.now() - startTime;
    hashrate = Math.round(hashCount / (elapsed / 1000));
    self.postMessage({ type: 'hashrate', value: hashrate, source: 'cpu' });

    setTimeout(step, 0);
  }

  step();
}
