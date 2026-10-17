#!/usr/bin/env node
// NCM 自动转换（内置纯解密，零第三方插件依赖、无需 ffmpeg）
// 流程：扫描目录 .ncm → 内置解密出 FLAC/MP3 → 重命名「{歌曲名} - {艺术家}.{ext}」→ 原 .ncm 移入 已处理NCM（保留不删除）
// 用法：
//   node ncm-auto-convert.mjs                                          # 正式跑
//   node ncm-auto-convert.mjs --dir D --out O --no-archive             # 测试跑（不归档）
//   NCM_MANIFEST=... node ncm-auto-convert.mjs                         # 环境变量覆盖
import { readdirSync, statSync, renameSync, mkdirSync, existsSync, unlinkSync, appendFileSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
// 解密器随插件一起打包在 lib/ 下（相对本脚本的上一级），不再依赖外部目录
import { decryptNcmToFile } from '../lib/ncm-decryptor.js'

// 路径全部可配置：命令行参数 > 环境变量 > 中性默认值（不绑定任何具体机器）。
// 默认值刻意只用到 home 目录与标准 Android 下载目录，不含设备专属数据路径。
const HOME = homedir()
const argv = process.argv.slice(2)
const argOf = (name, env, def) => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  if (process.env[env]) return process.env[env]
  return def
}
const DEF_DOWNLOAD = '/storage/emulated/0/Download/netease/cloudmusic/Music'
const DEF_STAGING = '/storage/emulated/0/Download/准备传输'
const MUSIC_DIR = argOf('--dir', 'NCM_MUSIC_DIR', DEF_DOWNLOAD)
const OUT_DIR = argOf('--out', 'NCM_STAGING_DIR', DEF_STAGING)
const MANIFEST = argOf('--manifest', 'NCM_MANIFEST', join(HOME, 'ncm-manifest.jsonl'))
const NO_ARCHIVE = argv.includes('--no-archive')
const ARCHIVE_DIR = argOf('--archive', 'NCM_ARCHIVE_DIR', join(MUSIC_DIR, '已处理NCM'))

mkdirSync(OUT_DIR, { recursive: true })
if (!NO_ARCHIVE) mkdirSync(ARCHIVE_DIR, { recursive: true })

const files = existsSync(MUSIC_DIR) ? readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.ncm')) : []
if (files.length === 0) {
  console.log(JSON.stringify({ scanned: MUSIC_DIR, found: 0, processed: [], note: '没有 .ncm 文件（继续检查原生 FLAC）' }, null, 2))
}

const rows = []
for (const f of files) {
  const input = join(MUSIC_DIR, f)
  const row = { file: f }
  try {
    // 内置解密：纯字节级还原，不做转码、不嵌封面、不写标签，因此不需要 ffmpeg
    // 先解到 OUT_DIR 下的临时名，拿到 meta 后再按「歌曲名 - 艺术家」重命名
    const tmpPath = join(OUT_DIR, '.' + f.replace(/\.ncm$/i, '') + '.tmp')
    const r = await decryptNcmToFile(input, tmpPath)
    if (!r.ok) { row.status = 'failed'; row.error = r.error; rows.push(row); continue }
    if (r.format !== 'flac') {
      // 原版 dsh-audio-converter 的转码能力已不在链路内：非 FLAC 只标记，不删源、不归档
      row.status = 'needs-transcode'
      row.error = '源内容是 ' + r.format + '，内置解密不做转码；已输出 ' + r.output + '，原 .ncm 未归档'
      try { unlinkSync(r.output) } catch {}
      rows.push(row); continue
    }
    // 元数据字段从内置解密的 musicName/artist[0][0] 归一成 title/artist，保持下面重命名逻辑不变
    const meta = r.meta || {}
    const artists = Array.isArray(meta.artist) && Array.isArray(meta.artist[0]) ? meta.artist.map(a => a[0]).join(' / ') : (meta.artist || '')
    meta.title = String(meta.musicName || meta.title || '').trim()
    meta.artist = artists
    // 文件名安全：元数据可能含 /（多人合作歌手常见 "A / B"）等非法路径字符，统一替换为 _
    const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '_')
    const title = safe(String(meta.title || '').trim())
    const artist = safe(String(meta.artist || '').trim())
    let finalPath = r.output
    if (title && artist) {
      const target = join(OUT_DIR, title + ' - ' + artist + '.' + r.format)
      if (target !== r.output) {
        if (existsSync(target)) {
          if (statSync(target).size === statSync(r.output).size) {
            try { unlinkSync(r.output) } catch {}
          } else {
            row.status = 'conflict'; row.error = '目标已存在且大小不同，未覆盖：' + target
            rows.push(row); continue
          }
        } else {
          renameSync(r.output, target)
        }
        finalPath = target
      }
    } else {
      // 元数据缺歌名/歌手时退回原文件名，别把 .xxx.tmp.flac 这种临时名留在暂存区
      const target = join(OUT_DIR, f.replace(/\.ncm$/i, '') + '.' + r.format)
      if (existsSync(target)) {
        if (statSync(target).size === statSync(r.output).size) {
          try { unlinkSync(r.output) } catch {}
        } else {
          row.status = 'conflict'; row.error = '目标已存在且大小不同，未覆盖：' + target
          rows.push(row); continue
        }
      } else {
        renameSync(r.output, target)
      }
      finalPath = target
    }
    row.output = finalPath
    if (NO_ARCHIVE) { row.status = 'converted'; row.note = '测试模式：原文件未归档'; rows.push(row); continue }
    const arc = join(ARCHIVE_DIR, f)
    if (existsSync(arc)) { row.status = 'converted'; row.note = '归档目标已存在，未移动'; rows.push(row); continue }
    renameSync(input, arc)
    row.status = 'ok'; row.archived = arc
    // 写转换清单：flac↔ncm 精确对应（传输脚本删 NCM 时按此匹配，不按文件名猜）
    if (finalPath) {
      try {
        appendFileSync(MANIFEST,
          JSON.stringify({ flac: basename(finalPath), ncm: f, ts: new Date().toISOString() }) + '\n')
      } catch (e) { row.manifestWarn = String(e && e.message ? e.message : e) }
    }
    rows.push(row)
  } catch (e) {
    row.status = 'error'; row.error = String(e && e.message ? e.message : e)
    rows.push(row)
  }
}
// 原生 FLAC 直通：下载目录里本来就是 .flac 的文件，直接复制进准备传输（卡上去重由传输脚本负责）
const nativeRows = []
try {
  for (const f of readdirSync(MUSIC_DIR)) {
    if (!f.toLowerCase().endsWith('.flac')) continue
    const src = join(MUSIC_DIR, f)
    const dst = join(OUT_DIR, f)
    if (existsSync(dst)) {
      if (statSync(dst).size === statSync(src).size) nativeRows.push({ file: f, status: 'skipped', note: '准备传输已有同名同大小' })
      else nativeRows.push({ file: f, status: 'conflict', note: '准备传输已有同名不同大小，未覆盖' })
      continue
    }
    try {
      copyFileSync(src, dst)
      appendFileSync(MANIFEST,
        JSON.stringify({ flac: f, ncm: null, src: 'native', ts: new Date().toISOString() }) + '\n')
      nativeRows.push({ file: f, status: 'native-copied', output: dst })
    } catch (e) { nativeRows.push({ file: f, status: 'error', error: String(e && e.message ? e.message : e) }) }
  }
} catch {}
console.log(JSON.stringify({ scanned: MUSIC_DIR, found: files.length, processed: rows, native: nativeRows }, null, 2))
process.exit(rows.some(x => x.status !== 'ok' && x.status !== 'converted') || nativeRows.some(x => x.status === 'error' || x.status === 'conflict') ? 1 : 0)
