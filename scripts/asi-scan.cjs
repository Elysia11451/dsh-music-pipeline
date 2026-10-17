#!/usr/bin/env node
// ASI 分号陷阱扫描器（开发期工具，不随包发布）
//
// 背景：本项目踩过 `const a = f()` 换行后跟 `({x} = ...)` 被合并解析成
// `f()({x} = ...)` 的坑，报 `TypeError: ... is not a function`。
// `node --check` 查不出来（语法合法），只有真实运行才炸，所以必须有静态扫描。
//
// 判据：某行以 `(` / `[` / 反引号 开头，且上一行结尾「不安全」→ 疑似陷阱。
// 安全结尾集合里**故意不含 `)` 和 `]`**——`f()` 后跟 `(x)` 正是陷阱本体，
// 把它们当安全会造成漏报（第一版就漏在这里）。
// 扫描前先 mask 掉注释与字符串，否则注释里的 `(` 会造成大量误报。
//
// 用法：node scripts/asi-scan.cjs [目录]
'use strict'
const fs = require('node:fs')
const path = require('node:path')

function walk(d) {
  let r = []
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) r = r.concat(walk(p))
    else if (/\.(js|mjs|cjs)$/.test(e.name)) r.push(p)
  }
  return r
}

/** 把注释/字符串内容替换成等长空白，保留换行以维持行号 */
function mask(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && d === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '
      i += 2
      continue
    }
    if (c === '`' || c === '"' || c === "'") {
      const q = c
      out += c
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += q
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

// 上一行以这些结尾时，下一行的 ( [ ` 不可能是「继续上一表达式」
const SAFE_END = /[;{}(,=?:<>!+*%&|^~-]\s*$/
const KEYWORD_END = /\b(return|throw|case|else|do|typeof|instanceof|in|of|new|delete|void|await|yield)\s*$/

const dir = path.resolve(process.argv[2] || '.')
let hits = 0
for (const f of walk(dir)) {
  const raw = fs.readFileSync(f, 'utf8').split('\n')
  const lines = mask(fs.readFileSync(f, 'utf8')).split('\n')
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i]
    if (!/^\s*[([`]/.test(cur)) continue
    if (/^\s*;/.test(cur)) continue // 行首已有分号，双保险已到位
    const prev = lines[i - 1]
    const pt = prev.replace(/\s+$/, '')
    if (pt === '') continue
    if (SAFE_END.test(pt) || KEYWORD_END.test(pt)) continue
    hits++
    console.log(`${f}:${i + 1}  上一行: ${raw[i - 1].trim().slice(0, 60)}`)
    console.log(`${' '.repeat(String(i + 1).length + f.length + 1)}本  行: ${raw[i].trim().slice(0, 60)}`)
  }
}
console.log(hits === 0 ? 'ASI 扫描：0 处候选' : `ASI 扫描：${hits} 处候选，需人工确认`)
process.exit(hits ? 1 : 0)
