// miner-gpu.js - WebGPU Bitcoin Mining Worker (Production Ready)
// Yêu cầu: Trình duyệt hỗ trợ WebGPU (Chrome 113+, Edge 113+, ...)

let currentJob = null;
let currentTarget = null;               // sẽ được khởi tạo từ nbits hoặc set_difficulty
let running = false;
let hashrate = 0;
let extraNonce1 = '';                  // hex string (thường 8 ký tự) từ pool
let extraNonce2 = 0;

// WebGPU objects
let device, queue;
let computePipeline;
let bindGroupLayout, bindGroup;
let gpuBufferHeader, gpuBufferTarget, gpuBufferResults;
let stagingBuffer;

const WORKGROUP_SIZE = 256;
const MAX_WORKGROUPS = 64;
const NONCES_PER_DISPATCH = WORKGROUP_SIZE * MAX_WORKGROUPS; // 16384

// ------------------------------------------------------------
// 1. HÀM BĂM SHA-256D CHO CPU (Web Crypto)
// ------------------------------------------------------------
async function sha256d(data) {
  const hash1 = await crypto.subtle.digest('SHA-256', data);
  const hash2 = await crypto.subtle.digest('SHA-256', hash1);
  return new Uint8Array(hash2); // 32 bytes big-endian
}

// ------------------------------------------------------------
// 2. KHỞI TẠO GPU VÀ SHADER (giữ nguyên)
// ------------------------------------------------------------
async function initGPU() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter');
  device = await adapter.requestDevice();
  queue = device.queue;

  const shaderCode = `
    struct Header { data: array<u32, 20> };
    struct Target { data: array<u32, 8> };
    struct Results { found: atomic<u32>, nonce: u32 };

    @group(0) @binding(0) var<storage, read> header : Header;
    @group(0) @binding(1) var<storage, read> target : Target;
    @group(0) @binding(2) var<storage, read_write> results : Results;

    fn rotr(x: u32, k: u32) -> u32 { return (x >> k) | (x << (32u - k)); }
    fn sigma0(x: u32) -> u32 { return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u); }
    fn sigma1(x: u32) -> u32 { return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10u); }
    fn Sigma0(x: u32) -> u32 { return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u); }
    fn Sigma1(x: u32) -> u32 { return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u); }
    fn Ch(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (~x & z); }
    fn Maj(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (x & z) ^ (y & z); }

    const K: array<u32, 64> = array<u32, 64>(
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
      0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
      0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
      0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
      0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
      0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
      0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
      0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
      0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
      0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
      0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
      0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
      0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
      0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
      0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
      0x90befffa, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
    );

    fn sha256_block(state: ptr<function, array<u32, 8>>, block: ptr<function, array<u32, 16>>) {
      var w: array<u32, 64>;
      for (var i = 0u; i < 16u; i++) { w[i] = (*block)[i]; }
      for (var i = 16u; i < 64u; i++) {
        w[i] = sigma1(w[i-2u]) + w[i-7u] + sigma0(w[i-15u]) + w[i-16u];
      }
      var a = (*state)[0]; var b = (*state)[1]; var c = (*state)[2]; var d = (*state)[3];
      var e = (*state)[4]; var f = (*state)[5]; var g = (*state)[6]; var h = (*state)[7];
      for (var i = 0u; i < 64u; i++) {
        let t1 = h + Sigma1(e) + Ch(e,f,g) + K[i] + w[i];
        let t2 = Sigma0(a) + Maj(a,b,c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
      }
      (*state)[0] += a; (*state)[1] += b; (*state)[2] += c; (*state)[3] += d;
      (*state)[4] += e; (*state)[5] += f; (*state)[6] += g; (*state)[7] += h;
    }

    fn sha256_80bytes(input: array<u32, 20>) -> array<u32, 8> {
      var state: array<u32, 8> = array<u32, 8>(
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
      );
      var block1: array<u32, 16>;
      for (var i = 0u; i < 16u; i++) { block1[i] = input[i]; }
      sha256_block(&state, &block1);

      var block2: array<u32, 16>;
      block2[0] = input[16]; block2[1] = input[17]; block2[2] = input[18]; block2[3] = input[19];
      block2[4] = 0x80u;
      for (var i = 5u; i < 14u; i++) { block2[i] = 0u; }
      block2[14] = 0x00u;
      block2[15] = 0x000280u;
      sha256_block(&state, &block2);
      return state;
    }

    fn sha256d(header: array<u32, 20>) -> array<u32, 8> {
      let firstHash = sha256_80bytes(header);
      var input2: array<u32, 16>;
      for (var i = 0u; i < 8u; i++) { input2[i] = firstHash[i]; }
      input2[8] = 0x80u;
      for (var i = 9u; i < 14u; i++) { input2[i] = 0u; }
      input2[14] = 0x00u;
      input2[15] = 0x00000100u;

      var state2: array<u32, 8> = array<u32, 8>(
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
      );
      sha256_block(&state2, &input2);
      return state2;
    }

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let idx = gid.x;
      let workgroup_id = gid.z * 64u + gid.y;
      let nonce = workgroup_id * 256u + idx;

      var h: array<u32, 20> = header.data;
      h[19] = nonce;

      let hash = sha256d(h);

      var passed = true;
      for (var i = 0u; i < 8u; i++) {
        let word_le = hash[i];
        let word_be = ((word_le >> 24u) & 0xFFu) |
                      ((word_le >> 8u) & 0xFF00u) |
                      ((word_le << 8u) & 0xFF0000u) |
                      ((word_le << 24u) & 0xFF000000u);
        let t = target.data[i];
        if word_be < t {
          break;
        } else if word_be > t {
          passed = false;
          break;
        }
      }

      if (passed) {
        let zero = 0u;
        let exchanged = atomicCompareExchangeWeak(&results.found, &zero, 1u);
        if (exchanged) {
          results.nonce = nonce;
        }
      }
    }
  `;

  const shaderModule = device.createShaderModule({ code: shaderCode });

  bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
    ]
  });

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  computePipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module: shaderModule, entryPoint: 'main' }
  });

  gpuBufferHeader = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  gpuBufferTarget = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  gpuBufferResults = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  stagingBuffer = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: gpuBufferHeader } },
      { binding: 1, resource: { buffer: gpuBufferTarget } },
      { binding: 2, resource: { buffer: gpuBufferResults } }
    ]
  });
}

// ------------------------------------------------------------
// 3. TIỆN ÍCH CHUYỂN ĐỔI
// ------------------------------------------------------------
function hexToBytes(hex) {
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// ------------------------------------------------------------
// 4. XÂY DỰNG MERKLE ROOT & HEADER
// ------------------------------------------------------------
async function buildMerkleRoot(coinb1, coinb2, merkleBranch) {
  const coinbaseHex = coinb1 + extraNonce1 + extraNonce2.toString(16).padStart(8, '0') + coinb2;
  const coinbaseBytes = hexToBytes(coinbaseHex);
  let merkleRoot = await sha256d(coinbaseBytes);

  for (const branch of merkleBranch) {
    const branchBytes = hexToBytes(branch);
    const combined = new Uint8Array(64);
    combined.set(merkleRoot, 0);
    combined.set(branchBytes, 32);
    merkleRoot = await sha256d(combined);
  }
  return merkleRoot; // 32 bytes big-endian
}

async function buildHeader(job) {
  const version = parseInt(job[5], 16);
  const prevHash = hexToBytes(job[1]);
  const merkleRoot = await buildMerkleRoot(job[2], job[3], job[4]);
  const ntime = parseInt(job[7], 16);
  const nbits = parseInt(job[6], 16);

  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);

  view.setInt32(0, version, true);
  header.set(prevHash, 4);
  header.set(merkleRoot, 36);
  view.setInt32(68, ntime, true);
  view.setInt32(72, nbits, true);
  view.setInt32(76, 0, true); // nonce = 0 (shader tự đặt)

  return header;
}

function headerToUint32Array(headerBytes) {
  const u32 = new Uint32Array(20);
  const view = new DataView(headerBytes.buffer);
  for (let i = 0; i < 20; i++) {
    u32[i] = view.getUint32(i * 4, true);
  }
  return u32;
}

// Cập nhật header và target buffer
async function updateBuffers(job) {
  const headerBytes = await buildHeader(job);
  const headerU32 = headerToUint32Array(headerBytes);
  queue.writeBuffer(gpuBufferHeader, 0, headerU32.buffer);

  // Chuyển target thành 8 u32 big-endian
  const targetU32 = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    targetU32[i] = (currentTarget[i * 4] << 24) |
      (currentTarget[i * 4 + 1] << 16) |
      (currentTarget[i * 4 + 2] << 8) |
      currentTarget[i * 4 + 3];
  }
  queue.writeBuffer(gpuBufferTarget, 0, targetU32.buffer);
}

// ------------------------------------------------------------
// 5. TÍNH TARGET TỪ NBITS (theo chuẩn Bitcoin)
// ------------------------------------------------------------
function targetFromNbits(nbits) {
  const num = parseInt(nbits, 16);
  const exp = (num >> 24) & 0xff;
  const mant = num & 0x00ffffff;
  // Nếu exp ≤ 3, target coi như bằng 0 (cực khó, không thể đào)
  if (exp <= 3) return new Uint8Array(32); // toàn 0
  const target = new Uint8Array(32);
  target[32 - exp] = (mant >> 16) & 0xff;
  target[32 - exp + 1] = (mant >> 8) & 0xff;
  target[32 - exp + 2] = mant & 0xff;
  // Các byte còn lại giữ 0, riêng các byte đầu (cao nhất) cũng 0.
  return target;
}

// ------------------------------------------------------------
// 6. ĐỌC KẾT QUẢ TỪ GPU
// ------------------------------------------------------------
async function readResults() {
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(gpuBufferResults, 0, stagingBuffer, 0, 8);
  device.queue.submit([encoder.finish()]);
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = stagingBuffer.getMappedRange();
  const data = new Uint32Array(arrayBuffer.slice(0));
  stagingBuffer.unmap();
  return { found: data[0], nonce: data[1] };
}

// ------------------------------------------------------------
// 7. VÒNG LẶP MINING CHÍNH (ĐÃ SỬA)
// ------------------------------------------------------------
async function dispatchHash() {
  if (!currentJob) return;

  // Reset kết quả GPU
  queue.writeBuffer(gpuBufferResults, 0, new Uint32Array([0, 0]));

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(computePipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(MAX_WORKGROUPS);
  passEncoder.end();
  device.queue.submit([commandEncoder.finish()]);

  await device.queue.onSubmittedWorkDone();
  const { found, nonce } = await readResults();

  if (found > 0) {   // SỬA: > 0 thay vì === 1 (phòng trường hợp atomic bị ghi nhiều lần)
    const extraNonce2Hex = extraNonce2.toString(16).padStart(8, '0');
    self.postMessage({
      type: 'share',
      data: {
        id: 4,
        method: 'mining.submit',
        params: [
          currentJob[0],         // jobId
          extraNonce2Hex,        // extraNonce2
          currentJob[7],         // ntime
          nonce.toString(16)     // nonce
        ]
      }
    });
    // Tìm thấy share → vẫn tăng extraNonce2 để tiếp tục tìm share mới
    extraNonce2++;
    await updateBuffers(currentJob);
  } else {
    // QUAN TRỌNG: không tìm thấy → vẫn phải thay đổi header để quét tập nonce khác
    extraNonce2++;
    await updateBuffers(currentJob);
  }
}

// ------------------------------------------------------------
// 8. ĐO HASHRATE
// ------------------------------------------------------------
let lastTime = performance.now();
let hashCountSinceLast = 0;

function mineLoopGPU() {
  if (!running || !currentJob) return;

  const start = performance.now();
  dispatchHash().then(() => {
    hashCountSinceLast += NONCES_PER_DISPATCH;

    if (performance.now() - lastTime > 1000) {
      hashrate = Math.round(hashCountSinceLast / ((performance.now() - lastTime) / 1000));
      self.postMessage({ type: 'hashrate', value: hashrate, source: 'gpu' });
      hashCountSinceLast = 0;
      lastTime = performance.now();
    }

    // Tiếp tục vòng lặp bất đồng bộ
    setTimeout(mineLoopGPU, 0);
  });
}

// ------------------------------------------------------------
// 9. NHẬN LỆNH TỪ MAIN THREAD
// ------------------------------------------------------------
self.onmessage = async function (e) {
  const msg = e.data;
  if (msg.type !== 'stratum') return;

  try {
    const data = JSON.parse(msg.data);

    if (data.method === 'mining.notify') {
      currentJob = data.params;
      // QUAN TRỌNG: Khởi tạo target từ nbits nếu chưa có target (hoặc đã có target từ set_difficulty thì giữ nguyên)
      if (!currentTarget) {
        currentTarget = targetFromNbits(currentJob[6]);
      }
      if (!device) await initGPU();
      // Reset extraNonce2 cho job mới (có thể random hoặc =0)
      extraNonce2 = Math.floor(Math.random() * 0xffffffff);
      await updateBuffers(currentJob);
      if (!running) {
        running = true;
        mineLoopGPU();
      }
    } 
    else if (data.method === 'mining.set_difficulty') {
      const diff = data.params[0];
      // Cập nhật target từ difficulty (ưu tiên hơn nbits)
      currentTarget = targetFromDifficulty(diff);
      if (device && currentJob) await updateBuffers(currentJob);
    }
    else if (data.method === 'mining.set_extranonce') {
      extraNonce1 = data.params[0];
      if (device && currentJob) {
        extraNonce2 = Math.floor(Math.random() * 0xffffffff);
        await updateBuffers(currentJob);
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

// Difficulty → target (dùng khi pool gửi set_difficulty)
function targetFromDifficulty(diff) {
  // Hạn chế mất chính xác: nếu diff là chuỗi, parse trực tiếp thành BigInt
  let diffBig;
  if (typeof diff === 'string') {
    // Nếu là số thực, cắt bỏ phần thập phân
    diffBig = BigInt(Math.floor(Number(diff)));
  } else {
    diffBig = BigInt(Math.floor(Number(diff)));
  }

  const maxTarget = hexToBytes('00000000ffff0000000000000000000000000000000000000000000000000000');
  const maxBig = BigInt('0x' + Array.from(maxTarget).map(b => b.toString(16).padStart(2, '0')).join(''));
  const targetBig = maxBig / diffBig;
  const targetHex = targetBig.toString(16).padStart(64, '0');
  return hexToBytes(targetHex);
}
