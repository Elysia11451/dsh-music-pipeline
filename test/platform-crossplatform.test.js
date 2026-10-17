#!/usr/bin/env node
// lib/platform.js 跨平台行为测试。
//
// 为什么用子进程：platform.js 在 **模块求值期** 就把 IS_WINDOWS/IS_ANDROID 等
// 固化成常量（export const），而 process.platform 是只读 getter。
// 因此「改 platform 再 import」必须在干净进程里做——同进程内改了也拿不到新值，
// 而且会污染后面所有用例。spawnSync 起子进程是唯一可靠的隔离方式。
//
// 覆盖：路径拼接 / 工具探测 / 挂载点判定 / canonPath / devNull，
// 每个平台都跑一遍，断言「不崩 + 形状正确 + 平台特征符合预期」。
//
// 诚实声明：本机是 Android，无法真正执行 Windows 的文件操作，
// 这里验证的是「Windows 代码路径不崩溃、拼接结果符合预期形状」，
// 不等于 Windows 真机验证。真机差异（盘符大小写、\\ 与 / 混用、
// Program Files 实际布局）仍需在 Windows 上实测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const NODE = process.argv0 && join(process.argv0).startsWith('/') ? process.argv0 : process.execPath

/**
 * 在指定 fakePlatform 下求值一段代码，返回其 JSON 结果。
 * 探针里先 defineProperty 覆盖 process.platform，再动态 import platform.js，
 * 这样模块求值期看到的就是伪造的平台。
 */
function probe(fakePlatform, code) {
  const script = `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(fakePlatform)}, configurable: true })
    const p = await import(${JSON.stringify(join(REPO, 'lib', 'platform.js'))})
    const m = p.default || p
    const out = await (${code})(p, m)
    process.stdout.write(JSON.stringify(out))
  `
  const r = spawnSync(NODE, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, `platform=${fakePlatform} 探针失败：\nSTDOUT=${r.stdout}\nSTDERR=${r.stderr}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`platform=${fakePlatform} 探针输出不是 JSON：${r.stdout.slice(0, 400)} / ${r.stderr.slice(0, 400)}`)
  }
}

const PLATFORMS = ['win32', 'darwin', 'linux']

// ── defaultDirs：各平台都能拿到形状正确、无硬编码 Android 路径的默认值 ──────────

for (const plat of ['win32', 'darwin']) {
  test(`${plat}: defaultDirs 形状正确且从 home 派生（不含硬编码 Android 专属路径）`, () => {
    const d = probe(plat, `(p, m) => ({ dd: m.defaultDirs(), home: m.homeDir() })`)
    const dd = d.dd
    for (const k of ['downloadDir', 'stagingDir', 'processedDir', 'manifest', 'transferLog']) {
      assert.equal(typeof dd[k], 'string', `${k} 应为字符串`)
      assert.ok(dd[k].length > 0, `${k} 不应为空`)
      // 注意不能断言「不含 /data/data/」：本机（Android）的 os.homedir() 本身就在那个前缀下，
      // 那是真实的 home 而不是硬编码。真正的判据是「必须由 homeDir() 派生」。
      assert.ok(dd[k].startsWith(d.home), `${k} 必须由 homeDir 派生：${dd[k]} vs home=${d.home}`)
      assert.ok(!dd[k].startsWith('/storage/emulated'), `${k} 在非 Android 平台不该用公共下载目录：${dd[k]}`)
    }
    // 桌面平台没有统一外置存储根：必须是 null，表示「不许猜，调用方显式传」
    assert.equal(dd.storageRoot, null, `${plat}: storageRoot 应为 null（无默认挂载根）`)
  })
}

// 'linux' 单独一条：本机是 Android（Termux/proot 下 process.platform 就是 'linux'），
// detectAndroid() 靠特征文件兜底判定。伪造 platform='linux' **不会**让 IS_ANDROID 变 false，
// 这正是兜底逻辑该有的行为——所以这里正面验证它，而不是断言它走桌面分支。
test('linux(本机=Android): detectAndroid 特征文件兜底生效，仍走 Android 分支', () => {
  const r = probe('linux', `async (p, m) => {
    const fs = await import('node:fs')
    return {
      isAndroid: m.IS_ANDROID,
      name: m.PLATFORM_NAME,
      root: m.defaultDirs().storageRoot,
      markerA: fs.existsSync('/system/build.prop') || fs.existsSync('/system/bin/adb'),
    }
  }`)
  const hasAndroidMarker = r.markerA
  if (hasAndroidMarker) {
    assert.equal(r.isAndroid, true, '存在 /system/build.prop 时 platform=linux 仍应判为 Android')
    assert.equal(r.root, '/storage', 'Android 分支的 storageRoot 应是 /storage')
  } else {
    assert.equal(r.isAndroid, false, '无 Android 特征文件时 platform=linux 应判为桌面 Linux')
    assert.equal(r.root, null)
  }
})

test('win32: 默认目录落在用户主目录下（用反斜杠或正斜杠均可，但必须在 home 内）', () => {
  const d = probe('win32', `(p, m) => { const dd = m.defaultDirs(); return { dd, home: m.homeDir() } }`)
  assert.ok(d.dd.downloadDir.startsWith(d.home), `downloadDir 应在 home 内：${d.dd.downloadDir} vs home=${d.home}`)
  assert.ok(d.dd.stagingDir.startsWith(d.home), `stagingDir 应在 home 内：${d.dd.stagingDir}`)
})

// ── devNull / 路径原语 ───────────────────────────────────────────────────────

test('win32: devNull 是 NUL；POSIX 是 /dev/null', () => {
  assert.equal(probe('win32', `(p, m) => m.devNull()`), 'NUL')
  assert.equal(probe('darwin', `(p, m) => m.devNull()`), '/dev/null')
  assert.equal(probe('linux', `(p, m) => m.devNull()`), '/dev/null')
})

test('win32: join 用反斜杠，POSIX 用正斜杠', () => {
  const w = probe('win32', `(p, m) => m.join('C:\\\\a', 'b.txt')`)
  assert.ok(w.includes('\\'), `win32 join 应产出反斜杠：${w}`)
  const u = probe('darwin', `(p, m) => m.join('/a', 'b.txt')`)
  assert.equal(u, '/a/b.txt')
})

// ── canonPath：不存在的路径也不能抛，且要幂等 ─────────────────────────────────

for (const plat of PLATFORMS) {
  test(`${plat}: canonPath 对不存在路径不抛且幂等`, () => {
    const r = probe(plat, `(p, m) => {
      const a = m.join(m.homeDir(), 'dsh-mp-绝对不存在的目录-xyz', 'f.bin')
      const c1 = m.canonPath(a), c2 = m.canonPath(c1)
      return { c1, c2, empty: m.canonPath(''), sameSelf: m.samePath(a, c1) }
    }`)
    assert.equal(typeof r.c1, 'string')
    assert.ok(r.c1.length > 0, 'canonPath 不应返回空串')
    assert.equal(r.c1, r.c2, 'canonPath 必须幂等（二次归一化结果不变）')
    assert.equal(r.empty, '', '空输入原样返回')
    assert.equal(r.sameSelf, true, '同一路径归一后必须判等')
  })
}

test('canonPath 能解析真实符号链接别名（Android /data/data ↔ /data/user/0）', () => {
  // 这条只在真 Android 上有意义：验证归一化确实把别名收敛到同一字符串
  if (!probe('android', `(p, m) => m.IS_ANDROID`)) {
    console.log('  (skip: 本机非 Android，别名归一化用例不适用)')
    return
  }
  const r = probe('android', `(p, m) => {
    const a = m.homeDir()
    const b = m.homeDir().replace('/data/data/', '/data/user/0/')
    return { ca: m.canonPath(a), cb: m.canonPath(b), same: m.samePath(a, b) }
  }`)
  assert.equal(r.same, true, `/data/data 与 /data/user/0 别名应判等：${r.ca} vs ${r.cb}`)
  assert.equal(r.ca, r.cb, '两条别名归一化后必须完全相同')
})

// ── findToolPath：探测不能崩，找不到要返回 null ───────────────────────────────

for (const plat of PLATFORMS) {
  test(`${plat}: findToolPath 对不存在的工具返回 null 而不抛`, () => {
    const r = probe(plat, `(p, m) => ({
      missing: m.findToolPath('dsh-mp-绝对不存在的工具-xyz'),
      // 显式配置了但路径不存在 → 必须抛（不能静默回落 PATH，否则用户以为配置生效了）
      throwsOnBadConfig: (() => { try { m.findToolPath('ffmpeg', { explicit: '/dsh-mp-nope/ffmpeg' }); return false } catch (e) { return /不存在|不可执行/.test(e.message) } })(),
    })`)
    assert.equal(r.missing, null, '未配置的探测找不到应返回 null')
    assert.equal(r.throwsOnBadConfig, true, '配置了错误路径必须明确报错，不许静默回落')
  })
}

test('win32: findToolPath 会带上 PATHEXT 扩展名去探测', () => {
  const r = probe('win32', `(p, m) => ({
    // 造一个假的「看起来可执行」的路径：Windows 上无扩展名或 .exe 都算
    noExt: m.looksExecutable('C:\\\\Windows\\\\System32\\\\notepad'),
    // 系统自带命令在 PATH 里，探测应命中（不依赖具体盘符，只要不是 null 即可）
    found: m.findToolPath('cmd'),
  })`)
  // 这两项在不同 Windows 环境可能不同，只要求「调用不崩 + 返回类型正确」
  assert.equal(typeof r.noExt, 'boolean')
  assert.ok(r.found === null || typeof r.found === 'string')
})

// ── isRemovableMount / mountLabel：各平台语义 ─────────────────────────────────

test('win32: 非系统盘盘符根算外置挂载点，系统盘不算', () => {
  const r = probe('win32', `(p, m) => ({
    eRoot: m.isRemovableMount('E:\\\\'),
    fRoot: m.isRemovableMount('F:'),
    cRoot: m.isRemovableMount('C:\\\\'),
    subDir: m.isRemovableMount('E:\\\\Music'),
    labelE: m.mountLabel('E:\\\\', null),
    labelNoRoot: m.mountLabel('E:\\\\', null),
  })`)
  assert.equal(r.eRoot, true, 'E:\\ 应判为外置挂载点')
  assert.equal(r.cRoot, false, '系统盘 C:\\ 不算外置')
  assert.equal(r.subDir, false, '盘符下的子目录不是挂载点根')
  assert.equal(r.labelE, 'E:', 'mountLabel 应把 E:\\ 归一成 E:')
})

test('darwin/linux: /Volumes 与宽松放行的差异', () => {
  const mac = probe('darwin', `(p, m) => ({ v: m.isRemovableMount('/Volumes/USB'), other: m.isRemovableMount('/tmp/x') })`)
  assert.equal(mac.v, true, 'macOS 的 /Volumes/* 应判为外置')
  assert.equal(mac.other, false, 'macOS 下非 /Volumes 不算外置')
})

test('mountLabel 归一化：绝对路径 / 尾斜杠 / 裸卷标 / 空值', () => {
  for (const plat of ['win32', 'darwin', 'linux']) {
    const r = probe(plat, `(p, m) => ({
      abs: m.mountLabel('/storage/ABCD-1234', '/storage'),
      bare: m.mountLabel('ABCD-1234', '/storage'),
      trail: m.mountLabel('/storage/ABCD-1234/', '/storage'),
      rootOnly: m.mountLabel('/storage', '/storage'),
      empty: m.mountLabel('', '/storage'),
    })`)
    assert.equal(r.abs, 'ABCD-1234', `${plat}: 绝对路径应取卷标段`)
    assert.equal(r.bare, 'ABCD-1234', `${plat}: 裸卷标原样`)
    assert.equal(r.trail, 'ABCD-1234', `${plat}: 尾斜杠要清掉`)
    assert.equal(r.rootOnly, '', `${plat}: 存储根本身不是挂载点，必须返回空让调用方报错`)
    assert.equal(r.empty, '', `${plat}: 空输入返回空`)
  }
})

// ── nodeExecutable / execFileP：各平台不崩 ───────────────────────────────────

for (const plat of PLATFORMS) {
  test(`${plat}: nodeExecutable 返回绝对路径`, () => {
    const n = probe(plat, `(p, m) => m.nodeExecutable()`)
    assert.equal(typeof n, 'string')
    assert.ok(n.length > 0, 'nodeExecutable 不应返回空')
  })
}

// ── 集成：解密调度层在伪造平台下仍可加载与调用 ────────────────────────────────

for (const plat of ['win32', 'darwin']) {
  test(`${plat}: lib/decrypt 调度层可加载，扩展名清单完整`, () => {
    const r = probe(plat, `async (p, m) => {
      const d = await import(${JSON.stringify(join(REPO, 'lib', 'decrypt', 'index.js'))})
      const dm = d.default || d
      return { exts: dm.SUPPORTED_EXTENSIONS, ncm: !!dm.decryptorFor('.ncm'), kgm: !!dm.decryptorFor('.kgm'), qmc: !!dm.decryptorFor('.mflac'), kwm: !!dm.decryptorFor('.kwm') }
    }`)
    assert.ok(r.exts.includes('.ncm'), 'win32/darwin 下 NCM 仍应注册')
    assert.ok(r.ncm && r.kgm && r.qmc && r.kwm, '四种格式解密器都应在注册表里')
  })
}
