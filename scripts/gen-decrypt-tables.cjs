#!/usr/bin/env node
// scripts/gen-decrypt-tables.cjs — 解密器常量表生成器
//
// 为什么存在：KGM/VPR 的 3×272 字节掩码表、QMC 的 256 字节 S 盒这类常量
// 手抄必错（一个字节错整首歌就解不出来），且无法用算法生成。
// 本脚本从上游参考实现中**程序化提取**这些表，写进 lib/decrypt/*.js。
//
// 用法：
//   node scripts/gen-decrypt-tables.cjs <参考实现目录>
//
// 参考实现（MIT 许可）需要预先放到目录里，本仓库不内置它们：
//   kgm.js  ← nowa277/OpenConverter  src/decoders/kgm.js   (MIT)
//   kwm.js  ← nowa277/OpenConverter  src/decoders/kwm.js   (MIT)
//   qmc.js  ← nowa277/OpenConverter  src/decoders/qmc.js   (MIT)
// 下载：git clone --depth 1 https://github.com/nowa277/OpenConverter
//       （若该仓库也不可用，可换任何同样 MIT 许可的等价实现，
//         但必须先在 LICENSE 文件里补上署名。）
//
// 幂等：重复执行结果一致。只重写常量表区块，不动解密逻辑。
// 退出码：0 成功；1 参数/文件缺失；2 上游实现缺表（版本不兼容）。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 每个目标文件：{ out, marker, tables: [{name, src: 参考文件名, expr, 在新文件里的导出名}] }
const TARGETS = [
  {
    out: path.join(__dirname, '..', 'lib', 'decrypt', 'kgm.js'),
    tables: [
      { name: 'KGM_HEADER', src: 'kgm.js', expr: 'KGM_HEADER' },
      { name: 'VPR_HEADER', src: 'kgm.js', expr: 'VPR_HEADER' },
      { name: 'VPR_MASK_DIFF', src: 'kgm.js', expr: 'VPR_MASK_DIFF' },
      { name: 'MASK_V2_PRE_DEF', src: 'kgm.js', expr: 'MASK_V2_PRE_DEF' },
      { name: 'TABLE1', src: 'kgm.js', expr: 'TABLE1' },
      { name: 'TABLE2', src: 'kgm.js', expr: 'TABLE2' },
    ],
  },
  {
    out: path.join(__dirname, '..', 'lib', 'decrypt', 'kwm.js'),
    tables: [
      { name: 'KWM_MAGIC', src: 'kwm.js', expr: 'MAGIC' },
      { name: 'KWM_ROOT', src: 'kwm.js', expr: 'ROOT' },
    ],
  },
  {
    out: path.join(__dirname, '..', 'lib', 'decrypt', 'qmc.js'),
    tables: [
      { name: 'QMC1_STATIC_BOX', src: 'qmc.js', expr: 'QMC1_STATIC_BOX' },
      { name: 'QMC_SEED_MAP', src: 'qmc.js', expr: 'SEED_MAP', flatten: true },
      { name: 'QMC_MIX_KEY_1', src: 'qmc.js', expr: 'MIX_KEY_1' },
      { name: 'QMC_MIX_KEY_2', src: 'qmc.js', expr: 'MIX_KEY_2' },
    ],
  },
]

const BEGIN = '// ── 常量表（自动生成，勿手改） ────────────────────────────────────────────────'
const END = '// ── 音频格式探测 ──'

function emitTable(name, buf, indent = '  ') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length === 0) throw new Error(`表 ${name} 长度为 0`)
  const lines = []
  for (let i = 0; i < b.length; i += 16) {
    lines.push(indent + Array.from(b.subarray(i, i + 16)).map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', '))
  }
  return `export const ${name} = new Uint8Array([\n${lines.join(',\n')}\n])`
}

/** 在 vm 沙箱里跑参考实现，取出闭包内的常量表 */
function loadTables(refDir, srcFile, names) {
  const file = path.join(refDir, srcFile)
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺少参考实现：${file}`)
    console.error(`  请先按文件头注释准备好 MIT 许可的参考实现目录`)
    process.exit(1)
  }
  const src = fs.readFileSync(file, 'utf8')
  const sandbox = { require, module: { exports: {} }, exports: {}, Buffer, console, Uint8Array, Math, process, fetch }
  sandbox.module.exports = {}
  vm.createContext(sandbox)
  try {
    vm.runInContext(src, sandbox, { timeout: 10000 })
  } catch (e) {
    console.error(`✗ 执行参考实现 ${srcFile} 失败：${e?.message ?? e}`)
    process.exit(2)
  }
  const expr = `({${names.join(',')}})`
  let tables
  try {
    tables = vm.runInContext(expr, sandbox)
  } catch (e) {
    console.error(`✗ 参考实现 ${srcFile} 中找不到表 ${names.join('/')}（${e?.message ?? e}）`)
    console.error('  上游实现可能已改版——请核对变量名后更新本脚本')
    process.exit(2)
  }
  return tables
}

function main() {
  const refDir = process.argv[2]
  if (!refDir) {
    console.error('用法：node scripts/gen-decrypt-tables.cjs <参考实现目录>')
    process.exit(1)
  }
  const abs = path.resolve(refDir)
  if (!fs.existsSync(abs)) {
    console.error(`✗ 目录不存在：${abs}`)
    process.exit(1)
  }
  console.log(`参考实现目录：${abs}`)

  let changed = 0
  for (const t of TARGETS) {
    const outPath = t.out
    if (!fs.existsSync(outPath)) {
      console.log(`· 跳过 ${path.basename(outPath)}（文件不存在）`)
      continue
    }
    const orig = fs.readFileSync(outPath, 'utf8')
    const bi = orig.indexOf(BEGIN)
    if (bi < 0) {
      console.log(`· 跳过 ${path.basename(outPath)}（找不到常量表起始标记）`)
      continue
    }
    // 结束标记：取起始标记之后第一个「── ──」样式的分节注释；找不到就用文件尾
    const after = orig.slice(bi + BEGIN.length)
    const ei = after.search(/\n\/\/ ── /)
    const endIdx = ei < 0 ? orig.length : bi + BEGIN.length + ei + 1

    // 按 src 分组加载，避免同一个文件跑多遍
    const bySrc = new Map()
    for (const tb of t.tables) {
      if (!bySrc.has(tb.src)) bySrc.set(tb.src, [])
      bySrc.get(tb.src).push(tb)
    }
    const chunks = []
    for (const [srcFile, tbs] of bySrc) {
      const tables = loadTables(abs, srcFile, tbs.map((x) => x.expr))
      for (const tb of tbs) {
        let v = tables[tb.expr]
        if (v === undefined || v === null) {
          console.error(`✗ ${srcFile} 中 ${tb.expr} 为空`)
          process.exit(2)
        }
        // SEED_MAP 是 [[...],[...]] 二维数组，拍平成一维
        if (tb.flatten && Array.isArray(v) && Array.isArray(v[0])) {
          v = Uint8Array.from(v.flat())
        }
        if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array) && !Array.isArray(v)) {
          console.error(`✗ ${srcFile} 的 ${tb.expr} 不是字节表（${typeof v}）`)
          process.exit(2)
        }
        chunks.push(emitTable(tb.name, v))
      }
    }
    const block = `${BEGIN}\n\n${chunks.join('\n\n')}\n\n`
    const next = orig.slice(0, bi) + block + orig.slice(endIdx)
    if (next !== orig) {
      fs.writeFileSync(outPath, next)
      console.log(`✓ 更新 ${path.relative(process.cwd(), outPath)}（${t.tables.length} 张表）`)
      changed++
    } else {
      console.log(`· ${path.basename(outPath)} 已是最新`)
    }
  }
  console.log(changed === 0 ? '所有表均为最新，无改动。' : `已更新 ${changed} 个文件。请跑 npm test 验证。`)
}

main()
