// lib/decrypt/qmc.js — QQ音乐 QMC 解密器（V1 / V2 / mflac / mgg / bkc 系列）
//
// 遵守统一解密器契约（见 ncm.js 顶部注释）。
//
// 算法事实与常量表来源
//   移植自 OpenConverter (nowa277/OpenConverter, Apache-2.0) 的 QMC 解码器。
//   QMC 的 ekey 派生链（base64 → Tencent TEA 双层 → RC4 / 掩码）本身来自
//   QQ 音乐客户端的既有实现（Unlock Music / MusicDecrypto 等项目的既有事实）。
//   本文件为 Apache-2.0 许可下的移植实现。
//   上游 Unlock Music (unlock-music/unlock-music, MIT) 已因 DMCA 被 GitHub 下架，
//   故以 OpenConverter 的 Apache-2.0 实现为移植基准。
//
// 三种布局（详见下方 detectKey 注释）
//   V1：整个文件用 32768 字节静态掩码按 (i*i+27)&0xff 派生后 XOR
//   V2：ekey 派生密钥，短于 300 字节用 128 字节压缩掩码，长于 300 用 RC4
//   musicex（QQ音乐 2023+）：尾标记里没有 ekey，必须联网用 Cookie 换取
//
// 重要限制（如实告知调用方）
//   V1 与内嵌 ekey 的 V2 可完全离线解密；musicex 布局必须提供 qqCookie
//   或 ekey，否则返回 ok:false 并说明原因——绝不伪造成功。
//
// 常量表由 scripts/gen-decrypt-tables.cjs 从参考实现程序化提取，勿手改。
'use strict'

import { openSync, readSync, writeSync, closeSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const CHUNK = 64 * 1024
const V1_OFFSET_BOUNDARY = 0x7fff // 32767
const V2_KEY_SIZE = 128
const KEY_COMPRESS_INDEX_OFFSET = 71214
const MAX_EKEY_LEN = 0xffff
const MIN_TAIL_CONTAINER_LEN = 0x20
const EKEY_RE = /^[A-Za-z0-9+/=]+$/
const SEGMENT_SIZE = 5120

/** 扩展名 → 期望的输出格式（仅用于给错误信息一个 hint，实际以嗅探为准） */
export const EXT_MAP_V1 = { '.qmc0': 'mp3', '.qmc3': 'mp3', '.qmcflac': 'flac', '.qmcogg': 'ogg' }
export const EXT_MAP_V2 = {
  '.mflac0': 'flac', '.mflac': 'flac', '.mgg1': 'ogg', '.mgg': 'ogg',
  '.mflac2': 'flac', '.mflac4': 'flac', '.mgg2': 'ogg', '.mgg4': 'ogg', '.mggl': 'ogg',
  '.bkc': 'mp3', '.bkcmp3': 'mp3', '.bkcflac': 'flac', '.bkcogg': 'ogg',
  '.bkcm4a': 'm4a', '.bkcwav': 'wav', '.bkcwma': 'wma', '.bkcape': 'ape',
}

// ── 常量表（自动生成，勿手改） ────────────────────────────────────────────────

export const QMC1_STATIC_BOX = new Uint8Array([
  0x77, 0x48, 0x32, 0x73, 0xde, 0xf2, 0xc0, 0xc8, 0x95, 0xec, 0x30, 0xb2, 0x51, 0xc3, 0xe1, 0xa0,
  0x9e, 0xe6, 0x9d, 0xcf, 0xfa, 0x7f, 0x14, 0xd1, 0xce, 0xb8, 0xdc, 0xc3, 0x4a, 0x67, 0x93, 0xd6,
  0x28, 0xc2, 0x91, 0x70, 0xca, 0x8d, 0xa2, 0xa4, 0xf0, 0x08, 0x61, 0x90, 0x7e, 0x6f, 0xa2, 0xe0,
  0xeb, 0xae, 0x3e, 0xb6, 0x67, 0xc7, 0x92, 0xf4, 0x91, 0xb5, 0xf6, 0x6c, 0x5e, 0x84, 0x40, 0xf7,
  0xf3, 0x1b, 0x02, 0x7f, 0xd5, 0xab, 0x41, 0x89, 0x28, 0xf4, 0x25, 0xcc, 0x52, 0x11, 0xad, 0x43,
  0x68, 0xa6, 0x41, 0x8b, 0x84, 0xb5, 0xff, 0x2c, 0x92, 0x4a, 0x26, 0xd8, 0x47, 0x6a, 0x7c, 0x95,
  0x61, 0xcc, 0xe6, 0xcb, 0xbb, 0x3f, 0x47, 0x58, 0x89, 0x75, 0xc3, 0x75, 0xa1, 0xd9, 0xaf, 0xcc,
  0x08, 0x73, 0x17, 0xdc, 0xaa, 0x9a, 0xa2, 0x16, 0x41, 0xd8, 0xa2, 0x06, 0xc6, 0x8b, 0xfc, 0x66,
  0x34, 0x9f, 0xcf, 0x18, 0x23, 0xa0, 0x0a, 0x74, 0xe7, 0x2b, 0x27, 0x70, 0x92, 0xe9, 0xaf, 0x37,
  0xe6, 0x8c, 0xa7, 0xbc, 0x62, 0x65, 0x9c, 0xc2, 0x08, 0xc9, 0x88, 0xb3, 0xf3, 0x43, 0xac, 0x74,
  0x2c, 0x0f, 0xd4, 0xaf, 0xa1, 0xc3, 0x01, 0x64, 0x95, 0x4e, 0x48, 0x9f, 0xf4, 0x35, 0x78, 0x95,
  0x7a, 0x39, 0xd6, 0x6a, 0xa0, 0x6d, 0x40, 0xe8, 0x4f, 0xa8, 0xef, 0x11, 0x1d, 0xf3, 0x1b, 0x3f,
  0x3f, 0x07, 0xdd, 0x6f, 0x5b, 0x19, 0x30, 0x19, 0xfb, 0xef, 0x0e, 0x37, 0xf0, 0x0e, 0xcd, 0x16,
  0x49, 0xfe, 0x53, 0x47, 0x13, 0x1a, 0xbd, 0xa4, 0xf1, 0x40, 0x19, 0x60, 0x0e, 0xed, 0x68, 0x09,
  0x06, 0x5f, 0x4d, 0xcf, 0x3d, 0x1a, 0xfe, 0x20, 0x77, 0xe4, 0xd9, 0xda, 0xf9, 0xa4, 0x2b, 0x76,
  0x1c, 0x71, 0xdb, 0x00, 0xbc, 0xfd, 0x0c, 0x6c, 0xa5, 0x47, 0xf7, 0xf6, 0x00, 0x79, 0x4a, 0x11
])

export const QMC_SEED_MAP = new Uint8Array([
  0x4a, 0xd6, 0xca, 0x90, 0x67, 0xf7, 0x52, 0x5e, 0x95, 0x23, 0x9f, 0x13, 0x11, 0x7e, 0x47, 0x74,
  0x3d, 0x90, 0xaa, 0x3f, 0x51, 0xc6, 0x09, 0xd5, 0x9f, 0xfa, 0x66, 0xf9, 0xf3, 0xd6, 0xa1, 0x90,
  0xa0, 0xf7, 0xf0, 0x1d, 0x95, 0xde, 0x9f, 0x84, 0x11, 0xf4, 0x0e, 0x74, 0xbb, 0x90, 0xbc, 0x3f,
  0x92, 0x00, 0x09, 0x5b, 0x9f, 0x62, 0x66, 0xa1
])

export const QMC_MIX_KEY_1 = new Uint8Array([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28
])

export const QMC_MIX_KEY_2 = new Uint8Array([
  0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28, 0x23, 0x40, 0x21, 0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59
])

// ── 掩码生成 ─────────────────────────────────────────────────────────────────

/** V1 掩码：32768 字节，由静态盒按 (i*i+27)&0xff 派生 */
export function buildV1Mask() {
  const m = new Uint8Array(32768)
  for (let i = 0; i < 32768; i++) m[i] = QMC1_STATIC_BOX[(i * i + 27) & 0xff]
  return m
}

/**
 * V2 掩码：ekey 压缩到 128 字节后循环成 32768 字节。
 * @param {Uint8Array|Buffer} derivedKey qmcDeriveKey 的产物
 */
export function buildMapMask(derivedKey) {
  const wkey = keyCompress(derivedKey)
  const mask = new Uint8Array(32768)
  for (let i = 0; i < 32768; i++) mask[i] = wkey[i % V2_KEY_SIZE]
  return mask
}

function shiftMix(byte, shift) {
  shift &= 7
  if (shift === 0) return byte
  return ((byte << shift) | (byte >>> shift)) & 0xff
}

/**
 * 把 ekey 压成 128 字节工作密钥。
 * 入参可能是字符串（原始 ekey）也可能是 Buffer/Uint8Array（getMapMask 传入
 * 派生密钥），参考实现用 `ekey[idx]` 同时吃两种——这里必须同样兼容，
 * 对字符串取字符码、对字节数组取字节值，否则 Uint8Array.charCodeAt 不存在直接崩。
 * @param {string|Uint8Array|Buffer} ekey
 * @returns {Uint8Array}
 */
export function keyCompress(ekey) {
  if (!ekey || ekey.length === 0) throw new Error('QMCv2: ekey 为空')
  const isStr = typeof ekey === 'string'
  const n = ekey.length
  const out = new Uint8Array(V2_KEY_SIZE)
  for (let i = 0; i < V2_KEY_SIZE; i++) {
    const idx = (i * i + KEY_COMPRESS_INDEX_OFFSET) % n
    const shift = (idx + 4) % 8
    out[i] = shiftMix(isStr ? ekey.charCodeAt(idx) : ekey[idx], shift)
  }
  return out
}

/** 原地 XOR 一段缓冲，mask 索引按音频全局位置取（超过 32768 取模） */
export function applyMaskRange(buf, mask, start) {
  const len = buf.length
  for (let i = 0; i < len; i++) {
    const idx = start + i
    buf[i] ^= mask[idx < 32768 ? idx : idx % 32768]
  }
}

// ── Tencent TEA 与 ekey 派生 ─────────────────────────────────────────────────

const TEA_DELTA = 0x9e3779b9

class TeaCipher {
  constructor(key, rounds = 64) {
    if (key.length !== 16) throw new Error('TEA: 密钥长度必须是 16 字节')
    if ((rounds & 1) !== 0) throw new Error('TEA: 轮数必须为偶数')
    this.k0 = key[0] << 24 | key[1] << 16 | key[2] << 8 | key[3]
    this.k1 = key[4] << 24 | key[5] << 16 | key[6] << 8 | key[7]
    this.k2 = key[8] << 24 | key[9] << 16 | key[10] << 8 | key[11]
    this.k3 = key[12] << 24 | key[13] << 16 | key[14] << 8 | key[15]
    this.rounds = rounds
  }
  decryptBlock(dst, dstOffset, src, srcOffset) {
    let v0 = (src[srcOffset] << 24 | src[srcOffset + 1] << 16 | src[srcOffset + 2] << 8 | src[srcOffset + 3]) >>> 0
    let v1 = (src[srcOffset + 4] << 24 | src[srcOffset + 5] << 16 | src[srcOffset + 6] << 8 | src[srcOffset + 7]) >>> 0
    let sum = Math.floor(TEA_DELTA * this.rounds / 2) >>> 0
    for (let i = 0; i < this.rounds / 2; i++) {
      v1 = (v1 - ((((v0 << 4) + this.k2) ^ (v0 + sum) ^ ((v0 >>> 5) + this.k3)) >>> 0)) >>> 0
      v0 = (v0 - ((((v1 << 4) + this.k0) ^ (v1 + sum) ^ ((v1 >>> 5) + this.k1)) >>> 0)) >>> 0
      sum = (sum - TEA_DELTA) >>> 0
    }
    dst[dstOffset] = (v0 >>> 24) & 0xff
    dst[dstOffset + 1] = (v0 >>> 16) & 0xff
    dst[dstOffset + 2] = (v0 >>> 8) & 0xff
    dst[dstOffset + 3] = v0 & 0xff
    dst[dstOffset + 4] = (v1 >>> 24) & 0xff
    dst[dstOffset + 5] = (v1 >>> 16) & 0xff
    dst[dstOffset + 6] = (v1 >>> 8) & 0xff
    dst[dstOffset + 7] = v1 & 0xff
  }
}

/**
 * Tencent TEA 解密（带 1 字节 padding + 2 字节 salt + 7 字节零校验的 CBC 变体）。
 * @param {Uint8Array} inBuf
 * @param {Uint8Array} key 16 字节
 * @returns {Uint8Array}
 */
export function decryptTencentTea(inBuf, key) {
  if (inBuf.length % 8 !== 0) throw new Error('TEA: 输入长度必须是 8 的倍数')
  if (inBuf.length < 16) throw new Error('TEA: 输入过短')
  const blk = new TeaCipher(key, 32)
  const tmpBuf = new Uint8Array(8)
  blk.decryptBlock(tmpBuf, 0, inBuf, 0)
  const nPadLen = tmpBuf[0] & 0x7
  const SALT_LEN = 2
  const ZERO_LEN = 7
  const outLen = inBuf.length - 1 - nPadLen - SALT_LEN - ZERO_LEN
  if (outLen < 0) throw new Error('TEA: payload 长度非法')
  const outBuf = new Uint8Array(outLen)
  const ivPrev = new Uint8Array(8)
  const ivCur = Uint8Array.from(inBuf.subarray(0, 8))
  let inBufPos = 8
  let tmpIdx = 1 + nPadLen

  const cryptBlock = () => {
    ivPrev.set(ivCur)
    ivCur.set(inBuf.subarray(inBufPos, inBufPos + 8))
    for (let j = 0; j < 8; j++) tmpBuf[j] ^= ivCur[j]
    blk.decryptBlock(tmpBuf, 0, tmpBuf, 0)
    inBufPos += 8
    tmpIdx = 0
  }

  for (let i = 1; i <= SALT_LEN;) {
    if (tmpIdx < 8) { tmpIdx++; i++ } else cryptBlock()
  }
  let outBufPos = 0
  while (outBufPos < outLen) {
    if (tmpIdx < 8) {
      outBuf[outBufPos++] = tmpBuf[tmpIdx] ^ ivPrev[tmpIdx]
      tmpIdx++
    } else {
      cryptBlock()
    }
  }
  for (let i = 1; i <= ZERO_LEN; i++) {
    if (tmpIdx >= 8) cryptBlock()
    if (tmpBuf[tmpIdx] !== ivPrev[tmpIdx]) throw new Error('TEA: 零校验失败')
    tmpIdx++
  }
  return outBuf
}

/**
 * 解开 `QQMusic EncV2,Key:` 前缀包住的 TEA 双层密钥。
 * @param {Uint8Array} keyBuf
 */
export function decryptV2Key(keyBuf) {
  const head = 'QQMusic EncV2,Key:'
  let match = keyBuf.length >= 18
  if (match) {
    for (let i = 0; i < head.length; i++) {
      if (keyBuf[i] !== head.charCodeAt(i)) { match = false; break }
    }
  }
  if (!match) return keyBuf
  let out = decryptTencentTea(keyBuf.subarray(18), QMC_MIX_KEY_1)
  out = decryptTencentTea(out, QMC_MIX_KEY_2)
  const s = String.fromCharCode(...out)
  const keyDec = Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  if (keyDec.length < 16) throw new Error('EncV2 密钥解码失败')
  return keyDec
}

function simpleMakeKey(salt, length) {
  const keyBuf = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const tmp = Math.tan(salt + i * 0.1)
    keyBuf[i] = (Math.abs(tmp) * 100.0) & 0xff
  }
  return keyBuf
}

/**
 * ekey(base64) → 工作密钥。
 * 派生失败时退回原始 base64 解码结果（与参考实现一致：老版 ekey 没有 EncV2 壳）。
 * @param {string} b64String
 * @returns {Uint8Array}
 */
export function qmcDeriveKey(b64String) {
  let rawDec = Uint8Array.from(atob(b64String), (c) => c.charCodeAt(0))
  if (rawDec.length < 16) return rawDec
  const originalRawDec = Uint8Array.from(rawDec)
  try {
    rawDec = decryptV2Key(rawDec)
    const simpleKey = simpleMakeKey(106, 8)
    const teaKey = new Uint8Array(16)
    for (let i = 0; i < 8; i++) {
      teaKey[i << 1] = simpleKey[i]
      teaKey[(i << 1) + 1] = rawDec[i]
    }
    const sub = decryptTencentTea(rawDec.subarray(8), teaKey)
    const finalKey = new Uint8Array(8 + sub.length)
    finalKey.set(rawDec.subarray(0, 8), 0)
    finalKey.set(sub, 8)
    return finalKey
  } catch {
    return originalRawDec
  }
}

// ── RC4 变体 ─────────────────────────────────────────────────────────────────

class QmcRC4Cipher {
  constructor(key) {
    this.key = key
    this.N = key.length
    this.S = new Uint8Array(this.N)
    for (let i = 0; i < this.N; i++) this.S[i] = i & 0xff
    let j = 0
    for (let i = 0; i < this.N; i++) {
      j = (this.S[i] + j + this.key[i % this.N]) % this.N
      const tmp = this.S[i]; this.S[i] = this.S[j]; this.S[j] = tmp
    }
    this.hash = 1
    for (let i = 0; i < this.N; i++) {
      const value = this.key[i]
      if (!value) continue
      const nextHash = (this.hash * value) >>> 0
      if (nextHash === 0 || nextHash <= this.hash) break
      this.hash = nextHash
    }
  }
  getSegmentKey(id) {
    const seed = this.key[id % this.N]
    if (seed === 0) return 0
    const idx = Math.floor((this.hash / ((id + 1) * seed)) * 100.0)
    return idx % this.N
  }
  /**
   * 解密一段。
   * @param {Uint8Array} buf 会被改写
   * @param {number} offset 这段数据在整条音频中的起始偏移
   */
  decrypt(buf, offset) {
    const S = Uint8Array.from(this.S)
    let toProcess = buf.length
    let processed = 0
    const postProcess = (len) => { toProcess -= len; processed += len; offset += len; return toProcess === 0 }

    if (offset < 128) {
      const len = Math.min(buf.length, 128 - offset)
      for (let i = 0; i < len; i++) buf[processed + i] ^= this.key[this.getSegmentKey(offset + i)]
      if (postProcess(len)) return
    }
    const encSegment = (subBuf, off) => {
      const s = Uint8Array.from(S)
      const skipLen = (off % SEGMENT_SIZE) + this.getSegmentKey(Math.floor(off / SEGMENT_SIZE))
      let j = 0
      let k = 0
      for (let i = -skipLen; i < subBuf.length; i++) {
        j = (j + 1) % this.N
        k = (s[j] + k) % this.N
        const tmp = s[j]; s[j] = s[k]; s[k] = tmp
        if (i >= 0) subBuf[i] ^= s[(s[j] + s[k]) % this.N]
      }
    }
    if (offset % SEGMENT_SIZE !== 0) {
      const len = Math.min(SEGMENT_SIZE - (offset % SEGMENT_SIZE), toProcess)
      encSegment(buf.subarray(processed, processed + len), offset)
      if (postProcess(len)) return
    }
    while (toProcess > SEGMENT_SIZE) {
      encSegment(buf.subarray(processed, processed + SEGMENT_SIZE), offset)
      postProcess(SEGMENT_SIZE)
    }
    if (toProcess > 0) encSegment(buf.subarray(processed), offset)
  }
}

// ── ekey 定位 ────────────────────────────────────────────────────────────────

/**
 * 在 QMCv2 容器里定位 ekey。
 *
 * 返回 null 表示没找到容器标记（调用方应回退到用户提供的 ekey）；
 * 返回 {ekey, audioOffset, audioLen} 或 {format:'musicex', songMid, fileMid, audioOffset, audioLen}。
 * musicex / 无内嵌 ekey 的 STag 会直接抛错并说明原因（绝不伪造成功）。
 *
 * 支持的布局：
 *   STag 头部 — "STag"@0, u32LE ekeyLen@0x14, ekey@0x18, 之后是音频
 *   QTag 尾部 — audio | meta("ekey,songid,ver") | u32BE metaLen | "QTag"
 *   musicex   — audio | tail | u32LE tailSize | ... | "musicex\0"（需联网换 key）
 *   raw 尾部  — audio | ekey | u32LE ekeyLen
 *   STag 尾部 — 最后 4 字节是 "STag"：无内嵌 ekey，抛错
 *
 * @param {Uint8Array} buf 至少 0x18 字节的前缀（调用方保证）
 * @param {number} len 文件总长度
 * @param {(pos:number, size:number)=>Uint8Array} readAt 按位置读取的回调（用于尾部大结构）
 */
export function detectKey(buf, len, readAt) {
  if (len < 0x18) return null

  // 1. STag 在头部（较新客户端：mflac2/mflac4/mgg2/mgg4/mggl）
  if (ascii(buf, 0, 4) === 'STag') {
    const ekeyLen = readU32LE(buf, 0x14)
    const audioOffset = 0x18 + ekeyLen
    if (ekeyLen > 0 && ekeyLen <= MAX_EKEY_LEN && audioOffset < len) {
      const ekey = ascii(buf, 0x18, audioOffset).trim()
      if (EKEY_RE.test(ekey)) return { ekey, audioOffset, audioLen: len - audioOffset }
    }
    return null
  }

  // 2. musicex 尾部（QQ音乐 2023+）：必须用 Cookie 联网换 key
  if (asciiTail(buf, len, 8) === 'musicex\x00') {
    const tailSize = readU32LE(buf, len - 16)
    if (tailSize > 0 && tailSize < len - 16) {
      const tail = readAt(len - 16 - tailSize, tailSize)
      if (tail.length >= 184) {
        const songMid = utf16le(tail, 28, 88).replace(/\0+$/, '')
        const filename = utf16le(tail, 88, 184).replace(/\0+$/, '')
        const fileMid = filename.replace(/\.(mflac|mgg)$/i, '')
        return { format: 'musicex', songMid, fileMid, audioOffset: 0, audioLen: len - 16 - tailSize }
      }
    }
    throw new Error('该文件由新版 QQ 音乐客户端（musicex）加密，未内嵌密钥。请在设置中提供 QQ 音乐 Cookie，或手动粘贴 ekey。')
  }

  // 3. STag 在尾部：容器里没有内嵌 ekey
  if (asciiTail(buf, len, 4) === 'STag' && len >= MIN_TAIL_CONTAINER_LEN) {
    throw new Error('该文件含 STag 但没有内嵌密钥。请在设置中提供 QQ 音乐 Cookie，或降级客户端版本。')
  }

  // 4. QTag 尾部："<ekey>,<songid>,<version>" + 大端长度
  if (asciiTail(buf, len, 4) === 'QTag') {
    const metaLen = readU32BE(buf, len - 8)
    if (metaLen > 0 && metaLen < len - 8) {
      const audioLen = len - 8 - metaLen
      const rawMeta = ascii(buf, audioLen, len - 8)
      const ekey = rawMeta.split(',')[0].trim()
      if (ekey && EKEY_RE.test(ekey)) return { ekey, audioOffset: 0, audioLen }
    }
    return null
  }

  // 5. 原始 ekey 尾部：ekey 字节 + 小端长度
  const rawLen = readU32LE(buf, len - 4)
  if (rawLen > 0 && rawLen <= MAX_EKEY_LEN && rawLen < len - 4) {
    const audioLen = len - 4 - rawLen
    const ekey = ascii(buf, audioLen, len - 4).trim()
    if (EKEY_RE.test(ekey)) return { ekey, audioOffset: 0, audioLen }
  }
  return null
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

function ascii(buf, from, to) {
  let s = ''
  for (let i = from; i < to && i < buf.length; i++) s += String.fromCharCode(buf[i])
  return s
}

function asciiTail(buf, len, n) {
  return ascii(buf, len - n, len)
}

function utf16le(buf, from, to) {
  let s = ''
  for (let i = from; i + 1 < to && i + 1 < buf.length; i += 2) {
    s += String.fromCharCode(buf[i] | (buf[i + 1] << 8))
  }
  return s
}

function readU32LE(buf, pos) {
  return ((buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0)
}

function readU32BE(buf, pos) {
  return (((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0)
}

/**
 * 从解密后的音频头部猜容器格式（与 ncm/kgm/kwm 保持同一套判定）。
 * @param {Uint8Array} audio
 * @returns {string|null}
 */
export function detectAudioFormat(audio) {
  if (!audio || audio.length < 4) return null
  if (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) return 'mp3'
  if (audio[0] === 0x66 && audio[1] === 0x4c && audio[2] === 0x61 && audio[3] === 0x43) return 'flac'
  if (audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53) return 'ogg'
  if (audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46) return 'wav'
  if (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return 'mp3'
  if (audio.length >= 8 && audio[4] === 0x66 && audio[5] === 0x74 && audio[6] === 0x79 && audio[7] === 0x70) return 'm4a'
  return null
}

/** 供魔数嗅探用：这个 Buffer 是不是 QMC（按扩展名之外的特征——头部 STag） */
export function sniff(buf) {
  try {
    return !!buf && buf.length >= 4 && ascii(buf, 0, 4) === 'STag'
  } catch {
    return false
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 解密 QMC 文件到 outputPath。流式实现，失败不留半截文件。
 *
 * @param {string} inputPath .qmc / .mflac / .mgg / .bkc 系列文件
 * @param {string} outputPath 目标路径；无扩展名时按探测结果补
 * @param {{ekey?:string, qqCookie?:string}} [opts]
 *   ekey      手动提供的 ekey（musicex 布局或容器无内嵌 key 时用）
 *   qqCookie  仅 musicex 布局需要；本实现**不联网**，传了也只会给出明确错误
 * @returns {Promise<{ok:boolean, output?:string, format?:string, meta?:object|null,
 *   audioBytes?:number, error?:string}>}
 */
export async function decryptFile(inputPath, outputPath, opts = {}) {
  let fd = null
  let outFd = null
  let tmpPath = null
  try {
    const stat = statSync(inputPath)
    if (!stat.isFile()) return { ok: false, input: inputPath, error: 'QMC: 输入不是普通文件' }
    const fileLen = stat.size
    if (fileLen < 0x18) return { ok: false, input: inputPath, error: `QMC: 文件过短（${fileLen} < 0x18）` }

    fd = openSync(inputPath, 'r')

    const outBase = String(outputPath || '')
    if (outBase === '') return { ok: false, input: inputPath, error: 'QMC: 输出路径为空' }
    const hasExt = /\.[^./\\]+$/.test(outBase)
    const dir = outBase.replace(/[\\/][^\\/]*$/, '') || '.'
    mkdirSync(dir, { recursive: true })

    const readAt = (pos, size) => {
      const b = Buffer.alloc(size)
      const n = readSync(fd, b, 0, size, pos)
      return n < size ? b.subarray(0, n) : b
    }

    // detectKey 会对 [0,len) 任意位置做 `buf[i]` 逐字节索引（头部的 STag/ekey、
    // 尾部的 QTag/musicex/raw 标记）。整文件读进内存对几十 MB 的歌太浪费，
    // 但它实际只碰头 ~64KB 与尾 ~64KB（ekeyLen/metaLen/rawLen 上限都是 0xffff）。
    // 所以构造一个只读 head+tail 的 Proxy 视图：length 报真实文件长，
    // buf[i] 按需从两段缓存里取；越界返回 undefined，detectKey 的 EKEY_RE
    // 校验自然失败并回退到 opts.ekey —— 与「未找到内嵌 key」语义一致。
    const WINDOW = 0x20000 // 128KB，覆盖 0xffff 上限 + 头部余量
    const headBuf = readAt(0, Math.min(WINDOW, fileLen))
    const tailStart = Math.max(0, fileLen - WINDOW)
    const tailBuf = tailStart > 0 ? readAt(tailStart, fileLen - tailStart) : null
    const detectBuf = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'length') return fileLen
        if (prop === 'subarray') {
          return (a, b) => {
            const end = Math.min(b === undefined ? fileLen : b, fileLen)
            const out = Buffer.alloc(Math.max(0, end - a))
            for (let i = a; i < end; i++) out[i - a] = readByte(i)
            return out
          }
        }
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return readByte(Number(prop))
        return undefined
      },
    })
    function readByte(i) {
      if (i < headBuf.length) return headBuf[i]
      if (tailBuf && i >= tailStart) return tailBuf[i - tailStart]
      return undefined
    }

    // 布局判据（与上游 decodeFile 完全一致）：
    //   只有扩展名命中 EXT_MAP_V2 才走 V2（ekey 派生）；其余一律走 V1 静态掩码。
    // 注意不能反过来写成「命中 EXT_MAP_V1 才算 V1」——上游对 .tkm/.tm0/.tm3/.qmc2
    // 这类不在任一表里的扩展名是**默认按 V1** 处理的；写反了会把它们错误路由到 V2，
    // 然后因为找不到容器标记而误报「无内嵌密钥」。
    const ext = extname(inputPath).toLowerCase()
    const isV2 = Object.prototype.hasOwnProperty.call(EXT_MAP_V2, ext)
    const isV1 = !isV2

    let detected = null
    if (isV2) detected = detectKey(detectBuf, fileLen, readAt)
    let ekey
    let audioOffset = 0
    let audioLen = fileLen

    if (isV1) {
      // V1：无需 ekey，全文件解密
    } else if (detected) {
      if (detected.format === 'musicex') {
        return {
          ok: false,
          input: inputPath,
          error:
            '该文件是 musicex 布局（QQ音乐 2023+ 客户端），密钥需联网用 Cookie 换取，本插件不联网。' +
            '请手动获取 ekey 后通过 opts.ekey 传入，或改用其他客户端下载。',
        }
      }
      ekey = detected.ekey
      audioOffset = detected.audioOffset
      audioLen = detected.audioLen
    } else if (opts.ekey) {
      ekey = String(opts.ekey).trim()
    } else {
      return {
        ok: false,
        input: inputPath,
        error: '未在该 QMCv2 文件里找到内嵌 ekey。请在设置中粘贴 ekey，或提供 Cookie 以便联网换取。',
      }
    }

    let decryptChunk
    if (isV1) {
      const mask = buildV1Mask()
      decryptChunk = (chunk, start) => applyMaskRange(chunk, mask, start)
    } else {
      const derivedKey = qmcDeriveKey(ekey)
      if (derivedKey.length > 300) {
        const rc4 = new QmcRC4Cipher(derivedKey)
        decryptChunk = (chunk, start) => rc4.decrypt(chunk, start)
      } else {
        const mask = buildMapMask(derivedKey)
        decryptChunk = (chunk, start) => applyMaskRange(chunk, mask, start)
      }
    }

    tmpPath = join(dir, `.${basename(outBase)}.qmc-partial`)
    outFd = openSync(tmpPath, 'w')
    const buf = Buffer.alloc(CHUNK)
    let offset = 0
    let probe = Buffer.alloc(0)
    while (offset < audioLen) {
      const want = Math.min(CHUNK, audioLen - offset)
      const n = readSync(fd, buf, 0, want, audioOffset + offset)
      if (n <= 0) break
      const slice = buf.subarray(0, n)
      decryptChunk(slice, offset)
      if (probe.length < 16) probe = Buffer.concat([probe, slice.subarray(0, Math.min(n, 16 - probe.length))])
      writeSync(outFd, slice, 0, n)
      offset += n
    }
    closeSync(outFd)
    outFd = null

    if (offset === 0) return { ok: false, input: inputPath, error: 'QMC: 音频段长度为 0' }

    const format = detectAudioFormat(probe)
    if (!format) {
      return {
        ok: false,
        input: inputPath,
        error: 'QMC 解密失败：解密后的数据不是可识别的音频流。ekey / Cookie 可能已过期或不匹配。',
      }
    }

    const finalPath = hasExt ? outBase : `${outBase}.${format}`
    renameSync(tmpPath, finalPath)
    tmpPath = null
    closeSync(fd)
    fd = null

    // QMC 容器内不嵌歌曲元数据，meta 恒为 null，
    // 由 lib/decrypt/index.js 的 normalizeMeta 回退到文件名。
    return { ok: true, input: inputPath, output: finalPath, format, meta: null, audioBytes: offset }
  } catch (e) {
    return { ok: false, input: inputPath, error: `QMC 解密失败：${e?.message ?? e}` }
  } finally {
    if (outFd != null) {
      try { closeSync(outFd) } catch {}
    }
    if (fd != null) {
      try { closeSync(fd) } catch {}
    }
    if (tmpPath != null) {
      try { unlinkSync(tmpPath) } catch {}
    }
  }
}

export const FORMATS = ['.qmc0', '.qmc3', '.qmcflac', '.qmcogg', '.qmc2', '.qmc3a', '.tkm', '.tm0', '.tm3', '.mflac', '.mflac0', '.mflac2', '.mflac4', '.mgg', '.mgg1', '.mgg2', '.mgg4', '.mggl', '.bkc', '.bkcmp3', '.bkcflac', '.bkcogg', '.bkcm4a', '.bkcwav', '.bkcwma', '.bkcape']
export const LABEL = 'QQ音乐 QMC/mflac/mgg'

export default { FORMATS, LABEL, decryptFile, sniff, detectKey, qmcDeriveKey, buildV1Mask, buildMapMask, decryptTencentTea }
