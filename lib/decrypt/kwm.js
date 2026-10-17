// lib/decrypt/kwm.js — 酷我 KWM 解密器
//
// 遵守统一解密器契约（见 ncm.js 顶部注释）。
//
// 算法事实与常量表来源
//   移植自 OpenConverter (nowa277/OpenConverter, Apache-2.0) 的 KWM 解码器，
//   其自述基于 davidxuang/MusicDecrypto 的算法事实重新实现。
//   注意：MusicDecrypto 为 LGPL-2.1，且 OpenConverter 的该文件头明确写着
//   "do not copy"——本文件只采纳其公开的算法事实（32 字节循环 XOR 与掩码派生），
//   代码为按 Apache-2.0 上游重写，未复制任何 LGPL 源码。
//   上游 Unlock Music (unlock-music/unlock-music, MIT) 已因 DMCA 被 GitHub 下架，
//   故以 OpenConverter 的 Apache-2.0 实现为移植基准。
//
// 文件布局
//   0x000..0x00A  magic "yeelion-kuwo"（10 字节）
//   0x00A..0x010  6 字节填充
//   0x010..0x014  uint32 LE seed
//   0x014..0x400  保留/填充
//   0x400..end    加密音频（与派生的 32 字节掩码做循环 XOR）
//
// 解密
//   1. seed_decimal = seed 的十进制字符串
//   2. mask[0..len] = seed_decimal 的 ASCII 字节
//   3. mask[len..32] = 0
//   4. mask[i] ^= ROOT[i]（i = 0..31）
//   5. audio[i] ^= mask[(i + offset) % 32]
//
// 常量表由 scripts/gen-decrypt-tables.cjs 从参考实现程序化提取，勿手改。
'use strict'

import { openSync, readSync, writeSync, closeSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { sniffAudioFormat } from '../ncm-decryptor.js'

const CHUNK = 64 * 1024
const AUDIO_OFFSET = 0x400 // 1024
const SEED_OFFSET = 0x10 // 16
const MASK_SIZE = 32

// ── 常量表（自动生成，勿手改） ────────────────────────────────────────────────

export const KWM_MAGIC = new Uint8Array([
  0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d, 0x6b, 0x75, 0x77, 0x6f
])

export const KWM_ROOT = new Uint8Array([
  0x4d, 0x6f, 0x4f, 0x74, 0x4f, 0x69, 0x54, 0x76, 0x49, 0x4e, 0x47, 0x77, 0x64, 0x32, 0x45, 0x36,
  0x6e, 0x30, 0x45, 0x31, 0x69, 0x37, 0x4c, 0x35, 0x74, 0x32, 0x49, 0x6f, 0x4f, 0x6f, 0x4e, 0x6b
])

// ── 掩码派生 ─────────────────────────────────────────────────────────────────

/**
 * 由 seed 派生 32 字节 XOR 掩码。
 * @param {number} seed uint32
 * @returns {Uint8Array} 32 字节
 */
export function buildMask(seed) {
  const decimal = String(seed >>> 0)
  const mask = new Uint8Array(MASK_SIZE)
  const len = Math.min(decimal.length, MASK_SIZE)
  for (let i = 0; i < len; i++) mask[i] = decimal.charCodeAt(i)
  // mask[len..32] 已是 0
  for (let i = 0; i < MASK_SIZE; i++) mask[i] ^= KWM_ROOT[i]
  return mask
}

/**
 * 原地解密一段 KWM 音频。
 * @param {Uint8Array} data 会被改写
 * @param {Uint8Array} mask buildMask 的产物
 * @param {number} startOffset 这段数据在整条音频中的起始偏移
 */
export function decryptChunk(data, mask, startOffset) {
  for (let i = 0; i < data.length; i++) {
    data[i] ^= mask[(startOffset + i) % MASK_SIZE]
  }
}

// ── 格式探测 ─────────────────────────────────────────────────────────────────

/**
 * 从解密后的音频头部猜容器格式。
 * 复用 ncm-decryptor 的 sniffAudioFormat 保持全项目判定一致；
 * 不认识时返回 null（不默认 mp3——那会把失败伪装成成功）。
 * @param {Uint8Array} audio
 * @returns {string|null}
 */
export function inferFormat(audio) {
  if (!audio || audio.length < 4) return null
  const s = sniffAudioFormat(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength))
  return s || null
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 解密 KWM 文件到 outputPath。流式实现，失败不留半截文件。
 * @param {string} inputPath .kwm 文件
 * @param {string} outputPath 目标路径；无扩展名时按探测结果补
 * @returns {Promise<{ok:boolean, output?:string, format?:string, meta?:object|null,
 *   audioBytes?:number, error?:string}>}
 */
export async function decryptFile(inputPath, outputPath) {
  let fd = null
  let outFd = null
  let tmpPath = null
  try {
    const stat = statSync(inputPath)
    if (!stat.isFile()) return { ok: false, input: inputPath, error: 'KWM: 输入不是普通文件' }
    if (stat.size < AUDIO_OFFSET) {
      return { ok: false, input: inputPath, error: `KWM: 文件过短（${stat.size} < ${AUDIO_OFFSET}）` }
    }

    fd = openSync(inputPath, 'r')
    const header = Buffer.alloc(AUDIO_OFFSET)
    if (readSync(fd, header, 0, AUDIO_OFFSET, 0) < AUDIO_OFFSET) {
      return { ok: false, input: inputPath, error: 'KWM: 读取文件头失败' }
    }
    if (!header.subarray(0, KWM_MAGIC.length).equals(Buffer.from(KWM_MAGIC))) {
      return { ok: false, input: inputPath, error: 'KWM: magic 不匹配，不是酷我 KWM 文件' }
    }
    const seed = header.readUInt32LE(SEED_OFFSET)
    const mask = buildMask(seed)

    const outBase = String(outputPath || '')
    if (outBase === '') return { ok: false, input: inputPath, error: 'KWM: 输出路径为空' }
    const hasExt = /\.[^./\\]+$/.test(outBase)
    const dir = outBase.replace(/[\\/][^\\/]*$/, '') || '.'
    mkdirSync(dir, { recursive: true })

    tmpPath = join(dir, `.${basename(outBase)}.kwm-partial`)
    outFd = openSync(tmpPath, 'w')

    const buf = Buffer.alloc(CHUNK)
    let audioOffset = 0
    let filePos = AUDIO_OFFSET
    let probe = Buffer.alloc(0)

    while (filePos < stat.size) {
      const want = Math.min(CHUNK, stat.size - filePos)
      const n = readSync(fd, buf, 0, want, filePos)
      if (n <= 0) break
      const chunk = buf.subarray(0, n)
      decryptChunk(chunk, mask, audioOffset)
      if (probe.length < 16) probe = Buffer.concat([probe, chunk.subarray(0, Math.min(n, 16 - probe.length))])
      writeSync(outFd, chunk, 0, n)
      audioOffset += n
      filePos += n
    }
    closeSync(outFd)
    outFd = null

    if (audioOffset === 0) {
      return { ok: false, input: inputPath, error: 'KWM: 音频段长度为 0' }
    }

    const format = inferFormat(probe)
    if (!format) {
      return {
        ok: false,
        input: inputPath,
        error: 'KWM: 解密后的数据不是可识别的音频流（seed 可能与文件不匹配）',
      }
    }

    const finalPath = hasExt ? outBase : `${outBase}.${format}`
    renameSync(tmpPath, finalPath)
    tmpPath = null
    closeSync(fd)
    fd = null

    // KWM 容器内不嵌歌曲元数据，meta 恒为 null，
    // 由 lib/decrypt/index.js 的 normalizeMeta 回退到文件名。
    return {
      ok: true,
      input: inputPath,
      output: finalPath,
      format,
      meta: null,
      audioBytes: audioOffset,
    }
  } catch (e) {
    return { ok: false, input: inputPath, error: `KWM 解密失败：${e?.message ?? e}` }
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

export const FORMATS = ['.kwm']
export const LABEL = '酷我音乐 KWM'

/** 供魔数嗅探用：这个 Buffer 是不是 KWM（不看后缀） */
export function sniff(buf) {
  try {
    return !!buf && buf.length >= AUDIO_OFFSET && Buffer.from(KWM_MAGIC).equals(buf.subarray(0, KWM_MAGIC.length))
  } catch {
    return false
  }
}

export default { FORMATS, LABEL, decryptFile, sniff, inferFormat, buildMask, decryptChunk }
