#!/usr/bin/env node
// 多格式解密器测试：酷狗 KGM/VPR、QQ音乐 QMC 系列、酷我 KWM。
//
// 三层验证，强度递增：
//   ① 契约：FORMATS/LABEL/decryptFile 形状正确
//   ② 坏输入：真魔数 + 垃圾字节 / 空文件 / 不存在路径 → 必须返回 {ok:false,error} 不抛
//   ③ 正向还原：测试**独立实现加密器**（不复用被测模块的解密函数），
//      明文 → 自加密 → decryptFile → 与明文逐字节比对。
//      解密器算法有任何一处错，这一层就红——这才是真证据。
//      （与上游 MIT 参考实现的逐字节交叉验证在开发阶段已单独做过，见 CHANGELOG。）
//
// 设计原则（与 test/ncm-decryptor.test.js 一致）：
//   - 零第三方测试框架：node:test + node:assert/strict
//   - 完全自包含：mkdtempSync 临时目录 + 合成字节流，不依赖任何真实加密音频
//   - 真实魔数从被测模块导出的常量表取（KGM_HEADER/VPR_HEADER/KWM_MAGIC/...），
//     不再用拍脑袋编的假魔数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import * as kgm from '../lib/decrypt/kgm.js'
import * as kwm from '../lib/decrypt/kwm.js'
import * as qmc from '../lib/decrypt/qmc.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function scratch(name) {
  return mkdtempSync(join(tmpdir(), 'dsh-mp-' + name + '-'))
}

/** 确定性伪随机明文（可复现），前缀塞一个合法音频魔数让格式探测能命中 */
function fakePlain(size = 50000, magic = 'fLaC') {
  const b = Buffer.alloc(size)
  Buffer.from(magic, 'latin1').copy(b, 0)
  let s = 1234567
  for (let i = 4; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    b[i] = s & 0xff
  }
  return b
}

/** 通用坏输入断言 */
function assertBadInput(r, label) {
  assert.equal(r && typeof r, 'object', label + ': 返回值必须是对象')
  assert.equal(r.ok, false, label + ': 坏输入必须 ok:false')
  assert.equal(typeof r.error, 'string', label + ': error 必须是字符串')
  assert.ok(r.error.length > 0, label + ': error 不能是空串')
}

// ── 测试侧独立加密器（不复用被测模块的解密/掩码函数） ─────────────────────────

/** KGM/VPR 的 getMask：从导出的常量表独立复现（算法见 kgm.js 头注释） */
function testGetMask(pos) {
  let offset = pos >> 4
  let value = 0
  while (offset >= 0x11) {
    value ^= kgm.TABLE1[offset % 272]
    offset >>= 4
    value ^= kgm.TABLE2[offset % 272]
    offset >>= 4
  }
  return kgm.MASK_V2_PRE_DEF[pos % 272] ^ value
}

/**
 * KGM/VPR 加密器（解密的逆运算）。
 * 解密：out = ((key^in)^((key^in)&0x0f)<<4) ^ maskForm
 * 加密：对每字节反推——先剥 mask 交换，再剥 med 的高低半字节混合，最后 XOR key。
 */
function testKgmEncrypt(data, key17, isVpr, startOffset) {
  for (let i = 0; i < data.length; i++) {
    const pos = startOffset + i
    let msk8 = testGetMask(pos)
    msk8 ^= (msk8 & 0x0f) << 4
    let med8 = data[i] ^ msk8
    if (isVpr) med8 ^= kgm.VPR_MASK_DIFF[pos % 17]
    // 逆 med8 ^= (med8 & 0x0f) << 4：低 4 位不变，高 4 位 = 原高 4 位 ^ 低 4 位
    const low = med8 & 0x0f
    const high = (med8 >> 4) ^ low
    data[i] = ((high << 4) | low) ^ key17[pos % 17]
  }
}

/** KWM 加密器：32 字节掩码循环 XOR（对称，加密=解密），掩码独立复现 */
function testKwmMask(seed) {
  const decimal = String(seed >>> 0)
  const mask = new Uint8Array(32)
  for (let i = 0; i < Math.min(decimal.length, 32); i++) mask[i] = decimal.charCodeAt(i)
  for (let i = 0; i < 32; i++) mask[i] ^= kwm.KWM_ROOT[i]
  return mask
}

/** QMC V1 掩码独立复现：box[(i*i+27)&0xff] */
function testQmcV1Mask() {
  const m = new Uint8Array(32768)
  for (let i = 0; i < 32768; i++) m[i] = qmc.QMC1_STATIC_BOX[(i * i + 27) & 0xff]
  return m
}

// ── 合成文件构造器 ───────────────────────────────────────────────────────────

function synthKgm(magic, keyFill = 0xab, headerLen = 0x40) {
  const plain = fakePlain()
  // 容器头里只有 16 字节密钥；第 17 字节 key[16] 由 parseHeader 强制为 0。
  // 测试侧必须用同一规则，否则加/解密用的 key 不同，比对必然失败（第一版就踩了这里）。
  const key = new Uint8Array(17)
  key.fill(keyFill, 0, 16)
  key[16] = 0
  const hdr = Buffer.alloc(headerLen)
  Buffer.from(magic).copy(hdr, 0)
  hdr.writeUInt32LE(headerLen, 0x10)
  Buffer.from(key.buffer, key.byteOffset, 16).copy(hdr, 0x1c)
  const file = Buffer.concat([hdr, plain])
  testKgmEncrypt(file.subarray(headerLen), key, magic === kgm.VPR_HEADER, 0)
  return { file, plain }
}

function synthKwm() {
  const plain = fakePlain(40000)
  const seed = 987654321
  const mask = testKwmMask(seed)
  const hdr = Buffer.alloc(0x400)
  Buffer.from(kwm.KWM_MAGIC).copy(hdr, 0)
  hdr.writeUInt32LE(seed, 0x10)
  const file = Buffer.concat([hdr, plain])
  for (let i = 0; i < plain.length; i++) file[0x400 + i] ^= mask[i % 32]
  return { file, plain }
}

function synthQmcV1() {
  const plain = fakePlain(30000, 'ID3\x04')
  const mask = testQmcV1Mask()
  const file = Buffer.from(plain)
  for (let i = 0; i < file.length; i++) file[i] ^= mask[i < 32768 ? i : i % 32768]
  return { file, plain }
}

/** QMC V2 / STag 头部布局 + 短 ekey（走 MapMask 分支） */
function synthQmcV2() {
  const plain = fakePlain()
  // ekey 必须 <16 字节：qmcDeriveKey 对短输入直接原样返回（不做 TEA），
  // 这样测试侧与被测侧用的是同一把密钥，比对才有意义。
  // （≥16 字节会进 TEA 派生，失败才 fallback——路径不确定，不适合做正检验。）
  const rawKey = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) rawKey[i] = (i * 13 + 9) & 0xff
  const ekey = rawKey.toString('base64')
  // 独立复现 MapMask：keyCompress(rawKey) 循环成 32768
  const n = rawKey.length
  const wkey = Buffer.alloc(128)
  for (let i = 0; i < 128; i++) {
    const idx = (i * i + 71214) % n
    const shift = (idx + 4) % 8 // 已在 0..7，无需再 &7
    let byte = rawKey[idx]
    if (shift !== 0) byte = ((byte << shift) | (byte >>> shift)) & 0xff
    wkey[i] = byte
  }
  const file = Buffer.alloc(0x18 + ekey.length + plain.length)
  file.write('STag', 0, 'ascii')
  file.writeUInt32LE(ekey.length, 0x14)
  Buffer.from(ekey, 'ascii').copy(file, 0x18)
  plain.copy(file, 0x18 + ekey.length)
  const audioStart = 0x18 + ekey.length
  for (let i = 0; i < plain.length; i++) {
    file[audioStart + i] ^= wkey[i % 128]
  }
  return { file, plain }
}

// ── ① 契约 ───────────────────────────────────────────────────────────────────

test('kgm.js 契约：FORMATS/LABEL/decryptFile', () => {
  assert.deepEqual(kgm.FORMATS, ['.kgm', '.kgma', '.vpr'])
  for (const e of kgm.FORMATS) assert.match(e, /^\.[a-z0-9]+$/)
  assert.equal(typeof kgm.LABEL, 'string')
  assert.equal(typeof kgm.decryptFile, 'function')
})

test('kwm.js 契约：FORMATS/LABEL/decryptFile', () => {
  assert.deepEqual(kwm.FORMATS, ['.kwm'])
  assert.equal(typeof kwm.LABEL, 'string')
  assert.equal(typeof kwm.decryptFile, 'function')
})

test('qmc.js 契约：FORMATS 覆盖 V1/V2 主要后缀', () => {
  for (const e of ['.qmc0', '.qmc3', '.qmcflac', '.qmcogg', '.mflac', '.mgg']) {
    assert.ok(qmc.FORMATS.includes(e), '缺少 ' + e)
  }
  assert.equal(typeof qmc.decryptFile, 'function')
})

// ──  坏输入 ────────────────────────────────────────────────────────────────

const BAD_CASES = [
  { label: 'KGM 真魔数+垃圾', mod: kgm, ext: '.kgm', make: () => Buffer.concat([Buffer.from(kgm.KGM_HEADER), Buffer.alloc(600, 0x5a)]) },
  { label: 'VPR 真魔数+垃圾', mod: kgm, ext: '.vpr', make: () => Buffer.concat([Buffer.from(kgm.VPR_HEADER), Buffer.alloc(600, 0x5a)]) },
  { label: 'KWM 真魔数+垃圾', mod: kwm, ext: '.kwm', make: () => { const b = Buffer.alloc(0x400 + 512); Buffer.from(kwm.KWM_MAGIC).copy(b, 0); return b } },
  { label: 'QMC 随机字节', mod: qmc, ext: '.qmc0', make: () => Buffer.alloc(4096, 0x37) },
  { label: 'QMC STag 假头', mod: qmc, ext: '.mflac', make: () => { const b = Buffer.alloc(2048); b.write('STag', 0, 'ascii'); b.writeUInt32LE(64, 0x14); return b } },
]

for (const c of BAD_CASES) {
  test(`坏输入不抛：${c.label}`, async () => {
    const dir = scratch('bad')
    try {
      const f = join(dir, 'x' + c.ext)
      writeFileSync(f, c.make())
      const r = await c.mod.decryptFile(f, join(dir, 'out'))
      assertBadInput(r, c.label)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('坏输入不抛：空文件 / 不存在路径（三个模块）', async () => {
  const dir = scratch('bad2')
  try {
    for (const mod of [kgm, kwm, qmc]) {
      const empty = join(dir, 'empty' + mod.FORMATS[0])
      writeFileSync(empty, Buffer.alloc(0))
      assertBadInput(await mod.decryptFile(empty, join(dir, 'o1')), mod.LABEL + ' 空文件')
      assertBadInput(await mod.decryptFile(join(dir, 'nope' + mod.FORMATS[0]), join(dir, 'o2')), mod.LABEL + ' 不存在')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ──  正向还原（核心证据） ───────────────────────────────────────────────────

const GOOD_CASES = [
  { label: 'KGM', mod: kgm, ext: '.kgm', synth: () => synthKgm(kgm.KGM_HEADER), fmt: 'flac' },
  { label: 'KGMA 走 KGM 头', mod: kgm, ext: '.kgma', synth: () => synthKgm(kgm.KGM_HEADER), fmt: 'flac' },
  { label: 'VPR', mod: kgm, ext: '.vpr', synth: () => synthKgm(kgm.VPR_HEADER), fmt: 'flac' },
  { label: 'KWM', mod: kwm, ext: '.kwm', synth: synthKwm, fmt: 'flac' },
  { label: 'QMC V1 (.qmc0)', mod: qmc, ext: '.qmc0', synth: synthQmcV1, fmt: 'mp3' },
  { label: 'QMC V2 STag+MapMask (.mflac)', mod: qmc, ext: '.mflac', synth: synthQmcV2, fmt: 'flac' },
]

for (const c of GOOD_CASES) {
  test(`正向还原：${c.label} 明文→加密→解密 逐字节一致`, async () => {
    const dir = scratch('good')
    try {
      const { file, plain } = c.synth()
      const f = join(dir, 'song' + c.ext)
      writeFileSync(f, file)
      const r = await c.mod.decryptFile(f, join(dir, 'song'))
      assert.equal(r.ok, true, c.label + ' 解密失败：' + (r.error || '?'))
      // 格式探测以明文头部为准（每个用例头部塞的魔数不同，fmt 逐用例指定）
      assert.equal(r.format, c.fmt, c.label + ': 格式探测应为 ' + c.fmt)
      const got = readFileSync(r.output)
      assert.equal(got.length, plain.length, c.label + ': 长度不一致')
      // 用 Buffer.compare 而非 assert.deepEqual(Array)：后者对 5 万元素会展开成
      // 巨型 diff 结构，本机实测单用例 23 秒；compare 是 memcmp，毫秒级。
      assert.equal(Buffer.compare(got, plain), 0, c.label + ': 字节不一致')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('正向还原：QMC V1 (.qmc0) 明文是 ID3 → format=mp3', async () => {
  const dir = scratch('good-mp3')
  try {
    const { file, plain } = synthQmcV1()
    const f = join(dir, 'song.qmc0')
    writeFileSync(f, file)
    const r = await qmc.decryptFile(f, join(dir, 'song'))
    assert.equal(r.ok, true, '解密失败：' + (r.error || '?'))
    assert.equal(r.format, 'mp3')
    assert.deepEqual(Array.from(readFileSync(r.output)), Array.from(plain))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏密钥的 V2 文件必须失败而不是产出垃圾', async () => {
  const dir = scratch('badkey')
  try {
    // 用 A 密钥加密、容器里写 B 密钥（同为 8 字节，base64 等长可直接替换）。
    // 掩码完全不同 → 解出垃圾 → 格式探测必须拒绝。
    // （注意：不能只篡改 ekey 的某个字符——keyCompress 的索引 (i*i+71214)%n
    //   未必取得到那个字节，篡改可能不影响掩码，测试会假通过。）
    const { file } = synthQmcV2()
    const ekeyLen = file.readUInt32LE(0x14)
    const altKey = Buffer.alloc(8)
    for (let i = 0; i < 8; i++) altKey[i] = (i * 251 + 77) & 0xff
    const altEkey = Buffer.from(altKey.toString('base64'), 'ascii')
    assert.equal(altEkey.length, ekeyLen, '替换 ekey 必须等长，否则容器布局错位')
    const tampered = Buffer.from(file)
    altEkey.copy(tampered, 0x18)
    const f = join(dir, 't.mflac')
    writeFileSync(f, tampered)
    const r = await qmc.decryptFile(f, join(dir, 'out'))
    assert.equal(r.ok, false, '错误密钥下不应声称成功')
    assert.match(r.error, /不是可识别的音频流|ekey|密钥/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
