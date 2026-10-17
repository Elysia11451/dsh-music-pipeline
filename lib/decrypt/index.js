// lib/decrypt/index.js — 全格式解密统一调度层
//
// v0.2.0 新增。业务代码只认这里一个入口 decrypt()，不用关心文件是 NCM 还是 KGM/QMC/KWM。
// 调度顺序：扩展名精确匹配 → 魔数嗅探（改过后缀名的文件也能解） → 明确报错。
//
// 每个具体解密器遵守同一份契约（见 ncm.js 顶部注释）：
//   FORMATS / LABEL / decryptFile(inputPath, outputPath) -> Promise<Result>
//   其中 Result = {ok, output, format, meta, audioBytes, error?}
//
// 版权声明
//   NCM 之外的解密器（KGM/VPR、QMC 系列、KWM）移植自 OpenConverter
//   (nowa277/OpenConverter, Apache-2.0)，纯 JS 实现，无浏览器依赖。
//   NCM 实现源自 ncmdump (taurusxin/ncmdump, MIT) 的公开算法事实。
//   逐条来源、许可与验证状态见仓库根目录 THIRD_PARTY_NOTICES.md，
//   Apache-2.0 全文副本见 LICENSE-APACHE-2.0.txt。
//   （注：任务原定的 Unlock Music 已被 GitHub DMCA 下架，故未采用。）
'use strict'

import path from 'node:path'
import { sniffAudioFormat } from '../ncm-decryptor.js'
import * as ncm from './ncm.js'
import * as kgm from './kgm.js'
import * as kwm from './kwm.js'
import * as qmc from './qmc.js'

// ── 注册表 ──────────────────────────────────────────────────────────────────

/**
 * 解密器注册表。顺序即探测优先级（同名魔数冲突时先注册者胜）。
 * 新增格式只需要在这里加一行 + 放一个解密器文件，业务代码零改动。
 */
const DECRYPTORS = [ncm, kgm, kwm, qmc]

/** 已支持的全部扩展名（小写带点），按注册表汇总 */
export const SUPPORTED_EXTENSIONS = Array.from(
  new Set(DECRYPTORS.flatMap((d) => d.FORMATS)),
).sort()

/** 扩展名 → 解密器；大小写不敏感 */
const BY_EXT = new Map()
for (const d of DECRYPTORS) {
  for (const ext of d.FORMATS) {
    const key = String(ext).toLowerCase()
    if (!BY_EXT.has(key)) BY_EXT.set(key, d)
  }
}

/** 人类可读的格式清单，日志/README 用 */
export function describeFormats() {
  return DECRYPTORS.map((d) => `${d.LABEL} [${d.FORMATS.join(', ')}]`).join('；')
}

/**
 * 按扩展名找解密器。
 *
 * 既能吃完整路径（/music/a.ncm）也能吃裸扩展名（'.ncm' / 'ncm' / '.NCM'）。
 * 注意：不能简单地「含点就走 path.extname」——`path.extname('.ncm')` 返回空串
 * （POSIX 语义把 '.ncm' 整个当文件名，而不是「无基名的扩展名」），
 * 那样 `.ncm` 会查表失败静默拿到 null。只有含路径分隔符时才需要先取基名。
 *
 * @param {string} extOrPath 扩展名（'.kgm'）或文件路径
 * @returns {object|null} 解密器模块，或 null
 */
export function decryptorFor(extOrPath) {
  let ext = String(extOrPath || '')
  if (ext.includes('/') || ext.includes('\\')) ext = path.extname(ext)
  ext = ext.toLowerCase()
  if (ext && !ext.startsWith('.')) ext = '.' + ext
  return BY_EXT.get(ext) ?? null
}

/** 这个扩展名是否支持解密 */
export function isSupported(extOrPath) {
  return decryptorFor(extOrPath) !== null
}

// ── 魔数嗅探 ────────────────────────────────────────────────────────────────

/** 每种格式的识别魔数；只用于「后缀名不老实」时的兜底，不作为唯一判定 */
const MAGICS = [
  { name: 'ncm', test: (b) => b.length >= 8 && b.subarray(0, 8).toString('latin1') === 'CTENFDAM' },
  // KGM/VPR：16 字节固定头（kgm.js 内导出表比对）
  { name: 'kgm', test: (b) => kgm.sniff(b) },
  // KWM："yeelion-kuwo" 开头，且文件至少 0x400 字节（音频偏移）
  { name: 'kwm', test: (b) => b.length >= 12 && b.subarray(0, 12).toString('ascii') === 'yeelion-kuwo' },
  // QMCv2：头部 STag 容器（QTag/musicex/raw 尾标记需要看文件尾，嗅探层不做）
  { name: 'qmc', test: (b) => b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'STag' },
]

/**
 * 按文件头魔数猜解密器。扩展名对不上时用。
 * @param {Buffer} head 文件头部字节（前 16 字节足够）
 * @returns {object|null}
 */
export function sniffDecryptor(head) {
  if (!head || head.length === 0) return null
  for (const m of MAGICS) {
    try {
      if (m.test(head)) {
        const d = DECRYPTORS.find((x) => x.FORMATS.some((e) => e.toLowerCase().includes(m.name)))
        if (d) return d
      }
    } catch {
      // 某个探测抛异常不影响其他格式，继续试下一个
    }
  }
  return null
}

// ── 元数据归一 ──────────────────────────────────────────────────────────────

/**
 * 把各解密器五花八门的 meta 形状归一成 {title, artist, album, raw}。
 *
 * NCM: {musicName, artist:[[name,id],...], album, format}
 * 其余格式（KGM/QMC/KWM）由各自解密器直接给 {title, artist, album}；
 * 两种形状都吃，缺字段时给空串而不是 undefined——下游重命名逻辑要做字符串拼接。
 *
 * @param {object|null} meta 解密器返回的 meta
 * @param {string} fallbackName 元数据缺失时退回的文件基名
 */
export function normalizeMeta(meta, fallbackName = '') {
  const raw = meta && typeof meta === 'object' ? meta : null
  const fb = String(fallbackName || '').trim()
  if (!raw) return { title: fb, artist: '', album: '', raw: null }

  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
      if (typeof v === 'number') return String(v)
    }
    return ''
  }

  let title = pick('title', 'musicName', 'name', 'audioName')
  let artist = pick('artist', 'artists', 'singer')
  // NCM 的 artist 是 [["方大同",2738]] 这种嵌套数组
  if (Array.isArray(raw.artist)) {
    const names = raw.artist
      .map((a) => (Array.isArray(a) ? a[0] : a))
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((s) => s.trim())
    if (names.length) artist = names.join(' / ')
  }
  const album = pick('album', 'albumName')

  if (!title) title = String(fallbackName || '').trim()
  return { title, artist, album, raw }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 解密一个加密音频文件，落盘成标准音频格式。
 *
 * @param {string} inputPath 源文件（.ncm / .kgm / .qmc0 / ... 或后缀乱填的加密文件）
 * @param {string} outputPath 目标音频路径。可以：
 *        - 无扩展名：按探测格式补（如传入 "/out/歌名" → "/out/歌名.flac"）
 *        - 带扩展名：按给定扩展名输出
 * @returns {Promise<{ok:boolean, output?:string, format?:string,
 *   title?:string, artist?:string, album?:string, meta?:object|null,
 *   audioBytes?:number, error?:string}>}
 */
export async function decrypt(inputPath, outputPath) {
  const input = String(inputPath || '')
  if (input === '') return { ok: false, error: 'decrypt: 输入路径为空' }
  const out = String(outputPath || '')
  if (out === '') return { ok: false, input, error: 'decrypt: 输出路径为空' }

  // 1) 扩展名精确匹配
  let d = decryptorFor(input)

  // 2) 后缀名对不上 → 读文件头魔数兜底。
  //    只读前 0x400 字节：足够覆盖 NCM(8)/KGM(0x2C)/KWM(magic 12)/QMC(STag 4) 的头部判定，
  //    又不会把几十 MB 的歌整个读进内存（readFileSync 无长度参数会全读，必须走 fd）。
  if (!d) {
    try {
      const { openSync, readSync, closeSync } = await import('node:fs')
      const fd = openSync(input, 'r')
      try {
        const head = Buffer.alloc(0x400)
        const n = readSync(fd, head, 0, 0x400, 0)
        d = sniffDecryptor(head.subarray(0, n))
      } finally {
        closeSync(fd)
      }
    } catch (e) {
      return { ok: false, input, error: `无法读取文件：${e?.message ?? e}` }
    }
  }

  if (!d) {
    const ext = path.extname(input).toLowerCase()
    return {
      ok: false,
      input,
      error: `不支持的加密格式 ${ext || '(无扩展名)'}；当前支持：${SUPPORTED_EXTENSIONS.join(', ')}`,
    }
  }

  let r
  try {
    r = await d.decryptFile(input, out)
  } catch (e) {
    return { ok: false, input, error: `${d.LABEL} 解密抛出异常：${e?.message ?? e}` }
  }
  if (!r || !r.ok) {
    return { ok: false, input, error: (r && r.error) || `${d.LABEL} 解密失败` }
  }

  // 3) 统一出口形状：带上归一化后的 title/artist/album
  const base = path.basename(out).replace(/\.[^./\\]+$/, '')
  const meta = normalizeMeta(r.meta, base)
  return {
    ok: true,
    input,
    output: r.output,
    format: r.format,
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    meta: r.meta ?? null,
    audioBytes: r.audioBytes ?? null,
  }
}

/**
 * 便利入口：解密到目标目录，文件名按「{title} - {artist}.{ext}」生成。
 * 调用方自己决定要不要重命名时不要用这个——直接用 decrypt()。
 *
 * @param {string} inputPath 源文件
 * @param {string} outDir 输出目录
 * @returns {Promise<{ok:boolean, output?:string, format?:string, title?:string,
 *   artist?:string, error?:string}>}
 */
export async function decryptToDir(inputPath, outDir) {
  const base = path.basename(String(inputPath || '')).replace(/\.[^./\\]+$/, '')
  const r = await decrypt(inputPath, path.join(String(outDir || ''), base))
  return r
}

/** 从解密后的音频字节猜格式（元数据缺失时的兜底） */
export function sniffFormat(audio) {
  return sniffAudioFormat(audio)
}

export { ncm }
export default {
  decrypt,
  decryptToDir,
  decryptorFor,
  isSupported,
  sniffDecryptor,
  normalizeMeta,
  describeFormats,
  sniffFormat,
  SUPPORTED_EXTENSIONS,
  DECRYPTORS,
}
