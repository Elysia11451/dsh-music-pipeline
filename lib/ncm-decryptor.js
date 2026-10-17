// lib/ncm-decryptor.js — 网易云音乐 .ncm 解密核心（内置，零第三方依赖）
//
// 把「NCM 容器 → 原始 FLAC/MP3」的解密逻辑直接内嵌进插件，
// 不再依赖 dsh-audio-converter 或任何 npm 包，只使用 Node 内置 node:crypto。
//
// 算法来源与许可
//   - 算法事实与常量表：ncmdump (taurusxin/ncmdump, MIT)
//     https://github.com/taurusxin/ncmdump
//   - 补充参考：Unlock Music (unlock-music/unlock-music, MIT)
//     https://github.com/unlock-music/unlock-music
//   - 格式细节分析：manalogues《NCM文件的加解密笔记》(CC BY 4.0)、
//     博客园 chuyaoxin《网易云音乐 ncm 格式分析》
//   本文件为独立实现，仅引用上述公开算法事实（两层加密结构与固定密钥），
//   未复制任何第三方源码文件。
//
// NCM 容器结构（偏移均为字节）
//   0      8    magic "CTENFDAM"
//   8      2    固定 0x0170
//   10     4    音频密钥长度（小端），目前固定 128
//   14     128  音频密钥密文：逐字节 XOR 0x64 → AES-128-ECB 解密 → 去掉 17 字节前缀
//   142    4    元数据长度（小端）
//   146    N    元数据密文：逐字节 XOR 0x63 → 去掉 22 字节前缀 → Base64 → AES-128-ECB
//        4     封面 CRC32（不校验）
//        5     未知（跳过）
//        4     封面长度（小端）
//        N     封面图片原始字节（未加密）
//        余    音频数据：与一段固定 256 字节密钥流异或
//
// 关键简化：音频密钥流只由「下标对 256 取模」决定，
// 因此整段音频的密钥流是一张固定的 256 字节表，可按任意块大小流式解密。
//
// @module dsh-music-pipeline/lib/ncm-decryptor
'use strict'

import { createDecipheriv } from 'node:crypto'

/** magic：CTENFDAM */
const MAGIC = Buffer.from('4354454E4644414D', 'hex')
/** 音频密钥（AES-128-ECB 密钥，所有 ncm 文件共用）= "hzHRAmso5kInbaxW" */
const CORE_KEY = Buffer.from('687A4852416D736F356B496E62617857', 'hex')
/** 元数据密钥 = "#14ljk_!\]&0U<'(" */
const META_KEY = Buffer.from('2331346C6A6B5F215C5D2630553C2728', 'hex')
/** 元数据明文前缀，解密后要去掉 */
const META_PREFIX = Buffer.from("163 key(Don't modify):", 'ascii')
/** 音频密钥明文前缀长度："neteasecloudmusic" */
const KEY_PREFIX_LEN = 17
/** 元数据 JSON 前缀长度："music:" */
const META_JSON_PREFIX_LEN = 6
/** 读块大小。固定密钥流下块大小不影响结果，这里只照顾 I/O */
const CHUNK = 0x8000

/** 这个 Buffer 是不是 NCM。只看 magic，不看后缀。 */
export function isNcm(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 16 && buf.subarray(0, 8).equals(MAGIC)
}

/**
 * AES-128-ECB 解密，关闭自动去填充（NCM 的填充由我们自己按 PKCS#7 处理）。
 * @param {Buffer} key 16 字节密钥
 * @param {Buffer} data 密文，长度须为 16 的倍数
 * @returns {Buffer} 明文（含填充）
 */
function aesEcbDecrypt(key, data) {
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(data), d.final()])
}

/** 去掉 PKCS#7 填充。填充非法时原样返回，不静默截错。 */
function unpad(buf) {
  if (buf.length === 0) return buf
  const n = buf[buf.length - 1]
  if (n < 1 || n > 16 || n > buf.length) return buf
  return buf.subarray(0, buf.length - n)
}

/**
 * 用音频密钥构建 RC4 KSA 变体的 256 字节 S 盒。
 * @param {Buffer|Uint8Array} key 音频密钥
 * @returns {Uint8Array} 256 字节 S 盒
 */
export function buildKeyBox(key) {
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i++) box[i] = i
  const keyLen = key.length
  if (keyLen === 0) throw new Error('音频密钥为空')
  let c = 0
  let lastByte = 0
  let keyOffset = 0
  for (let i = 0; i < 256; i++) {
    const swap = box[i]
    c = (swap + lastByte + key[keyOffset]) & 0xff
    keyOffset += 1
    if (keyOffset >= keyLen) keyOffset = 0
    box[i] = box[c]
    box[c] = swap
    lastByte = c
  }
  return box
}

/**
 * 把 S 盒折成 256 字节密钥流表。
 * 原式：第 n 个字节（n 从 1 开始）异或 box[box[j] + box[(box[j]+j)&0xff] & 0xff]，j = n & 0xff。
 * @param {Uint8Array} box 256 字节 S 盒
 * @returns {Uint8Array} 256 字节密钥流
 */
export function buildKeystream(box) {
  const ks = new Uint8Array(256)
  for (let j = 0; j < 256; j++) {
    const bj = box[j]
    const inner = box[(bj + j) & 0xff]
    ks[j] = box[(bj + inner) & 0xff]
  }
  return ks
}

/**
 * 就地解密一段音频。
 * @param {Uint8Array} ks 256 字节密钥流
 * @param {Uint8Array} data 密文（会被就地修改）
 * @param {number} offset 这段数据在整段音频里的起始偏移（0 开始）
 */
export function xorAudio(ks, data, offset = 0) {
  for (let i = 0; i < data.length; i++) data[i] ^= ks[(offset + i + 1) & 0xff]
  return data
}

/**
 * 解析 NCM 的元数据段与封面段。
 * @param {Buffer} buf 整个文件
 * @param {number} pos 元数据长度字段的偏移
 * @returns {{meta: object|null, cover: Buffer|null, audioOffset: number, error?: string}}
 */
function readMetaAndCover(buf, pos) {
  let meta = null
  let cover = null
  try {
    const metaLen = buf.readUInt32LE(pos); pos += 4
    if (metaLen > 0 && pos + metaLen <= buf.length) {
      const raw = Buffer.from(buf.subarray(pos, pos + metaLen))
      for (let i = 0; i < raw.length; i++) raw[i] ^= 0x63
      const body = raw.subarray(META_PREFIX.length)
      const cipher = Buffer.from(body.toString('ascii'), 'base64')
      const plain = unpad(aesEcbDecrypt(META_KEY, cipher))
      meta = JSON.parse(plain.subarray(META_JSON_PREFIX_LEN).toString('utf8'))
    }
    pos += metaLen
  } catch (error) {
    return { meta: null, cover: null, audioOffset: -1, error: `元数据解析失败：${error?.message ?? error}` }
  }
  // 4 字节 CRC32 + 5 字节未知 + 4 字节封面长度 + 封面数据
  pos += 4
  pos += 5
  try {
    const coverLen = buf.readUInt32LE(pos); pos += 4
    if (coverLen > 0 && pos + coverLen <= buf.length) cover = Buffer.from(buf.subarray(pos, pos + coverLen))
    pos += coverLen
  } catch (error) {
    return { meta, cover: null, audioOffset: -1, error: `封面解析失败：${error?.message ?? error}` }
  }
  return { meta, cover, audioOffset: pos }
}

/**
 * 解密一个 NCM 文件的内容。
 *
 * 音频是流式解密的：只把音频段解密到内存，封面和元数据单独返回。
 * （一首歌动辄几十 MB，全量复制没有必要。）
 *
 * @param {Buffer} buf 完整文件内容
 * @returns {{audio: Buffer, format: string|null, meta: object|null, cover: Buffer|null, keyLength: number}}
 */
export function decryptNcm(buf) {
  if (!isNcm(buf)) throw new Error('不是 NCM 文件（magic 不匹配）')
  if (buf.length < 16) throw new Error('NCM 文件过短')

  // ── 1. 音频密钥 ──
  let pos = 10
  const keyLen = buf.readUInt32LE(pos); pos += 4
  if (keyLen <= 0 || keyLen > 1024 || pos + keyLen > buf.length) {
    throw new Error(`音频密钥长度异常：${keyLen}`)
  }
  const keyCipher = Buffer.from(buf.subarray(pos, pos + keyLen))
  pos += keyLen
  for (let i = 0; i < keyCipher.length; i++) keyCipher[i] ^= 0x64
  const audioKey = unpad(aesEcbDecrypt(CORE_KEY, keyCipher)).subarray(KEY_PREFIX_LEN)
  if (audioKey.length === 0) throw new Error('音频密钥为空（核心密钥不匹配？）')

  // ── 2. 元数据与封面 ──
  const { meta, cover, audioOffset, error: metaError } = readMetaAndCover(buf, pos)
  if (audioOffset < 0 || audioOffset > buf.length) {
    throw new Error(metaError ?? '音频起始位置解析失败')
  }

  // ── 3. 音频 ──
  const ks = buildKeystream(buildKeyBox(audioKey))
  const audioLen = buf.length - audioOffset
  const audio = Buffer.allocUnsafe(audioLen)
  for (let done = 0; done < audioLen; done += CHUNK) {
    const end = Math.min(done + CHUNK, audioLen)
    for (let i = done; i < end; i++) audio[i] = buf[audioOffset + i] ^ ks[(i + 1) & 0xff]
  }

  return {
    audio,
    format: typeof meta?.format === 'string' ? meta.format.toLowerCase() : null,
    meta,
    cover,
    keyLength: keyLen,
  }
}

/**
 * 从音频字节猜格式（元数据缺失时兜底）。
 * @param {Buffer} audio 解密后的音频
 * @returns {string|null} 'flac' | 'mp3' | 'ogg' | 'm4a' | 'wav' | null
 */
export function sniffAudioFormat(audio) {
  if (!audio || audio.length < 12) return null
  if (audio.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
  if (audio.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
  if (audio.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a'
  if (audio.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3'
  if (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return 'mp3'
  if (audio.subarray(0, 4).toString('ascii') === 'RIFF') return 'wav'
  return null
}

/**
 * 主入口：把 NCM 文件解密成 FLAC/MP3 并落盘。
 *
 * 不做转码、不嵌封面、不写标签——纯解密拷贝，因此完全不需要 ffmpeg。
 * 目标文件名由调用方决定（保留原有重命名逻辑）。
 *
 * @param {string} inputPath .ncm 文件路径
 * @param {string} outputPath 输出音频文件路径（不含扩展名时按探测格式补）
 * @returns {Promise<{ok: boolean, output?: string, format?: string, meta?: object|null,
 *   audioBytes?: number, error?: string}>}
 */
export async function decryptNcmToFile(inputPath, outputPath) {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { dirname, extname } = await import('node:path')
  try {
    const buf = readFileSync(inputPath)
    const r = decryptNcm(buf)
    if (!r.audio || r.audio.length === 0) return { ok: false, input: inputPath, error: '解密出的音频为空' }
    const fmt = r.format ?? sniffAudioFormat(r.audio)
    if (!fmt) return { ok: false, input: inputPath, error: '无法识别解密后的音频格式' }

    // 调用方给了无扩展名的路径时，按探测格式补上
    let out = outputPath
    if (!extname(out)) out = `${out}.${fmt}`

    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, r.audio)
    return {
      ok: true,
      input: inputPath,
      output: out,
      format: fmt,
      meta: r.meta ?? null,
      audioBytes: r.audio.length,
    }
  } catch (error) {
    return { ok: false, input: inputPath, error: error?.message ?? String(error) }
  }
}

export const NCM_CONSTANTS = { MAGIC, CORE_KEY, META_KEY, META_PREFIX, KEY_PREFIX_LEN, META_JSON_PREFIX_LEN, CHUNK }

export default { isNcm, decryptNcm, decryptNcmToFile, sniffAudioFormat, buildKeyBox, buildKeystream, xorAudio, NCM_CONSTANTS }
