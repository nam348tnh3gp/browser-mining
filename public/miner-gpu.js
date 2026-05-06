// miner-gpu.js - WebGPU Bitcoin Mining Worker (SHA-256d hoàn chỉnh)
// Yêu cầu: Trình duyệt hỗ trợ WebGPU (Chrome 113+, Edge 113+, ...)

let currentJob = null;
let currentTarget = new Uint8Array(32).fill(0xff); // max target mặc định
let running = false;
let hashrate = 0;
let extraNonce2 = 0;

// WebGPU objects
let device, queue;
let computePipeline;
let bindGroupLayout, bindGroup;
let gpuBufferHeader, gpuBufferTarget, gpuBufferResults;
let stagingBuffer;

const WORKGROUP_SIZE = 256;          // mỗi workgroup xử lý 256 nonce
const MAX_WORKGROUPS = 64;          // số workgroups mỗi dispatch = 64
const NONCES_PER_DISPATCH = WORKGROUP_SIZE * MAX_WORKGROUPS; // 16384 nonce/lần

// ------------------------------------------------------------
// 1. KHỞI TẠO GPU VÀ SHADER
// ------------------------------------------------------------
async function initGPU() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter');
  device = await adapter.requestDevice();
  queue = device.queue;

  // Shader WGSL: SHA-256d đầy đủ cho header 80 byte
  const shaderCode = `
    // Header: 20 u32 (80 bytes, little-endian)
    struct Header {
      data: array<u32, 20>
    };
    // Target: 8 u32 big-endian (32 bytes), word[0] là byte cao nhất
    struct Target {
      data: array<u32, 8>
    };
    struct Results {
      found: atomic<u32>,
      nonce: u32,       // nonce tìm thấy (đầu tiên)
    };

    @group(0) @binding(0) var<storage, read> header : Header;
    @group(0) @binding(1) var<storage, read> target : Target;
    @group(0) @binding(2) var<storage, read_write> results : Results;

    // SHA-256 functions
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

    // Nén SHA-256 (1 block 512-bit = 16 u32, cập nhật state)
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

    // SHA-256 cho dữ liệu độ dài 80 byte (2 block)
    fn sha256_80bytes(input: array<u32, 20>) -> array<u32, 8> {
      var state: array<u32, 8> = array<u32, 8>(
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
      );

      // Block 1: 64 byte đầu (16 u32) + padding (0x80, zero, cuối là độ dài 640 bit)
      var block1: array<u32, 16>;
      for (var i = 0u; i < 16u; i++) { block1[i] = input[i]; }
      // Padding: thêm 0x80 vào vị trí byte thứ 64 (u32 thứ 16)
      // Byte 64 là offset 64 trong input (input dài 80 byte, 16 u32 = 64 byte, còn 4 u32 = 16 byte)
      // Padding phải ở cuối dữ liệu. Ta xử lý riêng block 2.
      sha256_block(&state, &block1);

      // Block 2: 16 byte còn lại (input[16..19]) + padding (0x80 + zero + 640 bit count)
      var block2: array<u32, 16>;
      // 4 u32 cuối của header (byte 64-79)
      block2[0] = input[16]; block2[1] = input[17]; block2[2] = input[18]; block2[3] = input[19];
      // Padding: byte 80 = 0x80, byte 81-95 = 0 (u32[4]..u32[6] = 0)
      // Độ dài 80*8=640 bit, big-endian ở cuối block
      // Block 2 cần 48 byte padding sau 16 byte dữ liệu -> tổng 64 byte.
      // Cấu trúc: 4 u32 data, sau đó 0x80, rồi zero, cuối cùng là 8 byte độ dài.
      // u32[4] = 0x80 (little-endian: byte đầu tiên là 0x80) thực tế là 0x00000080u?
      // Trong SHA-256, padding bit '1' là 0x80 ở byte đầu tiên sau dữ liệu.
      // -> block2[4] = 0x80u ở dạng little-endian? Byte đầu tiên trong u32 là byte thấp nhất.
      // Để chính xác: khối dữ liệu 64 byte được biểu diễn dưới dạng 16 u32 theo little-endian của host (CPU).
      // Dữ liệu gốc: 4 u32 cuối header, tiếp theo byte 0x80, rồi 47 byte 0, cuối cùng 8 byte độ dài.
      // Ta trực tiếp gán:
      // block2[4] = 0x80 (tương đương byte 0x80 ở vị trí byte 0 của u32 này, các byte còn lại 0)
      // Trong little-endian, giá trị 0x80 chỉ có byte thấp nhất là 0x80, byte cao là 0. Nên block2[4] = 0x80u là đúng.
      block2[4] = 0x80u;
      for (var i = 5u; i < 14u; i++) { block2[i] = 0u; }
      // Độ dài 80 byte = 640 bit = 0x280, biểu diễn big-endian trong 8 byte cuối.
      // Vị trí u32[14] và u32[15] là 64-bit big-endian, với host little-endian cần đảo byte.
      // Độ dài 640 bit => 0x00000000_00000280. Big-endian: byte cao nhất trước.
      // Trong little-endian, u32[14] (byte 56-59) = 0x00000000, u32[15] (byte 60-63) = 0x00000280? 
      // Thực tế: 8 byte: 0x00 0x00 0x00 0x00 0x00 0x00 0x02 0x80.
      // Khi lưu thành 2 u32 little-endian:
      // u32[14] chứa byte 56-59: 0x00,0x00,0x00,0x00 → 0x00000000
      // u32[15] chứa byte 60-63: 0x00,0x00,0x02,0x80 → byte0=0x80, byte1=0x02, byte2=0x00, byte3=0x00 => giá trị 0x000280 (little-endian) = 0x00000280.
      block2[14] = 0x00u;
      block2[15] = 0x000280u; // 640 = 0x280, little-endian lưu byte thấp nhất trước, nên giá trị này đúng.
      sha256_block(&state, &block2);

      // Trả về state cuối cùng (8 u32, mỗi u32 là word của hash ở dạng little-endian? 
      // state[i] là một word 32-bit, nhưng cần biết thứ tự byte output. 
      // Theo quy ước, SHA-256 output là 32 byte big-endian, nhưng state[i] được lưu dưới dạng native (little-endian). 
      // Khi so sánh với target (big-endian), ta sẽ chuyển đổi state thành mảng 8 u32 big-endian.)
      return state;
    }

    // SHA-256d: hash = SHA256(SHA256(header))
    fn sha256d(header: array<u32, 20>) -> array<u32, 8> {
      let firstHash = sha256_80bytes(header);      // 8 u32 (little-endian words)
      // Để hash lần 2, cần chuyển firstHash thành 16 u32 (32 byte) và padding (0x80 + zero + 256 bit)
      var input2: array<u32, 16>;
      // Copy 8 u32 của firstHash vào input2[0..7]
      for (var i = 0u; i < 8u; i++) { input2[i] = firstHash[i]; }
      // Padding: input 32 byte, thêm 0x80, zero, và độ dài 256 bit
      input2[8] = 0x80u; // byte 0x80 sau dữ liệu
      for (var i = 9u; i < 14u; i++) { input2[i] = 0u; }
      // Độ dài 32 byte = 256 bit = 0x100, big-endian 8 byte: 0x00 0x00 0x00 0x00 0x00 0x00 0x01 0x00
      // Little-endian: u32[14]=0x00, u32[15]=0x00000100 (vì byte thấp nhất là 0x00, byte tiếp là 0x01)
      input2[14] = 0x00u;
      input2[15] = 0x00000100u;
      
      var state2: array<u32, 8> = array<u32, 8>(
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
      );
      sha256_block(&state2, &input2);
      return state2; // 8 u32 little-endian words của hash cuối cùng
    }

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let idx = gid.x; // 0..255
      // Mỗi invocation xử lý 1 nonce = baseNonce + idx + workgroup_id * 256
      // baseNonce được truyền qua results.nonce tạm thời, nhưng ta dùng global id thay thế
      let workgroup_id = gid.z * 64u + gid.y; // đơn giản gid.z=0, gid.y từ 0..63
      let nonce = workgroup_id * 256u + idx; // nonce 32-bit

      // Copy header, thay đổi nonce ở word cuối (little-endian)
      var h: array<u32, 20> = header.data;
      h[19] = nonce; // nonce ở word 19 (byte 76-79)

      let hash = sha256d(h); // 8 u32 little-endian words

      // Chuyển hash thành big-endian để so sánh với target (target cũng big-endian)
      // target.data[i] là u32 big-endian word thứ i (từ cao xuống thấp)
      // Cần so sánh hash (32 byte) với target bytewise.
      // Ta sẽ so sánh từ word 0 đến 7 của target (big-endian) với hash đã đảo byte thành big-endian.
      var passed = true;
      for (var i = 0u; i < 8u; i++) {
        // Lấy word big-endian từ hash: đảo byte của hash[i] (little-endian) -> big-endian
        let word_le = hash[i];
        let word_be = ((word_le >> 24u) & 0xFFu) |
                      ((word_le >> 8u) & 0xFF00u) |
                      ((word_le << 8u) & 0xFF0000u) |
                      ((word_le << 24u) & 0xFF000000u);
        // target data đã là big-endian (word đầu tiên là byte cao nhất)
        let t = target.data[i];
        if word_be < t {
          // Hash < target => hợp lệ, break vòng lặp và ghi kết quả
          break;
        } else if word_be > t {
          passed = false;
          break;
        }
      }

      if (passed) {
        // Hash <= target
        // Thử ghi nonce vào kết quả nếu chưa ai ghi (atomic compare exchange)
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

  // Buffers
  gpuBufferHeader = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  gpuBufferTarget = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  gpuBufferResults = device.createBuffer({
    size: 8, // 4 byte atomic found + 4 byte nonce
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
// 2. XÂY DỰNG HEADER 80 BYTES TỪ JOB
// ------------------------------------------------------------
function hexToBytes(hex) {
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Hàm SHA-256d cho CPU (dùng trong worker nếu không có importScripts, ta import sha256.js ở đầu file)
importScripts('sha256.js');

function buildMerkleRoot(coinb1, coinb2, merkleBranch, extraNonce1, extraNonce2) {
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
  return merkleRoot; // Uint8Array(32) big-endian
}

function buildHeader(job, nonce) {
  const version = parseInt(job[5], 16); // version hex -> number, sẽ viết little-endian
  const prevHash = hexToBytes(job[1]);   // 32 bytes big-endian (đúng format)
  // Tính merkle root
  const extraNonce1 = ''; // nếu pool gửi extraNonce1 riêng, thêm vào; hiện tại để trống
  const merkleRoot = buildMerkleRoot(job[2], job[3], job[4], extraNonce1, extraNonce2);
  const ntime = parseInt(job[7], 16);
  const nbits = parseInt(job[6], 16);
  
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);
  
  // Version (4 bytes little-endian)
  view.setInt32(0, version, true);
  // PrevHash (32 bytes, giữ nguyên thứ tự big-endian, phải đặt đúng vị trí)
  header.set(prevHash, 4);
  // MerkleRoot (32 bytes big-endian)
  header.set(merkleRoot, 36);
  // ntime (4 bytes little-endian)
  view.setInt32(68, ntime, true);
  // nbits (4 bytes little-endian)
  view.setInt32(72, nbits, true);
  // nonce (4 bytes little-endian)
  view.setInt32(76, nonce, true);
  
  return header;
}

// Chuyển header 80 bytes thành 20 u32 little-endian cho GPU
function headerToUint32Array(headerBytes) {
  const u32 = new Uint32Array(20);
  const view = new DataView(headerBytes.buffer);
  for (let i = 0; i < 20; i++) {
    u32[i] = view.getUint32(i * 4, true);
  }
  return u32;
}

// Cập nhật header và target buffer
function updateBuffers(job) {
  extraNonce2 = Math.floor(Math.random() * 0xffffffff); // khởi tạo ngẫu nhiên
  const headerBytes = buildHeader(job, 0); // nonce tạm thời = 0 (shader sẽ thay)
  const headerU32 = headerToUint32Array(headerBytes);
  queue.writeBuffer(gpuBufferHeader, 0, headerU32.buffer);

  // Target: currentTarget là 32 byte big-endian, cần chuyển thành 8 u32 big-endian để shader so sánh
  const targetU32 = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    targetU32[i] = (currentTarget[i*4] << 24) | 
                   (currentTarget[i*4+1] << 16) | 
                   (currentTarget[i*4+2] << 8) | 
                   currentTarget[i*4+3];
  }
  queue.writeBuffer(gpuBufferTarget, 0, targetU32.buffer);
}

// ------------------------------------------------------------
// 3. KHỞI CHẠY MINING & ĐỌC KẾT QUẢ
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

async function dispatchHash() {
  if (!currentJob) return;

  // Reset buffer kết quả
  queue.writeBuffer(gpuBufferResults, 0, new Uint32Array([0, 0]));

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(computePipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(MAX_WORKGROUPS); // dispatches 64 workgroups
  passEncoder.end();
  device.queue.submit([commandEncoder.finish()]);

  await device.queue.onSubmittedWorkDone();
  const { found, nonce } = await readResults();

  if (found === 1) {
    // Tìm thấy nonce hợp lệ -> submit share
    const job = currentJob;
    const shareParams = [
      job[0],   // jobId
      '',       // extraNonce2 (đã được tính trong merkle root, ta gửi lại để pool biết)
      job[7],   // ntime (hex string)
      nonce.toString(16)
    ];
    self.postMessage({
      type: 'share',
      data: {
        id: 4,
        method: 'mining.submit',
        params: shareParams
      }
    });
    // Tăng extraNonce2 để tiếp tục
    extraNonce2++;
    updateBuffers(currentJob);
  }
}

// Đo hashrate ước tính
let lastTime = performance.now();
let hashCountSinceLast = 0;

function mineLoopGPU() {
  if (!running || !currentJob) return;
  
  const start = performance.now();
  dispatchHash().then(() => {
    const elapsed = performance.now() - start;
    hashCountSinceLast += NONCES_PER_DISPATCH;
    
    // Cập nhật hashrate mỗi giây
    if (performance.now() - lastTime > 1000) {
      hashrate = Math.round(hashCountSinceLast / ((performance.now() - lastTime) / 1000));
      self.postMessage({ type: 'hashrate', value: hashrate, source: 'gpu' });
      hashCountSinceLast = 0;
      lastTime = performance.now();
    }
    
    // Tiếp tục vòng lặp
    setTimeout(mineLoopGPU, 0);
  });
}

// ------------------------------------------------------------
// 4. NHẬN MESSAGE TỪ MAIN THREAD
// ------------------------------------------------------------
self.onmessage = async function(e) {
  const msg = e.data;
  if (msg.type === 'stratum') {
    const data = JSON.parse(msg.data);
    if (data.method === 'mining.notify') {
      currentJob = data.params;
      if (!device) await initGPU();
      updateBuffers(currentJob);
      if (!running) {
        running = true;
        mineLoopGPU();
      }
    } else if (data.method === 'mining.set_difficulty') {
      // Cập nhật target từ difficulty (như ở CPU miner)
      const diff = data.params[0];
      currentTarget = targetFromDifficulty(diff);
      if (device && currentJob) updateBuffers(currentJob);
    }
  }
};

function targetFromDifficulty(diff) {
  const maxTarget = hexToBytes('00000000ffff0000000000000000000000000000000000000000000000000000');
  const diffBig = BigInt(Math.floor(diff));
  const maxBig = BigInt('0x' + Array.from(maxTarget).map(b => b.toString(16).padStart(2, '0')).join(''));
  const targetBig = maxBig / diffBig;
  const targetHex = targetBig.toString(16).padStart(64, '0');
  return hexToBytes(targetHex);
}
