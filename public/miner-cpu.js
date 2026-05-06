// miner-cpu.js - CPU Bitcoin Mining Worker
let currentJob = null;
let running = false;
let hashrate = 0;
let extraNonce1 = '';       // sẽ được set từ set_extranonce
let extraNonce2 = 0;

// Import sha256.js trong worker (nếu dùng dedicated worker, có thể dùng importScripts)
// Giả sử sha256.js export global function sha256d (hoặc tự implement)
// Ở đây dùng sha256.js đã được include qua importScripts
importScripts('sha256.js');  // đảm bảo file này nằm cùng thư mục

function hexToBytes(hex) {
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function buildMerkleRoot(coinb1, coinb2, merkleBranch) {
  const coinbaseHex = coinb1 + extraNonce1 + extraNonce2.toString(16).padStart(8, '0') + coinb2;
  const coinbaseBytes = hexToBytes(coinbaseHex);
  let merkleRoot = sha256d(coinbaseBytes);
  for (const branch of merkleBranch) {
    const branchBytes = hexToBytes(branch);
    const combined = new Uint8Array(64);
    combined.set(merkleRoot, 0);
    combined.set(branchBytes, 32);
    merkleRoot = sha256d(combined);
  }
  return merkleRoot;
}

function buildHeader(job) {
  const version = parseInt(job[5], 16);
  const prevHash = hexToBytes(job[1]);
  const merkleRoot = buildMerkleRoot(job[2], job[3], job[4]);
  const ntime = parseInt(job[7], 16);
  const nbits = parseInt(job[6], 16);
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);
  view.setInt32(0, version, true);
  header.set(prevHash, 4);
  header.set(merkleRoot, 36);
  view.setInt32(68, ntime, true);
  view.setInt32(72, nbits, true);
  view.setInt32(76, 0, true);
  return header;
}

function targetFromNbits(nbits) {
  const num = parseInt(nbits, 16);
  const exp = (num >> 24) & 0xff;
  const mant = num & 0x00ffffff;
  if (exp <= 3) return new Uint8Array(32);
  const target = new Uint8Array(32);
  target[32 - exp] = (mant >> 16) & 0xff;
  target[32 - exp + 1] = (mant >> 8) & 0xff;
  target[32 - exp + 2] = mant & 0xff;
  return target;
}

function targetFromDifficulty(diff) {
  let diffBig;
  if (typeof diff === 'string') diffBig = BigInt(Math.floor(Number(diff)));
  else diffBig = BigInt(Math.floor(Number(diff)));
  const maxTarget = hexToBytes('00000000ffff0000000000000000000000000000000000000000000000000000');
  const maxBig = BigInt('0x' + Array.from(maxTarget).map(b => b.toString(16).padStart(2, '0')).join(''));
  const targetBig = maxBig / diffBig;
  const targetHex = targetBig.toString(16).padStart(64, '0');
  return hexToBytes(targetHex);
}

function checkHash(headerBytes, target) {
  const hash = sha256d(headerBytes);
  for (let i = 31; i >= 0; i--) {
    if (hash[i] < target[i]) return true;
    if (hash[i] > target[i]) return false;
  }
  return true;
}

let currentTarget = new Uint8Array(32).fill(0xff);

function mineLoop() {
  if (!running || !currentJob) return;
  const header = buildHeader(currentJob);
  const view = new DataView(header.buffer);
  let found = false;

  const start = performance.now();
  // Quét 65536 nonce mỗi lần
  for (let i = 0; i < 65536; i++) {
    const nonce = (extraNonce2 * 65536 + i) >>> 0; // giữ trong 32-bit
    view.setInt32(76, nonce, true);
    if (checkHash(header, currentTarget)) {
      // Tìm thấy share
      self.postMessage({
        type: 'share',
        data: {
          id: 4,
          method: 'mining.submit',
          params: [
            currentJob[0],
            extraNonce2.toString(16).padStart(8, '0'), // chỉ gửi extraNonce2
            currentJob[7],
            nonce.toString(16)
          ]
        }
      });
      found = true;
      break; // gửi một share, sau đó tăng extraNonce2 để tiếp tục
    }
  }

  // Cập nhật hashrate
  hashrate = Math.round(65536 / ((performance.now() - start) / 1000));
  self.postMessage({ type: 'hashrate', value: hashrate, source: 'cpu' });

  // Tăng extraNonce2 để quét không gian mới
  extraNonce2++;
  setTimeout(mineLoop, 0);
}

self.onmessage = function (e) {
  if (e.data.type !== 'stratum') return;
  try {
    const data = JSON.parse(e.data);
    if (data.method === 'mining.notify') {
      currentJob = data.params;
      if (currentTarget[0] === 0xff && currentTarget[1] === 0xff) {
        currentTarget = targetFromNbits(currentJob[6]);
      }
      extraNonce2 = Math.floor(Math.random() * 0xffff);
      if (!running) {
        running = true;
        mineLoop();
      }
    } else if (data.method === 'mining.set_difficulty') {
      currentTarget = targetFromDifficulty(data.params[0]);
    } else if (data.method === 'mining.set_extranonce') {
      extraNonce1 = data.params[0];
      extraNonce2 = Math.floor(Math.random() * 0xffff);
    }
  } catch (e) {
    self.postMessage({ type: 'error', error: e.message });
  }
};
