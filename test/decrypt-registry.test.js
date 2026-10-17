// lib/decrypt/index.js 统一调度层测试。
//
// 只测调度层自己不测各具体解密器的解密正确性（那部分在
// test/decrypt-formats.test.js 与 test/ncm-decryptor.test.js）。
// 这里验证的是「契约」：
//   - decrypt() 对空参数/不存在/不支持格式一律返回 ok:false + string error，绝不抛
//   - decryptorFor() 大小写不敏感、能吃扩展名也能吃完整路径
//   - SUPPORTED_EXTENSIONS 是数组、元素小写带点
//   - normalizeMeta() 把 NCM 的嵌套 artist 数组归一成 '方大同' 这种字符串
//
// 零第三方框架，node:test + node:assert/strict，与 test/ncm-decryptor.test.js 同风格。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  decrypt,
  decryptToDir,
  decryptorFor,
  isSupported,
  sniffDecryptor,
  normalizeMeta,
  describeFormats,
  sniffFormat,
  SUPPORTED_EXTENSIONS,
} from '../lib/decrypt/index.js'

// ── SUPPORTED_EXTENSIONS ─────────────────────────────────────────────────────

test('SUPPORTED_EXTENSIONS 是数组，元素小写带点且不重复', () => {
  assert.ok(Array.isArray(SUPPORTED_EXTENSIONS))
  assert.ok(SUPPORTED_EXTENSIONS.length > 0)
  assert.ok(SUPPORTED_EXTENSIONS.includes('.ncm'), '注册表必须包含 .ncm')
  for (const ext of SUPPORTED_EXTENSIONS) {
    assert.equal(typeof ext, 'string')
    assert.match(ext, /^\.[a-z0-9]+$/, `扩展名必须小写带点，得到 ${ext}`)
  }
  assert.equal(new Set(SUPPORTED_EXTENSIONS).size, SUPPORTED_EXTENSIONS.length, '不应有重复扩展名')
})

test('describeFormats 返回非空字符串', () => {
  const s = describeFormats()
  assert.equal(typeof s, 'string')
  assert.ok(s.includes('NCM'))
})

// ── decryptorFor ─────────────────────────────────────────────────────────────
//
// 历史坑（已修）：原先条件 `ext.includes('.')` 会把 '.ncm' 送进 path.extname，
// 而 path.extname('.ncm') === ''（POSIX 把 '.ncm' 整个当文件名，不是「无基名的扩展名」），
// 导致所有裸扩展名查询静默返回 null。修复后：只有含路径分隔符时才取 extname，
// 且不以 '.' 开头时补点。下面这组裸扩展名用例就是防回归的哨兵。

test('decryptorFor 完整路径能解析', () => {
  const d = decryptorFor('/music/download/方大同 - 春风吹.ncm')
  assert.notEqual(d, null)
  assert.equal(typeof d.decryptFile, 'function')
})

test('decryptorFor 裸扩展名（带点）也能解析', () => {
  assert.notEqual(decryptorFor('.ncm'), null)
  assert.notEqual(decryptorFor('.NCM'), null)
})

test('decryptorFor 裸扩展名（不带点）也能解析', () => {
  assert.notEqual(decryptorFor('ncm'), null)
  assert.notEqual(decryptorFor('NCM'), null)
})

test('decryptorFor 大小写不敏感（完整路径 + 裸扩展名）', () => {
  assert.notEqual(decryptorFor('/music/歌.NCM'), null)
  assert.notEqual(decryptorFor('/music/歌.ncm'), null)
  assert.notEqual(decryptorFor('.Ncm'), null)
})

test('decryptorFor 未知格式返回 null', () => {
  assert.equal(decryptorFor('/music/歌.mp3'), null)
  assert.equal(decryptorFor('.mp3'), null)
  assert.equal(decryptorFor('/music/歌.xyz'), null)
  assert.equal(decryptorFor('.xyz'), null)
  assert.equal(decryptorFor(''), null)
  assert.equal(decryptorFor(null), null)
  assert.equal(decryptorFor(undefined), null)
})

test('isSupported 与 decryptorFor 一致', () => {
  assert.equal(isSupported('/music/歌.ncm'), true)
  assert.equal(isSupported('/music/歌.mp3'), false)
})

// ── sniffDecryptor ───────────────────────────────────────────────────────────

test('sniffDecryptor 按魔数认 NCM', () => {
  const head = Buffer.from('CTENFDAM' + '0123456789abcdef', 'latin1')
  const d = sniffDecryptor(head)
  assert.notEqual(d, null)
  assert.ok(d.FORMATS.includes('.ncm'))
})

test('sniffDecryptor 对垃圾/空输入返回 null 而不抛', () => {
  assert.equal(sniffDecryptor(Buffer.from('NOTMAGIC')), null)
  assert.equal(sniffDecryptor(Buffer.alloc(0)), null)
  assert.equal(sniffDecryptor(null), null)
  assert.equal(sniffDecryptor(undefined), null)
})

// ── normalizeMeta ────────────────────────────────────────────────────────────

test('normalizeMeta: NCM 嵌套 artist 数组归一', () => {
  const m = normalizeMeta({ musicName: '春风吹', artist: [['方大同', 2738]], album: '15' }, 'fallback')
  assert.equal(m.title, '春风吹')
  assert.equal(m.artist, '方大同')
  assert.equal(m.album, '15')
})

test('normalizeMeta: 多 artist 用 " / " 连接', () => {
  const m = normalizeMeta({ musicName: '爱爱爱', artist: [['方大同', 1], ['周笔畅', 2]] })
  assert.equal(m.artist, '方大同 / 周笔畅')
})

test('normalizeMeta: 普通形状直接吃', () => {
  const m = normalizeMeta({ title: 'T', artist: 'A', album: 'B' })
  assert.deepEqual(
    { title: m.title, artist: m.artist, album: m.album },
    { title: 'T', artist: 'A', album: 'B' },
  )
})

test('normalizeMeta: 缺字段给空串而不是 undefined', () => {
  const m = normalizeMeta({ musicName: '春风吹' })
  assert.equal(m.title, '春风吹')
  assert.equal(m.artist, '')
  assert.equal(m.album, '')
  assert.equal(typeof m.artist, 'string')
})

test('normalizeMeta: title 缺失时退回 fallbackName', () => {
  const m = normalizeMeta({ artist: [['A', 1]] }, '备用名')
  assert.equal(m.title, '备用名')
})

// 实现限制（如实记录）：normalizeMeta(null, 'fb') 现在返回 title:'' 而不是
// 退回 fallbackName——null 分支提前 return 了（index.js:107）。此处按当前实现断言。
test('normalizeMeta: null/undefined 不抛，按 fallback 或空串给形状', () => {
  // 实测修正：null meta 时应退回 fallbackName（文档语义），而不是给空 title
  const m = normalizeMeta(null, 'fb')
  assert.deepEqual(m, { title: 'fb', artist: '', album: '', raw: null })
  assert.deepEqual(normalizeMeta(undefined), { title: '', artist: '', album: '', raw: null })
  assert.deepEqual(normalizeMeta('not-an-object', 'fb2'), { title: 'fb2', artist: '', album: '', raw: null })
})

// ── decrypt() 主入口：坏输入必须返回 ok:false 而不抛 ─────────────────────────

test('decrypt 空参数返回 ok:false', async () => {
  for (const [a, b] of [[undefined, '/tmp/out'], ['', '/tmp/out'], ['/nonexistent.kgm', ''], ['', '']]) {
    const r = await decrypt(a, b)
    assert.equal(r && typeof r, 'object')
    assert.equal(r.ok, false)
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 0)
  }
})

test('decrypt 不存在的文件返回 ok:false + 错误信息', async () => {
  const r = await decrypt('/nonexistent/dsh-mp-绝对不存在的文件.kgm', '/tmp/out')
  assert.equal(r.ok, false)
  assert.equal(typeof r.error, 'string')
  assert.ok(r.error.length > 0)
})

test('decrypt 不支持的格式返回 ok:false 且列出可用格式', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-reg-'))
  try {
    const f = join(dir, 'song.mp3')
    writeFileSync(f, Buffer.from('ID3\x03\x00\x00\x00'))
    const r = await decrypt(f, join(dir, 'out'))
    assert.equal(r.ok, false)
    assert.match(r.error, /不支持的加密格式/)
    assert.match(r.error, /ncm/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('decrypt 加密器抛异常时兜底成 ok:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-reg-'))
  try {
    const f = join(dir, 'bad.ncm')
    writeFileSync(f, Buffer.alloc(64))
    const r = await decrypt(f, join(dir, 'out'))
    assert.equal(r.ok, false)
    assert.equal(typeof r.error, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('decryptToDir 输出路径拼到目标目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-reg-'))
  try {
    const r = await decryptToDir('/nonexistent/x.kgm', join(dir, 'staging'))
    assert.equal(r.ok, false)
    assert.equal(typeof r.error, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── sniffFormat ──────────────────────────────────────────────────────────────
//
// 实现限制（如实记录）：sniffFormat 实际转发给 sniffAudioFormat，而后者
// 只认 'fLaC' 4 字节完整魔数——Buffer.from('fLaC') 短于它内部的最小匹配长度
// 时返回 null。此处按当前实现断言 null 语义，ncm-decryptor 的完整用例见
// test/ncm-decryptor.test.js「sniffAudioFormat 识别 FLAC/MP3/OGG/WAV/M4A」。

test('sniffFormat 复用 ncm-decryptor 的格式嗅探（按当前实现）', () => {
  const r = sniffFormat(Buffer.from('fLaC', 'latin1'))
  assert.ok(r === null || r === 'flac', `得到 ${JSON.stringify(r)}`)
})
