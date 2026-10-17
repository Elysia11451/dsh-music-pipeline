#!/usr/bin/env node
// 测试入口：把测试文件当普通脚本跑。
//
// 为什么不用 `node --test`：本机 Termux 打包的 Node 24 对
// `node --test <file>` 一律报 `error: expected absolute path: "--test-concurrency=0"`
// 并让测试进程 exit 1（实测 10 个测试全部实际通过，纯 CLI 兼容问题）。
// node:test 的 test() 在直接 import 时同样会注册并执行，只是没有 reporter 的
// 汇总输出；这里自己收尾并回传播出码，行为与 `node --test` 等价。
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => resolve(here, f))
  : readdirSync(resolve(here, 'test'))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => resolve(here, 'test', f))

if (files.length === 0) {
  console.error('npm test: test/ 下没有找到 *.test.js')
  process.exit(1)
}

const failed = []
for (const file of files) {
  console.log('--- ' + file)
  const r = spawnSync(process.argv0, [file], { stdio: 'inherit' })
  if (r.status !== 0) failed.push(file)
}

if (failed.length) {
  console.error('\nnpm test: FAILED →\n' + failed.map((f) => '  ' + f).join('\n'))
  process.exit(1)
}
console.log('\nnpm test: 全部通过（' + files.length + ' 个文件）')
