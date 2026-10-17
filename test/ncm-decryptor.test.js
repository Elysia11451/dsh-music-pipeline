#!/usr/bin/env node
// 内置 NCM 解密的单元测试（零第三方测试框架，node --test 即可）
// 覆盖：常量、密钥盒/密钥流、音频异或、格式嗅探、整文件解密、落盘入口
// 用法：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isNcm, buildKeyBox, buildKeystream, xorAudio, decryptNcm, decryptNcmToFile,
  sniffAudioFormat, NCM_CONSTANTS,
} from '../lib/ncm-decryptor.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// 参考 NCM 与参考 FLAC 通过环境变量注入，缺省时跳过依赖真实文件的用例
// （默认值指向测试自带的 smoke 夹具目录，不绑定任何具体机器）
const REF_NCM = process.env.NCM_REF_NCM || join(HERE, 'fixtures', 'reference.ncm')
const REF_FLAC = process.env.NCM_REF_FLAC || join(HERE, 'fixtures', 'reference.flac')
const HAS_REF = existsSync(REF_NCM) && existsSync(REF_FLAC)

test('常量与文档一致', () => {
  assert.equal(NCM_CONSTANTS.CORE_KEY.toString('ascii'), 'hzHRAmso5kInbaxW')
  assert.equal(NCM_CONSTANTS.META_KEY.toString('ascii'), "#14ljk_!\\]&0U<'(")
  assert.equal(NCM_CONSTANTS.META_PREFIX.toString('ascii'), "163 key(Don't modify):")
  assert.equal(NCM_CONSTANTS.KEY_PREFIX_LEN, 17)
  assert.equal(NCM_CONSTANTS.META_JSON_PREFIX_LEN, 6)
})

// 参考歌曲的元数据（与 NCM_REF_NCM 指定的文件对应，换文件时一并更新）
const REF_META = {
  musicName: '春风吹',
  artist: [['方大同', 2738]],
  album: 'Soulboy',
  audioLength: 19310233,
}

test('isNcm 按 magic 判定，不看后缀', () => {
  if (!HAS_REF) { console.log('  (skip: 未提供 NCM_REF_NCM/NCM_REF_FLAC，跳过真实文件用例)'); return }
  const real = readFileSync(REF_NCM)
  assert.equal(isNcm(real), true)
  assert.equal(isNcm(Buffer.from('fLaC\0\0\0\x22')), false)
  assert.equal(isNcm(Buffer.alloc(4)), false)
  assert.equal(isNcm(null), false)
})

test('密钥盒：固定 key 下的 S 盒确定性输出', () => {
  const box = buildKeyBox(Buffer.from('abc'))
  assert.equal(box.length, 256)
  // 置换盒是 0..255 的一个排列
  assert.equal(new Set(box).size, 256)
  assert.equal(buildKeyBox(Buffer.from('abc')).toString('hex'), box.toString('hex'))
})

test('密钥盒：空 key 必须报错', () => {
  assert.throws(() => buildKeyBox(Buffer.alloc(0)), /音频密钥为空/)
})

test('xorAudio：与固定密钥流异或可逆，且下标从 1 开始', () => {
  const ks = buildKeystream(buildKeyBox(Buffer.from('abc')))
  const data = new Uint8Array(300) // 故意越过 256，验证回绕
  const before = Buffer.from(data)
  xorAudio(ks, data, 0)
  // 下标从 1 开始：data[i] ^= ks[(i+1) & 0xff]
  assert.equal(data[0], before[0] ^ ks[1])          // (0+1)&0xff === 1
  assert.equal(data[255], before[255] ^ ks[0])       // (255+1)&0xff === 0
  assert.equal(data[256], before[256] ^ ks[1])       // (256+1)&0xff === 1，回绕验证
  assert.notDeepEqual(Array.from(data), Array.from(before))
  xorAudio(ks, data, 0)
  assert.deepEqual(Array.from(data), Array.from(before), '两次异或应还原')
})

test('sniffAudioFormat 识别 FLAC/MP3/OGG/WAV/M4A', () => {
  // 长度下限 12 字节（FLAC 头 + 可能的 ID3/OGG 头都要能判定）
  assert.equal(sniffAudioFormat(Buffer.from('fLaC' + '\0'.repeat(8))), 'flac')
  assert.equal(sniffAudioFormat(Buffer.from('OggS\0\x02' + '\0'.repeat(8))), 'ogg')
  assert.equal(sniffAudioFormat(Buffer.from('RIFF$\0\0\0WAVEfmt ')), 'wav')
  assert.equal(sniffAudioFormat(Buffer.from('ID3\x04\0\0\0\0\0\0' + '\0'.repeat(4))), 'mp3')
  assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3')
  assert.equal(sniffAudioFormat(Buffer.from('\0\0\0 ftypisom', 'binary')), 'm4a')
  assert.equal(sniffAudioFormat(Buffer.alloc(4)), null)
  assert.equal(sniffAudioFormat(Buffer.alloc(12)), null)
})

test('decryptNcm 真实文件：FLAC + 元数据 + 大小', () => {
  if (!HAS_REF) { console.log('  (skip: 未提供参考文件)'); return }
  const r = decryptNcm(readFileSync(REF_NCM))
  assert.equal(r.format, 'flac')
  assert.equal(r.audio.length, REF_META.audioLength)
  assert.equal(r.meta.musicName, REF_META.musicName)
  assert.deepEqual(r.meta.artist, REF_META.artist)
  assert.equal(r.meta.album, REF_META.album)
  assert.equal(sniffAudioFormat(r.audio), 'flac')
  // 封面应是 JPEG
  assert.ok(r.cover && r.cover.length > 1000)
  // 这首歌的密钥段实测 144 字节（并非所有文件都恰好 128），只验证合理范围
  assert.ok(r.keyLength > 0 && r.keyLength % 16 === 0)
})

test('decryptNcm 拒绝非 NCM', () => {
  assert.throws(() => decryptNcm(Buffer.from('not an ncm file at all')), /不是 NCM 文件/)
})

test('decryptNcmToFile：输出无扩展名时按探测格式补，且字节与参考一致', async () => {
  if (!HAS_REF) { console.log('  (skip: 未提供参考文件)'); return }
  const out = join(HERE, '.tmp-out', 'reference')
  rmSync(join(HERE, '.tmp-out'), { recursive: true, force: true })
  const r = await decryptNcmToFile(REF_NCM, out)
  assert.equal(r.ok, true)
  assert.equal(r.format, 'flac')
  assert.equal(r.output, out + '.flac')
  assert.equal(r.audioBytes, REF_META.audioLength)
  // 与历史产物逐字节比对（同源解密必须完全一致）
  assert.deepEqual(readFileSync(r.output), readFileSync(REF_FLAC))
  rmSync(join(HERE, '.tmp-out'), { recursive: true, force: true })
})

test('decryptNcmToFile：坏输入返回 ok:false 而不是抛', async () => {
  const bad = join(HERE, '.tmp-out', 'bad.ncm')
  rmSync(join(HERE, '.tmp-out'), { recursive: true, force: true })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(dirname(bad), { recursive: true })
  writeFileSync(bad, Buffer.from('garbage not ncm'))
  const r = await decryptNcmToFile(bad, join(HERE, '.tmp-out', 'bad'))
  assert.equal(r.ok, false)
  assert.match(r.error, /不是 NCM 文件/)
  const missing = await decryptNcmToFile(join(HERE, 'nope.ncm'), join(HERE, '.tmp-out', 'nope'))
  assert.equal(missing.ok, false)
  assert.match(missing.error, /ENOENT|no such file/)
  rmSync(join(HERE, '.tmp-out'), { recursive: true, force: true })
})
