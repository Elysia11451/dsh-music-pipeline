// lib/decrypt/ncm.js — NCM 解密器适配层
//
// 真实解密逻辑在 ../ncm-decryptor.js（v0.1.0 就已内置、真卡 E2E 验证过），
// 这里只做「统一解密器契约」的适配，避免两套 NCM 实现漂移。
//
// 解密器契约（lib/decrypt/*.js 全部遵守）：
//   export const FORMATS   // 负责的扩展名数组，小写带点，如 ['.ncm']
//   export const LABEL     // 人类可读的格式名，用于日志/报错
//   export function decryptFile(inputPath, outputPath) -> Promise<Result>
//   Result = {ok, output, format, meta, audioBytes, error?}
//     ok        是否成功
//     output    落盘的音频文件绝对路径
//     format    小写扩展名（不含点）：flac / mp3 / ogg / m4a / wav
//     meta      解密器给出的元数据（可为 null）；lib/decrypt/index.js 会归一成
//               {title, artist, album, raw}
//     audioBytes 音频字节数
//     error     失败原因（ok=false 时）
//
// 源：算法事实与常量表来自 ncmdump (taurusxin/ncmdump, MIT)，
//      参考 Unlock Music (unlock-music/unlock-music, MIT)。
'use strict'

import { decryptNcmToFile, isNcm } from '../ncm-decryptor.js'

export const FORMATS = ['.ncm']
export const LABEL = '网易云音乐 NCM'

/**
 * @param {string} inputPath .ncm 文件
 * @param {string} outputPath 目标音频路径（可无扩展名，按探测格式补）
 */
export async function decryptFile(inputPath, outputPath) {
  const r = await decryptNcmToFile(inputPath, outputPath)
  if (!r.ok) return r
  // 把 NCM 的 {musicName, artist:[[name,id],...]} 形状保留原样交给 index.js 归一，
  // 这里只补一个 format 保证字段齐全
  return {
    ok: true,
    output: r.output,
    format: r.format,
    meta: r.meta ?? null,
    audioBytes: r.audioBytes,
  }
}

/** 供探测用：这个 Buffer 是不是 NCM（按 magic 判定，不看后缀） */
export function sniff(buf) {
  try {
    return isNcm(buf)
  } catch {
    return false
  }
}

export default { FORMATS, LABEL, decryptFile, sniff }
