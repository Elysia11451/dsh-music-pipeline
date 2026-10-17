#!/usr/bin/env node
// 多格式加密音频自动转换（内置纯 JS 解密，零第三方依赖）
//
// v0.2.0：从「只处理 .ncm」升级为「全格式」——扫描目录里所有受支持的加密格式
// （.ncm / .kgm / .vpr / .qmc* / .kwm / .mflac / .mgg ...），统一走 lib/decrypt 调度层解密。
//
// 流程：扫描目录 → 内置解密出 FLAC/MP3/OGG →（非 FLAC 且有 ffmpeg 时转 FLAC）
//       → 重命名「{歌曲名} - {艺术家}.{ext}」→ 原加密文件移入归档目录（保留不删除）
//
// 用法：
//   node ncm-auto-convert.mjs                                          # 正式跑
//   node ncm-auto-convert.mjs --dir D --out O --no-archive             # 测试跑（不归档）
//   node ncm-auto-convert.mjs --ffmpeg /path/to/ffmpeg                 # 手动指定 ffmpeg
//   NCM_MANIFEST=... node ncm-auto-convert.mjs                         # 环境变量覆盖
//
// 路径优先级：命令行参数 > 环境变量 > 平台中性默认值（lib/platform.js 的 defaultDirs()）。
// 刻意不绑定任何具体机器：Android 用公共下载目录，桌面用 home 下的 Music。
// 解密本身不需要 ffmpeg；只有「MP3/OGG 封装的源要无损转成 FLAC」时才用得到它。
import { readdirSync, statSync, renameSync, mkdirSync, existsSync, unlinkSync, appendFileSync, copyFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import platform, { execFileP } from '../lib/platform.js'
// 统一解密调度：按扩展名（或魔数）自动路由到具体解密器
import { decrypt, SUPPORTED_EXTENSIONS } from '../lib/decrypt/index.js'

// ── 路径解析 ────────────────────────────────────────────────────────────────
// defaultDirs() 已经按平台给好中性默认值，这里只做「环境变量 > 默认值」两级覆盖。
const DEF = platform.defaultDirs()
const argv = process.argv.slice(2)
const argOf = (name, env, def) => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  if (process.env[env]) return process.env[env]
  return def
}

const MUSIC_DIR = argOf('--dir', 'NCM_MUSIC_DIR', DEF.downloadDir)
const OUT_DIR = argOf('--out', 'NCM_STAGING_DIR', DEF.stagingDir)
const MANIFEST = argOf('--manifest', 'NCM_MANIFEST', DEF.manifest)
const NO_ARCHIVE = argv.includes('--no-archive')
// 归档目录默认仍在源目录下建子目录；未显式配置时用平台默认的 processedDir
const ARCHIVE_DIR = argOf('--archive', 'NCM_ARCHIVE_DIR',
  platform.samePath(DEF.processedDir, DEF.downloadDir) ? join(MUSIC_DIR, '已处理NCM') : DEF.processedDir)

mkdirSync(OUT_DIR, { recursive: true })
if (!NO_ARCHIVE) mkdirSync(ARCHIVE_DIR, { recursive: true })

// ── ffmpeg 探测（仅非 FLAC 产物转码时用得到） ─────────────────────────────────
// 优先级：--ffmpeg 参数 / NCM_FFMPEG 环境变量 > 平台默认安装位置 > PATH。
// 探测不到时 FFMPEG 为 null：内置解密本身不依赖 ffmpeg，只有「MP3/OGG 封装的
// 加密源要转成 FLAC」这一步才需要它，缺了只影响那一类文件并给出明确原因。
let FFMPEG = null
try {
  FFMPEG = platform.findToolPath('ffmpeg', { explicit: argOf('--ffmpeg', 'NCM_FFMPEG', '') })
} catch (e) {
  // 显式配置了但路径不可用：findToolPath 会抛。这里不静默吞掉——
  // 用户填错路径时必须看见，否则他会以为转码在跑其实一直是 null。
  console.error('ffmpeg 配置有问题：' + e.message)
  FFMPEG = null
}

// ── 扫描 ────────────────────────────────────────────────────────────────────
// 只认 lib/decrypt 注册表里声明过的扩展名，新增格式时这里零改动。
const SUPPORTED = new Set(SUPPORTED_EXTENSIONS.map((e) => e.toLowerCase()))
const isEncrypted = (name) => SUPPORTED.has(extname(name).toLowerCase())

let scannedNames = []
try { scannedNames = readdirSync(MUSIC_DIR) } catch (e) {
  console.error('无法读取源目录 ' + MUSIC_DIR + '：' + e.message)
  process.exit(2)
}
const files = scannedNames.filter(isEncrypted)
if (files.length === 0) {
  console.log(JSON.stringify({
    scanned: MUSIC_DIR, found: 0, processed: [],
    note: '没有受支持的加密文件（支持：' + SUPPORTED_EXTENSIONS.join(', ') + '），继续检查原生 FLAC',
  }, null, 2))
}

// 文件名字符清洗：元数据可能含 /（多人合作歌手常见 "A / B"）等非法路径字符，统一替换为 _
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_')

/**
 * 把解密产物重命名成「{歌名} - {歌手}.{ext}」。
 * 目标已存在时：同大小视为同一文件（删产物），不同大小判冲突（保留双份，不覆盖）。
 * @returns {{finalPath:string}|{conflict:string}}
 */
function finalizeName(outputPath, srcName, format, title, artist) {
  const t = safe(String(title || '').trim())
  const a = safe(String(artist || '').trim())
  const stem = t && a ? t + ' - ' + a : basename(srcName, extname(srcName))
  const target = join(OUT_DIR, stem + '.' + format)
  if (target === outputPath) return { finalPath: target }
  if (existsSync(target)) {
    if (statSync(target).size === statSync(outputPath).size) {
      try { unlinkSync(outputPath) } catch {}
      return { finalPath: target }
    }
    return { conflict: '目标已存在且大小不同，未覆盖：' + target }
  }
  renameSync(outputPath, target)
  return { finalPath: target }
}

/**
 * 用 ffmpeg 把非 FLAC 产物转成 FLAC（无损）。
 *
 * 为什么需要它：内置解密只做字节级还原，MP3/OGG 封装的加密源解出来还是 MP3/OGG，
 * 而传输链路的结构校验（jsCheck）只认 FLAC。此前这类文件一律标 needs-transcode
 * 并删掉产物，等于「能解但不能用」。接上 ffmpeg 后这条路才真正走得通。
 *
 * 调用契约（任务红线）：execFile(binary, [args]) 数组参数，绝不拼 shell 字符串——
 * 路径里有空格/中文/引号时 shell 拼接会出错甚至被注入。
 *
 * @returns {Promise<{ok:boolean, output?:string, error?:string, skipped?:boolean}>}
 */
async function transcodeToFlac(srcPath, ffmpeg) {
  if (!ffmpeg) {
    return { ok: false, skipped: true, error: '未找到 ffmpeg，跳过转码' }
  }
  const dst = srcPath.replace(/\.[^./\\]+$/, '') + '.transcoded.flac'
  // -vn 丢视频流（部分容器带封面流）、-nostdin 防止 ffmpeg 吃掉父进程 stdin 卡死、
  // -y 覆盖语义由我们自己保证（dst 唯一命名），-loglevel error 只留错误便于回传
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', srcPath, '-vn', '-codec:a', 'flac', dst]
  const r = await execFileP(ffmpeg, args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 }).catch((e) => e)
  if (r instanceof Error || (r && r.code)) {
    try { unlinkSync(dst) } catch {}
    const detail = String((r && (r.stderr || r.stdout)) || (r && r.message) || '').trim()
    return { ok: false, error: 'ffmpeg 转码失败：' + (detail.slice(-400) || '未知错误') }
  }
  if (!existsSync(dst) || statSync(dst).size === 0) {
    try { unlinkSync(dst) } catch {}
    return { ok: false, error: 'ffmpeg 退出码 0 但未产出有效 FLAC' }
  }
  return { ok: true, output: dst }
}

const rows = []
for (const f of files) {
  const input = join(MUSIC_DIR, f)
  const row = { file: f }
  try {
    // 内置解密：纯字节级还原，不嵌封面、不写标签
    // 先解到 OUT_DIR 下的隐藏临时名，拿到元数据后再按「歌曲名 - 艺术家」重命名
    const tmpPath = join(OUT_DIR, '.' + basename(f, extname(f)) + '.tmp')
    const r = await decrypt(input, tmpPath)
    if (!r.ok) { row.status = 'failed'; row.error = r.error; rows.push(row); continue }

    if (r.format !== 'flac') {
      // 非 FLAC：有 ffmpeg 就无损转码，没有才退回「标记不动作」。
      // 转码失败时保留原产物名并标 needs-transcode，绝不删源、绝不归档。
      const tc = await transcodeToFlac(r.output, FFMPEG)
      if (!tc.ok) {
        row.status = 'needs-transcode'
        row.error = '源内容是 ' + r.format + '，' + tc.error + '；原文件未归档'
        try { unlinkSync(r.output) } catch {}
        rows.push(row); continue
      }
      try { unlinkSync(r.output) } catch {} // 转码成功，删掉非 FLAC 中间产物
      row.transcodedFrom = r.format
      r.output = tc.output
      r.format = 'flac'
    }

    const named = finalizeName(r.output, f, r.format, r.title, r.artist)
    if (named.conflict) { row.status = 'conflict'; row.error = named.conflict; rows.push(row); continue }
    const finalPath = named.finalPath
    row.output = finalPath

    if (NO_ARCHIVE) { row.status = 'converted'; row.note = '测试模式：原文件未归档'; rows.push(row); continue }
    const arc = join(ARCHIVE_DIR, f)
    if (existsSync(arc)) { row.status = 'converted'; row.note = '归档目标已存在，未移动'; rows.push(row); continue }
    renameSync(input, arc)
    row.status = 'ok'; row.archived = arc
    // 写转换清单：flac↔源文件精确对应（传输脚本删源时按此匹配，不按文件名猜）。
    // 字段名保持 flac/ncm 不变是为了兼容既有 manifest 与传输脚本的匹配逻辑——
    // v0.2.0 起 ncm 字段实际装的是任意加密格式的原始文件名。
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
    if (extname(f).toLowerCase() !== '.flac') continue
    if (f.toLowerCase().endsWith('.backup.flac')) continue
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

console.log(JSON.stringify({
  platform: platform.PLATFORM_NAME,
  scanned: MUSIC_DIR,
  supported: SUPPORTED_EXTENSIONS,
  // 把 ffmpeg 探测结果如实报出来：null 表示非 FLAC 产物只能标记不能转码，
  // 排查「为什么这首歌没进准备传输」时第一眼就能看出是不是缺 ffmpeg。
  ffmpeg: FFMPEG,
  found: files.length,
  processed: rows,
  native: nativeRows,
}, null, 2))
process.exit(rows.some(x => x.status !== 'ok' && x.status !== 'converted') || nativeRows.some(x => x.status === 'error' || x.status === 'conflict') ? 1 : 0)
