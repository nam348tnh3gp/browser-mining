// sha256.js - SHA-256 implementation (sync, no dependencies)
// Based on public domain code, modified for double SHA-256 and Uint8Array.

(function (global) {
  'use strict';

  function Sha256() {
    this.state = new Int32Array(8);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.totalBytes = 0;
    this.finished = false;
    this.reset();
  }

  Sha256.prototype.reset = function () {
    this.state[0] = 0x6a09e667;
    this.state[1] = 0xbb67ae85;
    this.state[2] = 0x3c6ef372;
    this.state[3] = 0xa54ff53a;
    this.state[4] = 0x510e527f;
    this.state[5] = 0x9b05688c;
    this.state[6] = 0x1f83d9ab;
    this.state[7] = 0x5be0cd19;
    this.bufferLength = 0;
    this.totalBytes = 0;
    this.finished = false;
    return this;
  };

  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function ROTR(x, n) { return (x >>> n) | (x << (32 - n)); }
  function Sigma0(x) { return ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22); }
  function Sigma1(x) { return ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25); }
  function sigma0(x) { return ROTR(x, 7) ^ ROTR(x, 18) ^ (x >>> 3); }
  function sigma1(x) { return ROTR(x, 17) ^ ROTR(x, 19) ^ (x >>> 10); }
  function Ch(x, y, z) { return (x & y) ^ (~x & z); }
  function Maj(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }

  Sha256.prototype.processBlock = function () {
    const W = new Int32Array(64);
    const state = this.state;
    var a, b, c, d, e, f, g, h, T1, T2;

    for (let i = 0; i < 16; i++) {
      W[i] = (this.buffer[i * 4] << 24) |
             (this.buffer[i * 4 + 1] << 16) |
             (this.buffer[i * 4 + 2] << 8) |
             this.buffer[i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      W[i] = (sigma1(W[i - 2]) + W[i - 7] + sigma0(W[i - 15]) + W[i - 16]) | 0;
    }

    a = state[0]; b = state[1]; c = state[2]; d = state[3];
    e = state[4]; f = state[5]; g = state[6]; h = state[7];

    for (let i = 0; i < 64; i++) {
      T1 = (h + Sigma1(e) + Ch(e, f, g) + K[i] + W[i]) | 0;
      T2 = (Sigma0(a) + Maj(a, b, c)) | 0;
      h = g; g = f; f = e; e = (d + T1) | 0;
      d = c; c = b; b = a; a = (T1 + T2) | 0;
    }

    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0;
    state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0;
    state[7] = (state[7] + h) | 0;

    this.bufferLength = 0;
  };

  Sha256.prototype.update = function (data) {
    if (this.finished) throw new Error('Sha256 already finished');
    var length = data.length;
    this.totalBytes += length;
    var offset = 0;
    while (length > 0) {
      var space = 64 - this.bufferLength;
      if (space > length) {
        this.buffer.set(data.subarray(offset, offset + length), this.bufferLength);
        this.bufferLength += length;
        return this;
      }
      this.buffer.set(data.subarray(offset, offset + space), this.bufferLength);
      this.bufferLength = 64;
      this.processBlock();
      offset += space;
      length -= space;
    }
    return this;
  };

  Sha256.prototype.finalize = function () {
    if (!this.finished) {
      this.finished = true;
      var totalBits = this.totalBytes * 8;
      var pad = [0x80];
      this.update(new Uint8Array(pad));
      while ((this.bufferLength % 64) !== 56) {
        this.update(new Uint8Array([0x00]));
      }
      var bitsBuf = new Uint8Array(8);
      bitsBuf[0] = (totalBits >>> 56) & 0xff;
      bitsBuf[1] = (totalBits >>> 48) & 0xff;
      bitsBuf[2] = (totalBits >>> 40) & 0xff;
      bitsBuf[3] = (totalBits >>> 32) & 0xff;
      bitsBuf[4] = (totalBits >>> 24) & 0xff;
      bitsBuf[5] = (totalBits >>> 16) & 0xff;
      bitsBuf[6] = (totalBits >>> 8) & 0xff;
      bitsBuf[7] = totalBits & 0xff;
      this.update(bitsBuf);
    }
  };

  Sha256.prototype.digest = function () {
    this.finalize();
    var hash = new Uint8Array(32);
    for (var i = 0; i < 8; i++) {
      hash[i * 4] = (this.state[i] >>> 24) & 0xff;
      hash[i * 4 + 1] = (this.state[i] >>> 16) & 0xff;
      hash[i * 4 + 2] = (this.state[i] >>> 8) & 0xff;
      hash[i * 4 + 3] = this.state[i] & 0xff;
    }
    return hash;
  };

  // Hàm hash SHA-256 đơn
  function sha256(data) {
    return new Sha256().update(data).digest();
  }

  // Hàm hash kép (SHA-256d) – chuẩn cho Bitcoin
  function sha256d(data) {
    return sha256(sha256(data));
  }

  global.sha256 = sha256;
  global.sha256d = sha256d;
})(self);
