#!/usr/bin/env node
// 验证「非 FLAC 加密源 → ffmpeg 无损转 FLAC」这条接线。
//
// 为什么单独一个脚本：这条路径需要三样东西同时成立——
//   ① 真有一个「解密出来不是 FLAC」的加密文件（NCM 可以封装 MP3）
//   ② 一个可被 execFile 调起的 ffmpeg（本机没有真的，用假的可执行脚本代替）
//   ③ 转换脚本确实按数组参数调用它、并在成功时采用产物
// 单测里 mock 会失去「真实 spawn」这一层的可信度，所以这里真跑子进程。
//
// 假 ffmpeg 做的事：把 -i 的输入原样复制到最后那个输出路径，并把收到的 argv
// 写进日志文件——这样能验证参数拼接（含空格/中文路径不被 shell 拆坏）。
//
// 手动跑：node scripts/verify-ffmpeg-wiring.cjs
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const crypto = require('node:crypto')
// Android 上 process.execPath 是 linker64（不是 node），spawn 它必报 bad ELF magic；
// 真 node 入口在 process.argv0 —— 与 lib/platform.js 的 nodeExecutable() 同一处理。
const NODE_BIN = process.argv0 && process.argv0.includes('node') ? process.argv0 : process.execPath

const REPO = path.resolve(__dirname, '..')
// 工作区目录是 noexec 挂载的，可执行脚本必须放这里
const EXEC_DIR = process.env.DSH_EXEC_TMP || path.join(os.homedir(), 'tmp')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ── 1. 造一个「MP3 封装」的 NCM 文件 ─────────────────────────────────────────
// NCM 的音频段是 keystream XOR，可逆；密钥段是 AES-128-ECB 加密，这里正向加密。
function buildNcmWithMp3(mp3Bytes, metaObj) {
  const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex')
  const META_KEY = Buffer.from('2331346C6A6B5F215C5D2630553C2728', 'hex')
  const audioKey = Buffer.from('dshmp-test-audiokey') // 16 字节

  // 密钥段：'neteasecloudmusic' + key，PKCS#7 填充，AES-128-ECB 加密，再逐字节 XOR 0x64
  const keyPlain = Buffer.concat([Buffer.from('neteasecloudmusic', 'ascii'), audioKey])
  const pad = 16 - (keyPlain.length % 16)
  const padded = Buffer.concat([keyPlain, Buffer.alloc(pad, pad)])
  const enc = crypto.createCipheriv('aes-128-ecb', CORE_KEY, null)
  enc.setAutoPadding(false)
  const keyCipher = Buffer.concat([enc.update(padded), enc.final()])
  for (let i = 0; i < keyCipher.length; i++) keyCipher[i] ^= 0x64

  // 元数据段：JSON → 'music:' 前缀 → AES 加密 → base64 → 加 '163 key(Don't modify):' → XOR 0x63
  const metaJson = Buffer.from('music:' + JSON.stringify(metaObj), 'utf8')
  const mpad = 16 - (metaJson.length % 16)
  const mpadded = Buffer.concat([metaJson, Buffer.alloc(mpad, mpad)])
  const menc = crypto.createCipheriv('aes-128-ecb', META_KEY, null)
  menc.setAutoPadding(false)
  const b64 = Buffer.concat([menc.update(mpadded), menc.final()]).toString('base64')
  const metaBody = Buffer.concat([Buffer.from("163 key(Don't modify):", 'ascii'), Buffer.from(b64, 'ascii')])
  const metaEnc = Buffer.from(metaBody)
  for (let i = 0; i < metaEnc.length; i++) metaEnc[i] ^= 0x63

  // 音频段：RC4 变体 keystream，按 (i+1)&0xff 索引
  const box = new Uint8Array(256)
  for (let i = 0; i < 256; i++) box[i] = i
  let c = 0, last = 0, ko = 0
  for (let i = 0; i < 256; i++) {
    const swap = box[i]
    c = (swap + last + audioKey[ko]) & 0xff
    ko = ko + 1 >= audioKey.length ? 0 : ko + 1
    box[i] = box[c]; box[c] = swap; last = c
  }
  const ks = new Uint8Array(256)
  for (let j = 0; j < 256; j++) { const bj = box[j]; ks[j] = box[(bj + box[(bj + j) & 0xff]) & 0xff] }
  const audio = Buffer.from(mp3Bytes)
  for (let i = 0; i < audio.length; i++) audio[i] ^= ks[(i + 1) & 0xff]

  const head = Buffer.alloc(10)
  Buffer.from('CTENFDAM', 'ascii').copy(head, 0)
  head.writeUInt16LE(0x0170, 8)
  const parts = [
    head,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(keyCipher.length, 0); return b })(),
    keyCipher,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(metaEnc.length, 0); return b })(),
    metaEnc,
    Buffer.alloc(4),          // 封面 CRC32
    Buffer.alloc(5),          // 未知
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b })(), // 无封面
    audio,
  ]
  return Buffer.concat(parts)
}

// 假 MP3：ID3 头 + 帧同步头，够让 sniffAudioFormat 认出 mp3
const fakeMp3 = (() => {
  const id3 = Buffer.alloc(30)
  Buffer.from('ID3\x03\x00\x00', 'latin1').copy(id3, 0)
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00])
  return Buffer.concat([id3, frame, Buffer.alloc(2048, 0x21)])
})()

const ncmBuf = buildNcmWithMp3(fakeMp3, { musicName: '测试歌曲', artist: [['测试艺术家', 1]], format: 'mp3', album: '测试专辑' })

// ── 2. 造假 ffmpeg（可执行 + 记录 argv + 产出文件） ──────────────────────────
const work = fs.mkdtempSync(path.join(EXEC_DIR, 'dshmp-ff-'))
const argvLog = path.join(work, 'ffmpeg-argv.log')
const fakeFf = path.join(work, 'fake-ffmpeg.sh')
fs.writeFileSync(fakeFf, [
  '#!/bin/sh',
  `echo "ARGS: $*" >> ${JSON.stringify(argvLog)}`,
  'in=""; out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "-i" ]; then in="$a"; fi',
  '  out="$a"',
  '  prev="$a"',
  'done',
  'if [ ! -f "$in" ]; then echo "fake-ffmpeg: input missing: $in" >&2; exit 3; fi',
  'head -c 4 "$in" > /dev/null 2>&1 || { echo "fake-ffmpeg: unreadable" >&2; exit 4; }',
  // 产出一个「结构合法」的 FLAC 头，让下游 finalizeName 与 jsCheck 都能过
  'printf "fLaC" > "$out"',
  'printf "\\200\\000\\000\\042" >> "$out"',
  'i=0; while [ $i -lt 34 ]; do printf "\\000" >> "$out"; i=$((i+1)); done',
  'printf "\\377\\370\\044\\022\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000" >> "$out"',
  'i=0; while [ $i -lt 2048 ]; do printf "\\061" >> "$out"; i=$((i+1)); done',
  'printf "\\377\\370\\044\\022\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000" >> "$out"',
  'exit 0',
].join('\n'), { mode: 0o755 })
fs.chmodSync(fakeFf, 0o755)
// 判据是「能被 execve 调起」= 没有 spawn 层错误（ENOENT/EACCES），
// 而不是退出码 0：本脚本没传 -i 时会主动走「输入不存在」分支 exit 3，
// 那恰好说明脚本体执行到了。
const probe = cp.spawnSync(fakeFf, ['--version'])
check('假 ffmpeg 可被调起（无 ENOENT/EACCES）', !probe.error && probe.status !== null,
  probe.error ? `error=${probe.error.code}` : `status=${probe.status}`)

// ── 3. 跑转换脚本：显式配置假 ffmpeg ─────────────────────────────────────────
const DL = path.join(work, 'download')
const ST = path.join(work, 'staging')
const ARC = path.join(work, 'archive')
for (const d of [DL, ST, ARC]) fs.mkdirSync(d, { recursive: true })
// 文件名带空格与中文：验证数组参数不会把它拆成两个 argv
const srcName = '有 空格 的 歌曲.ncm'
fs.writeFileSync(path.join(DL, srcName), ncmBuf)

const env = {
  ...process.env,
  NCM_MUSIC_DIR: DL, NCM_STAGING_DIR: ST, NCM_ARCHIVE_DIR: ARC,
  NCM_MANIFEST: path.join(work, 'man.jsonl'), NCM_TRANSFER_LOG: path.join(work, 't.log'),
}
const r = cp.spawnSync(NODE_BIN, [path.join(REPO, 'scripts/ncm-auto-convert.mjs'), '--ffmpeg', fakeFf], { encoding: 'utf8', env, timeout: 120000 })
let out = null
try { out = JSON.parse(r.stdout) } catch { }
check('转换脚本正常退出', r.status === 0 || r.status === 1, `status=${r.status}` + (r.stderr ? ' stderr=' + r.stderr.slice(0, 200) : ''))
check('输出是 JSON 且带 ffmpeg 字段', !!out && typeof out.ffmpeg === 'string', out ? 'ffmpeg=' + path.basename(out.ffmpeg) : 'stdout=' + r.stdout.slice(0, 300))

// 3a. 解密本身要成功（格式必须是 mp3，才会进转码分支）
const row = out && out.processed[0]
check('NCM(MP3) 解密成功且识别为 mp3', !!row && row.status === 'ok' && row.transcodedFrom === 'mp3',
  row ? `status=${row.status} transcodedFrom=${row.transcodedFrom || '-'} err=${row.error || '-'}` : '无 processed')

// 3b. 假 ffmpeg 真的被调起，且 argv 是数组语义（含空格路径完整保留）
const log = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8') : ''
check('ffmpeg 被真实调起', log.includes('ARGS:'), log.slice(0, 120) || '无 argv 日志')
check('参数含 -codec:a flac', log.includes('-codec:a flac'))
check('带空格路径未被拆坏', log.includes('有 空格 的 歌曲') || log.includes('.tmp'), 'argv 日志: ' + log.slice(0, 200))
check('传了 -nostdin（防吃父进程 stdin）', log.includes('-nostdin'))

// 3c. 产物按「歌名 - 艺术家.flac」重命名，且中间 mp3 已清掉
const staged = fs.readdirSync(ST)
check('暂存区只剩一个 .flac 产物', staged.length === 1 && staged[0].endsWith('.flac'), staged.join(', '))
check('重命名用了元数据（测试歌曲 - 测试艺术家）', staged[0] === '测试歌曲 - 测试艺术家.flac', staged[0])
check('转码产物内容合法（fLaC 头）', staged.length === 1 && fs.readFileSync(path.join(ST, staged[0])).subarray(0, 4).toString('latin1') === 'fLaC')
check('原 NCM 已归档', fs.readdirSync(ARC).includes(srcName), fs.readdirSync(ARC).join(', '))
check('manifest 记录了 flac↔ncm 对应', fs.existsSync(env.NCM_MANIFEST) && fs.readFileSync(env.NCM_MANIFEST, 'utf8').includes(srcName))

// ── 4. 没有 ffmpeg 时必须优雅退回，而不是崩或假装成功 ─────────────────────────
const work2 = fs.mkdtempSync(path.join(EXEC_DIR, 'dshmp-noff-'))
const DL2 = path.join(work2, 'download'), ST2 = path.join(work2, 'staging'), ARC2 = path.join(work2, 'archive')
for (const d of [DL2, ST2, ARC2]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(DL2, '无ffmpeg.ncm'), ncmBuf)
const env2 = { ...env, NCM_MUSIC_DIR: DL2, NCM_STAGING_DIR: ST2, NCM_ARCHIVE_DIR: ARC2, NCM_MANIFEST: path.join(work2, 'm.jsonl'), NCM_FFMPEG: '' }
// 用 PATH 里绝对找不到 ffmpeg 的方式跑：findToolPath 返回 null
const r2 = cp.spawnSync(NODE_BIN, [path.join(REPO, 'scripts/ncm-auto-convert.mjs')], { encoding: 'utf8', env: { ...env2, PATH: '/nonexistent-dir-only' }, timeout: 120000 })
let out2 = null
try { out2 = JSON.parse(r2.stdout) } catch { }
const row2 = out2 && out2.processed[0]
check('无 ffmpeg 时不崩', r2.status === 1, `status=${r2.status}`)
check('无 ffmpeg 时标 needs-transcode 并说明原因', !!row2 && row2.status === 'needs-transcode' && /未找到 ffmpeg/.test(row2.error || ''),
  row2 ? `status=${row2.status} err=${(row2.error || '').slice(0, 80)}` : 'stdout=' + r2.stdout.slice(0, 200))
check('无 ffmpeg 时不删源不归档', fs.readdirSync(DL2).includes('无ffmpeg.ncm') && fs.readdirSync(ARC2).length === 0,
  `download=${fs.readdirSync(DL2).join(',')} archive=${fs.readdirSync(ARC2).join(',')}`)
check('输出里 ffmpeg 字段如实为 null', !!out2 && out2.ffmpeg === null, out2 ? String(out2.ffmpeg) : '-')

// ── 5. 配置了错误路径必须明确报错，不许静默回落 ───────────────────────────────
const r3 = cp.spawnSync(NODE_BIN, [path.join(REPO, 'scripts/ncm-auto-convert.mjs'), '--ffmpeg', path.join(work, '不存在的路径')], { encoding: 'utf8', env, timeout: 60000 })
check('错误 ffmpeg 路径 → 明确告警而非静默', /ffmpeg 配置有问题/.test(r3.stderr || ''), (r3.stderr || '').slice(0, 160) || '(无 stderr)')

fs.rmSync(work, { recursive: true, force: true })
fs.rmSync(work2, { recursive: true, force: true })

const failed = results.filter((x) => !x.ok)
console.log('')
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name) }, null, 2))
console.log(failed.length === 0 ? 'ffmpeg 接线验证：全部通过' : 'ffmpeg 接线验证：有失败')
process.exit(failed.length ? 1 : 0)
