// dsh-music-pipeline — host 半边
//
// 把已跑通的两个脚本包装成 Agent 工具（脚本随插件打包在 ./scripts/，完全自包含）：
//   scripts/ncm-auto-convert.mjs   转换（cron 定时跑，本插件不包它）
//   scripts/ncm-otg-transfer.mjs   OTG 传输（高危，手动触发）
//
// 设计约束（任务红线）：
//   1. 不修改脚本逻辑，只 execFile 调用、解析 stdout 日志行；
//   2. music_scan 纯只读——自己 readdir，不跑转换脚本（转换脚本会真转+归档）；
//   3. music_transfer 直接把挂载点当位置参数传给传输脚本（脚本本身支持候选挂载点参数）。
'use strict'

import { execFile } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, posix, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM 里没有 __dirname，用 import.meta.url 反推本文件所在目录。
// 插件经 node_modules/<pkg> 软链挂载，源码目录就是安装目录——脚本路径从这里派生，
// 打包/安装到任何位置都不需要再改硬编码路径。
const __dirname = dirname(fileURLToPath(import.meta.url))

// Android 上 process.execPath=/apex/.../linker64（不是真 Node），spawn 它必挂；
// argv0 是用户实际启动的 node 入口，优先用它，退化才用 execPath。
function nodeExecutable() {
  const a0 = process.argv0
  if (a0 && posix.isAbsolute(a0) && existsSync(a0)) return a0
  return process.execPath
}

// promisify(execFile) 在本机 Android/Node 下会产出自相矛盾的错误对象（e.code/signal/killed 全 undefined，
// message 却是无关文本），改用 callback 包 Promise，行为可预期。
function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

const name = 'music-pipeline'
const inject = ['tools']

// 可配置项：三个目录。Schemastery 可用时给 schema 校验/默认值，不可用时退化为普通默认对象（不阻塞挂载）
// 默认值只指向 Android 标准下载目录，不含设备专属路径；manifest/日志由传输脚本按 homedir 派生。
const DEFAULTS = {
  downloadDir: '/storage/emulated/0/Download/netease/cloudmusic/Music',
  stagingDir: '/storage/emulated/0/Download/准备传输',
  processedDir: '/storage/emulated/0/Download/已处理NCM',
}

export const Config = await (async () => {
  try {
    const { default: Schema } = await import('schemastery')
    return Schema.object({
      downloadDir: Schema.string().default(DEFAULTS.downloadDir).description('网易云下载目录（扫描 .ncm/.flac 的来源）'),
      stagingDir: Schema.string().default(DEFAULTS.stagingDir).description('待传输 FLAC 的暂存目录'),
      processedDir: Schema.string().default(DEFAULTS.processedDir).description('已转换归档的 NCM 子目录'),
    })
  } catch {
    return { ...DEFAULTS }
  }
})()

// 脚本随插件打包在 scripts/ 下（原先是 Documents/scripts/ 外部目录，依赖工作区布局）
const SCRIPTS_DIR = join(__dirname, 'scripts')
const TRANSFER_SCRIPT = join(SCRIPTS_DIR, 'ncm-otg-transfer.mjs')

/** 从传输脚本 stdout 日志行里数出结构化结果（脚本只产日志，不产 JSON——解析是唯一不改脚本的办法） */
function parseTransferLog(stdout) {
  const lines = stdout.split('\n')
  let copied = 0, verified = 0, deleted = 0
  const failures = []
  for (const line of lines) {
    if (line.includes('] copied: ')) copied++
    if (line.includes('] post-check ok ')) verified++
    if (line.includes('] deleted ')) deleted++
    if (line.includes('] ERROR ') || line.includes('] VERIFY FAIL ') || line.includes('] CONFLICT ')) {
      failures.push(line.replace(/^\[[^\]]+\] /, ''))
    }
  }
  return { copied, verified, deleted, failures }
}

function makeTools(ctx) {
  const cfg = (key) => (ctx?.get?.(name)?.config || ctx?.config || {})[key]
  return [
    {
      name: 'music_scan',
      description:
        '扫描网易云音乐下载目录，返回待处理的 NCM/FLAC 文件列表。不修改任何文件。' +
        '只读操作，可随时调用。',
      parameters: {
        type: 'object',
        properties: {
          downloadDir: {
            type: 'string',
            description: '可选：覆盖配置里的下载目录（不传则用插件配置值）',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            count: { type: 'number' },
          },
          required: ['files', 'count'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? '下载目录里没有待处理的 .ncm / .flac 文件。'
            : '待处理 ' + value.count + ' 个文件：\n' + value.files.map((f) => '  ' + f).join('\n'),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        // 独立扫描，不调用转换脚本（那脚本一跑就真转+归档）。目录不存在时返回空清单而非报错。
        // 优先级：调用参数 > 插件配置 > 内置默认（Android 标准下载目录）
        const MUSIC_DIR = String(args?.downloadDir || cfg('downloadDir') || DEFAULTS.downloadDir)
        let names = []
        try { names = readdirSync(MUSIC_DIR) } catch (e) {
          throw new Error('music_scan: 无法读取下载目录 ' + MUSIC_DIR + '：' + e.message)
        }
        const files = names
          .filter((f) => {
            const lower = f.toLowerCase()
            return lower.endsWith('.ncm') || (lower.endsWith('.flac') && !lower.endsWith('.backup.flac'))
          })
          .map((f) => MUSIC_DIR + '/' + f)
        return { files, count: files.length }
      },
    },

    {
      name: 'music_transfer',
      description:
        '将「准备传输」文件夹中的 FLAC 复制到目标 OTG 挂载点，MD5 校验+结构完整性检查通过后删除手机源文件' +
        '（同名重复、冲突、质量裁决失败的文件按脚本内置规则保留，不会盲删）。' +
        '高危操作（会删手机源文件），必须由用户明确要求后才可调用。',
      parameters: {
        type: 'object',
        properties: {
          targetMountPoint: {
            type: 'string',
            description: 'OTG 存储卡挂载点绝对路径，如 /storage/<卷标>',
          },
        },
        required: ['targetMountPoint'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            copied: { type: 'number' },
            verified: { type: 'number' },
            deleted: { type: 'number' },
            failures: { type: 'array', items: { type: 'string' } },
          },
          required: ['copied', 'verified', 'deleted', 'failures'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: '传输完成：复制 ' + value.copied + '，校验通过 ' + value.verified +
            '，删除手机源 ' + value.deleted +
            (value.failures.length ? '\n问题：\n' + value.failures.map((f) => '  ' + f).join('\n') : '\n无失败项。'),
        }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const mnt = String(args.targetMountPoint || '').trim()
        if (!mnt.startsWith('/storage/') || mnt.startsWith('/storage/emulated')) {
          throw new Error('music_transfer: targetMountPoint 必须是 /storage/ 下的外置挂载点（不能是 /storage/emulated 手机内部存储）')
        }
        let stdout
        try {
          // 脚本约定：位置参数是挂载短名（脚本内部拼 /storage/<短名>），这里从绝对路径提取短名再传
          // --yes-delete-ncm 复用用户此前已确认的「传完删源」语义
          // 防止 ASI 分号陷阱：上一行必须以分号结尾，否则下一行以 ( 开头时会被 JS 引擎合并解析
          const shortName = posix.basename(mnt);
          ;({ stdout } = await execFileP(nodeExecutable(), [TRANSFER_SCRIPT, shortName, '--yes-delete-ncm'], {
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024,
          }))
        } catch (e) {
          // 脚本失败时 exit 1，日志在 stdout；带日志抛错，方便定位
          const detail = (e.stdout || '') + (e.stderr || '')
          throw new Error('music_transfer: 传输脚本失败（exit ' + e.code + '）：\n' + (detail || e.message || '').slice(-2000))
        }
        return parseTransferLog(stdout)
      },
    },
  ]
}

export function apply(ctx) {
  let registered = 0
  for (const tool of makeTools(ctx)) {
    try { ctx.tools.register(tool); registered++ } catch (error) {
      console.error('[' + name + '] ' + tool.name + ' 注册失败：' + error)
    }
  }
  ctx.logger?.info?.(name + ': 已挂载（' + registered + ' 个工具）')
}

export { name, inject }
export default { apply, name, inject }
