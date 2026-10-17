#!/usr/bin/env node
// E2E：v0.2.0 全格式全流程演练（完全隔离，绝不碰真实下载目录 / 真实 OTG 卡）。
//
// 与上一版的区别：不再自带「简化版 copy+md5」，而是**直接跑两个生产脚本**
// （scripts/ncm-auto-convert.mjs 与 scripts/ncm-otg-transfer.mjs），
// 靠它们的环境变量把输入输出全部指向临时沙箱。这样 E2E 覆盖的是真实链路：
//   扫描 → 解密 → 重命名 → 归档 → 传输 → MD5 校验 → 结构校验 → 删源 → 清归档
// 简化版只覆盖 happy path，测不到归档匹配、manifest、jsCheck 这些真会出错的环节。
//
// 手动跑：node test/e2e-v0.2.0.mjs      （npm test 不含它，run-tests.mjs 只收 *.test.js）
// 结尾打印 {steps:[{name,ok,detail}], allOk}，exit code 反映 allOk。
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as kgm from '../lib/decrypt/kgm.js'
import * as kwm from '../lib/decrypt/kwm.js'
import * as qmc from '../lib/decrypt/qmc.js'

const HERE = dirnameOf(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
function dirnameOf(p) { return p.slice(0, p.lastIndexOf('/')) }

const steps = []
/** 串行执行一步：任何一步失败不中断后续（要的是完整体检报告，不是第一个错就退） */
async function step(name, fn) {
  try {
    const detail = await fn()
    steps.push({ name, ok: true, detail: detail ?? '' })
    console.log(`✔ ${name}${detail ? ' — ' + detail : ''}`)
  } catch (e) {
    const detail = `FAILED: ${e?.message ?? e}`
    steps.push({ name, ok: false, detail })
    console.log(`✖ ${name} — ${detail}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')

// ── 合成数据：必须是能通过传输脚本 jsCheck 的「结构合法 FLAC」 ────────────────
//
// jsCheck 要求：fLaC 魔数 + 闭合的元数据块链（STREAMINFO 带 LAST 位）+
// 音频区起始有合法帧头 + 尾部 64KB 内有合法帧头 + 音频体积/采样数 ≥ 0.5 B/采样。
// 随手拼的伪随机尾巴过不了这道关，所以这里认真构造。
function makeValidFakeFlac(bodyBytes = 4096, seed = 0x37) {
  // 合法帧头 16 字节：0xFF 0xF8（固定帧、无校验）/ blocksize=4 / samplerate=4 /
  // channel=1 / samplesize=1 / 无 padding，第 5 字节 0x00 是合法 UTF-8 单字节。
  // 必须是 16 字节：jsCheck 的帧头判定要读满 16 字节（frameHeaderAt 里 h.length<16 直接 false）。
  const frame = Buffer.from([0xff, 0xf8, 0x44, 0x12, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
  const head = Buffer.alloc(4 + 4 + 34, 0)
  head.write('fLaC', 0, 'latin1')
  head.writeUInt8(0x80, 4)       // LAST=1 + type=0(STREAMINFO)：块链一步闭合
  head.writeUIntBE(34, 5, 3)     // 块体 34 字节
  head.writeUIntBE(4096, 8, 2)   // si[0..1] min blocksize
  head.writeUIntBE(4096, 10, 2)  // si[2..3] max blocksize
  // si[4..9] min/max framesize 留 0（未定义，校验器不查）
  // si[10..17] 是 64 位打包字段：采样率 20bit | 声道-1 3bit | 位深-1 5bit | 总采样数 36bit
  // 校验器正是从 si[13..17] 取总采样数，写错位置会让「体积/采样数」截断检测失效。
  const packed = (44100n << 44n) | (1n << 41n) | (15n << 36n) | 1000n
  for (let i = 0; i < 8; i++) head[18 + i] = Number((packed >> BigInt(56 - i * 8)) & 0xffn)
  // body 按 seed 变化：5 个合成文件的明文必须互不相同，否则它们的 MD5 全一样，
  // 「拷错文件 / 张冠李戴」这类 bug 在断言里根本测不出来。
  const body = Buffer.alloc(bodyBytes)
  for (let i = 0; i < bodyBytes; i++) body[i] = (seed + i * 31) & 0xff
  // 首尾各放一个完整帧头：jsCheck 先查音频区起始，再从尾部 64KB 内找合法帧头，
  // 且扫描上界是 size-16 —— 尾部帧必须完整落在该上界之内，所以帧头后还得跟 8 字节。
  return Buffer.concat([head, frame, body, frame])
}

// ── 测试侧独立加密器（与 decrypt-formats.test.js 同一思路：不复用被测解密函数） ──

function testGetMask(pos) {
  let offset = pos >> 4, value = 0
  while (offset >= 0x11) {
    value ^= kgm.TABLE1[offset % 272]; offset >>= 4
    value ^= kgm.TABLE2[offset % 272]; offset >>= 4
  }
  return kgm.MASK_V2_PRE_DEF[pos % 272] ^ value
}

function kgmEncrypt(data, key17, isVpr) {
  for (let i = 0; i < data.length; i++) {
    let msk8 = testGetMask(i); msk8 ^= (msk8 & 0x0f) << 4
    let med8 = data[i] ^ msk8
    if (isVpr) med8 ^= kgm.VPR_MASK_DIFF[i % 17]
    const low = med8 & 0x0f, high = (med8 >> 4) ^ low
    data[i] = ((high << 4) | low) ^ key17[i % 17]
  }
}

function synthKgm(name, magic, seed) {
  const plain = makeValidFakeFlac(4096, seed)
  const key = new Uint8Array(17); key.fill(0xab); key[16] = 0
  const headerLen = 0x40
  const hdr = Buffer.alloc(headerLen)
  Buffer.from(magic).copy(hdr, 0)
  hdr.writeUInt32LE(headerLen, 0x10)
  Buffer.from(key.buffer, key.byteOffset, 16).copy(hdr, 0x1c)
  const file = Buffer.concat([hdr, plain])
  kgmEncrypt(file.subarray(headerLen), key, magic === kgm.VPR_HEADER)
  return { file, plain, name }
}

function synthKwm(name) {
  const plain = makeValidFakeFlac(4096, 0x91)
  const seed = 123456789
  const decimal = String(seed)
  const mask = new Uint8Array(32)
  for (let i = 0; i < decimal.length; i++) mask[i] = decimal.charCodeAt(i)
  for (let i = 0; i < 32; i++) mask[i] ^= kwm.KWM_ROOT[i]
  const hdr = Buffer.alloc(0x400)
  Buffer.from(kwm.KWM_MAGIC).copy(hdr, 0)
  hdr.writeUInt32LE(seed, 0x10)
  const file = Buffer.concat([hdr, plain])
  for (let i = 0; i < plain.length; i++) file[0x400 + i] ^= mask[i % 32]
  return { file, plain, name }
}

function synthQmcV1(name) {
  const plain = makeValidFakeFlac(4096, 0xC3)
  const box = qmc.QMC1_STATIC_BOX
  const file = Buffer.from(plain)
  for (let i = 0; i < file.length; i++) {
    const m = box[(i * i + 27) & 0xff]
    file[i] ^= m
  }
  return { file, plain, name }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mp-e2e-'))
const DL = join(ROOT, 'download')
const ST = join(ROOT, 'staging')
const ARC = join(ROOT, 'archive')
const CARD = join(ROOT, 'card')
const MAN = join(ROOT, 'manifest.jsonl')
const TLOG = join(ROOT, 'transfer.log')

const ENV = {
  ...process.env,
  NCM_MUSIC_DIR: DL,
  NCM_STAGING_DIR: ST,
  NCM_ARCHIVE_DIR: ARC,
  NCM_MANIFEST: MAN,
  NCM_TRANSFER_LOG: TLOG,
  // 传输脚本按 join(存储根, 卷标) 定位挂载点，所以存储根必须是 card 的父目录
  NCM_STORAGE_ROOT: ROOT,
}
const NODE = process.argv0 && /^(\/|[A-Za-z]:\\)/.test(process.argv0) ? process.argv0 : process.execPath
const runScript = (rel, args = []) => spawnSync(NODE, [join(REPO, rel), ...args], { encoding: 'utf8', env: ENV, timeout: 120000 })

try {
  await step('建隔离沙箱', () => {
    mkdirSync(DL, { recursive: true }); mkdirSync(ST, { recursive: true })
    mkdirSync(ARC, { recursive: true }); mkdirSync(join(CARD, 'Music'), { recursive: true })
    assert(statSync(CARD).isDirectory(), '假卡目录未建成')
    return ROOT
  })

  await step('放入多格式合成加密文件 + 原生 flac + 垃圾文件', () => {
    const cases = [
      synthKgm('春风吹.kgm', kgm.KGM_HEADER, 0x11),
      synthKgm('三人游.vpr', kgm.VPR_HEADER, 0x55),
      synthKwm('celtic.kwm'),
      synthQmcV1('qmc-song.qmc0'),
    ]
    for (const c of cases) writeFileSync(join(DL, c.name), c.file)
    writeFileSync(join(DL, '原生下载.flac'), makeValidFakeFlac(4096, 0x37))
    writeFileSync(join(DL, '坏文件.ncm'), Buffer.concat([Buffer.from('CTENFDAM'), Buffer.alloc(600, 0x5a)]))
    return `${cases.length} 个加密文件 + 1 原生 flac + 1 垃圾 ncm`
  })

  let convJson = null
  await step('跑生产转换脚本 ncm-auto-convert.mjs', () => {
    const r = runScript('scripts/ncm-auto-convert.mjs')
    // 垃圾 ncm 会让脚本 exit 1 —— 这是预期行为，不是崩溃
    assert(r.status === 0 || r.status === 1, `脚本异常退出 status=${r.status} stderr=${(r.stderr || '').slice(0, 300)}`)
    try { convJson = JSON.parse(r.stdout) } catch { throw new Error('转换脚本输出不是 JSON：' + r.stdout.slice(0, 400)) }
    assert(convJson.platform === 'android' || convJson.platform === 'windows' || convJson.platform === 'linux' || convJson.platform === 'macos', 'platform 字段异常: ' + convJson.platform)
    const byStatus = {}
    for (const p of convJson.processed) byStatus[p.status] = (byStatus[p.status] || 0) + 1
    return `found=${convJson.found} 状态分布=${JSON.stringify(byStatus)} native=${convJson.native.length}`
  })

  await step('校验：4 个加密文件全部解密+重命名+归档', () => {
    const ok = convJson.processed.filter((p) => p.status === 'ok')
    assert(ok.length === 4, `期望 4 个成功，实际 ${ok.length}：` + JSON.stringify(convJson.processed.map((p) => [p.file, p.status, p.error || ''])))
    for (const p of ok) {
      assert(existsSync(p.output), '暂存缺产物: ' + p.output)
      assert(existsSync(p.archived), '归档缺原文件: ' + p.archived)
      assert(basename(p.output).endsWith('.flac'), '产物应为 flac: ' + p.output)
    }
    // 重命名规则：元数据缺失时退回原文件基名（KGM/KWM/QMC 容器不嵌元数据）
    const names = ok.map((p) => basename(p.output)).sort()
    return names.join(', ')
  })

  await step('校验：垃圾文件失败但不崩、原生 flac 直通', () => {
    const bad = convJson.processed.find((p) => p.file === '坏文件.ncm')
    assert(bad && bad.status === 'failed', '垃圾 ncm 应标 failed，实际: ' + JSON.stringify(bad))
    assert(typeof bad.error === 'string' && bad.error.length > 0, 'failed 必须带 error 文本')
    assert(!bad.archived, '失败的文件不许被归档')
    const nat = convJson.native.find((n) => n.file === '原生下载.flac')
    assert(nat && nat.status === 'native-copied', '原生 flac 应直通，实际: ' + JSON.stringify(nat))
    return `failed 原因="${bad.error.slice(0, 40)}…"，原生直通 OK`
  })

  let transfer = null
  await step('跑生产传输脚本 ncm-otg-transfer.mjs（传假卡 + 删源）', () => {
    const before = { staging: readdirCount(ST), archive: readdirCount(ARC) }
    const r = runScript('scripts/ncm-otg-transfer.mjs', [basename(CARD), '--yes-delete-ncm'])
    assert(r.status === 0 || r.status === 1, `传输脚本异常退出 status=${r.status}`)
    const log = r.stdout || ''
    assert(!/ReferenceError|TypeError|undefined\b.*is not/.test(log), '传输日志里有崩溃痕迹：' + log.slice(0, 400))
    const count = (s) => (log.match(new RegExp(s, 'g')) || []).length
    transfer = { copied: count('\\] copied: '), verified: count('\\] post-check ok '), deleted: count('\\] deleted '), before }
    assert(transfer.copied === 5, `期望复制 5 个（4 解密 + 1 原生），实际 ${transfer.copied}\n${log.slice(-800)}`)
    assert(transfer.verified === 5, `期望 5 个通过结构校验，实际 ${transfer.verified}`)
    return JSON.stringify({ copied: transfer.copied, verified: transfer.verified, deleted: transfer.deleted })
  })

  await step('校验：卡上 5 个文件齐全、内容合法且互不重复', () => {
    const cardFiles = readdirNames(join(CARD, 'Music'))
    assert(cardFiles.length === 5, `卡上应有 5 个文件，实际 ${cardFiles.length}: ${cardFiles.join(', ')}`)
    // 明文已按不同 seed 生成，所以 5 个 MD5 必须两两不同。
    // 若哪天合成器又把 seed 写重了，这里会立刻红——而不是让「拷错文件」蒙混过关。
    const seen = new Map()
    for (const f of cardFiles) {
      const p = join(CARD, 'Music', f)
      assert(statSync(p).size > 1000, '卡上文件过小，疑似截断: ' + f)
      assert(/^fLaC/.test(readFileSync(p).subarray(0, 4).toString('latin1')), '卡上文件不是 FLAC: ' + f)
      const h = md5(p)
      assert(!seen.has(h), `卡上 ${f} 与 ${seen.get(h)} MD5 相同，合成明文未真正区分`)
      seen.set(h, f)
    }
    return cardFiles.map((f) => `${f}(${md5(join(CARD, 'Music', f)).slice(0, 8)})`).join(' ')
  })

  await step('校验：暂存区已清空、归档 NCM 按 manifest 清理、失败文件留在源目录', () => {
    const left = readdirNames(ST).filter((f) => f.endsWith('.flac'))
    assert(left.length === 0, `暂存区应清空，残留: ${left.join(', ')}`)
    // 归档区应为空：4 个成功文件先被转换脚本归档，传卡成功后又按 manifest 记录删掉源 NCM。
    const arcLeft = readdirNames(ARC)
    assert(arcLeft.length === 0, `归档区应已清空，残留: ${arcLeft.join(', ')}`)
    // 解密失败的文件走的是「不归档、不删源」分支——它必须原样躺在下载目录里等人工处理。
    const stillInDownload = readdirNames(DL)
    assert(stillInDownload.includes('坏文件.ncm'),
      `解密失败的文件必须原样留在下载目录（不许删/归档），实际: ${stillInDownload.join(', ') || '(空)'}`)
    return '暂存 0，归档 0，失败文件仍在下载区'
  })

  await step('校验：重复传输幂等（再跑一次不重复复制、不报错）', () => {
    const r = runScript('scripts/ncm-otg-transfer.mjs', [basename(CARD), '--yes-delete-ncm'])
    const log = r.stdout || ''
    assert(!/ReferenceError|TypeError/.test(log), '第二次传输崩溃')
    const copied = (log.match(/\] copied: /g) || []).length
    assert(copied === 0, `暂存已空，第二次不该再复制，实际 copied=${copied}`)
    assert(/=== done, failures=0 ===/.test(log), '第二次传输收尾异常：' + log.slice(-300))
    return '幂等 OK，failures=0'
  })

  // ── 真实样本增强（可选） ──
  const REF_NCM = process.env.NCM_REF_NCM
  if (REF_NCM && existsSync(REF_NCM)) {
    await step('[增强] 真实 NCM 走完整链路', () => {
      const dl2 = join(ROOT, 'dl2'); mkdirSync(dl2, { recursive: true })
      copyFileSync(REF_NCM, join(dl2, basename(REF_NCM)))
      const r = spawnSync(NODE, [join(REPO, 'scripts/ncm-auto-convert.mjs')], {
        encoding: 'utf8', env: { ...ENV, NCM_MUSIC_DIR: dl2, NCM_STAGING_DIR: join(ROOT, 'st2'), NCM_ARCHIVE_DIR: join(ROOT, 'arc2') },
      })
      assert(r.status === 0, '真实 NCM 转换失败：' + (r.stdout || r.stderr).slice(-400))
      const j = JSON.parse(r.stdout)
      assert(j.processed[0] && j.processed[0].status === 'ok', '真实 NCM 未成功: ' + JSON.stringify(j.processed))
      return `${basename(j.processed[0].output)} (${statSync(j.processed[0].output).size}B)`
    })
  } else {
    console.log('  (skip: 未提供 NCM_REF_NCM，跳过真实样本增强)')
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

function readdirCount(d) { try { return readdirSync(d).length } catch { return -1 } }
function readdirNames(d) { try { return readdirSync(d) } catch { return [] } }

const allOk = steps.every((s) => s.ok)
console.log('')
console.log(JSON.stringify({ root: ROOT, steps, allOk }, null, 2))
console.log(allOk ? 'e2e: 全部通过' : 'e2e: 有失败步骤')
process.exit(allOk ? 0 : 1)
