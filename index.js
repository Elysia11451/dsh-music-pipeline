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
//   4. 平台差异一律委托 lib/platform.js，本文件不出现任何 /storage、/data 之类硬编码路径。
'use strict'

import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import platform, { execFileP, nodeExecutable, isRemovableMount, mountLabel } from './lib/platform.js'

// ESM 里没有 __dirname，用 import.meta.url 反推本文件所在目录。
// 插件经 node_modules/<pkg> 软链挂载，源码目录就是安装目录——脚本路径从这里派生，
// 打包/安装到任何位置都不需要再改硬编码路径。
const __dirname = dirname(fileURLToPath(import.meta.url))

// nodeExecutable()/execFileP() 原先在本文件里各写了一份，与 lib/platform.js 重复。
// 现在统一从 platform 取：nodeExecutable 解决 Android 上 process.execPath 指向
// /apex/.../linker64（不是真 Node）导致 spawn 必挂的问题；execFileP 绕开
// promisify(execFile) 在本机 Android/Node 下产出自相矛盾错误对象的问题。

const name = 'music-pipeline'
const inject = ['tools']

// 可配置项：三个目录 + 两个外部工具/挂载点。Schemastery 可用时给 schema 校验/默认值，
// 不可用时退化为普通默认对象（不阻塞挂载）。
// 默认值一律走 platform.defaultDirs()——Android 用公共下载目录、桌面用 home 下 Music，
// 换机器只改配置不改源码；刻意不含任何设备专属路径。
const DEFAULTS = {
  ...platform.defaultDirs(),
  // ffmpeg 路径：内置纯 JS 解密不转码，只有「非 FLAC 产物无损转 FLAC」才用得到 ffmpeg。
  // 消费点有两处：
  //   ① music_scan 用它做探测并把结果报出来（诊断「为什么某首歌没进准备传输」）
  //   ② 转换脚本由 cron 独立驱动，它读自己的 --ffmpeg / NCM_FFMPEG，
  //      所以要让 cron 跑转码仍需把同一路径配到那两处之一——本项不会自动传给它。
  ffmpegPath: '',
  // OTG 挂载点：留空 = 每次调用 music_transfer 时由参数显式指定。
  // 桌面平台（Windows 盘符 / macOS /Volumes）没有统一外置存储根，必须显式指定。
  otgMountPoint: '',
}
// defaultDirs() 的 storageRoot 在桌面平台是 null，不能塞进 Config Schema（string 校验会挂）
delete DEFAULTS.storageRoot

export const Config = await (async () => {
  try {
    const { default: Schema } = await import('schemastery')
    return Schema.object({
      downloadDir: Schema.string().default(DEFAULTS.downloadDir).description('网易云下载目录（扫描加密文件/FLAC 的来源）'),
      stagingDir: Schema.string().default(DEFAULTS.stagingDir).description('待传输 FLAC 的暂存目录'),
      processedDir: Schema.string().default(DEFAULTS.processedDir).description('已转换归档的加密文件子目录'),
      ffmpegPath: Schema.string().default('').description('ffmpeg 可执行文件路径，留空则自动探测。仅用于 music_scan 的诊断提示；cron 跑的转换脚本要转码需另配 --ffmpeg 或 NCM_FFMPEG'),
      otgMountPoint: Schema.string().default('').description('OTG 挂载点，如 /storage/<卷标> 或 E:\\，留空则每次调用时由参数指定'),
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
        '扫描网易云音乐下载目录，返回待处理的加密文件/FLAC 列表。不修改任何文件。' +
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
            ffmpeg: { type: ['string', 'null'] },
            note: { type: 'string' },
          },
          required: ['files', 'count'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.count === 0
            ? '下载目录里没有待处理的加密音频 / FLAC 文件。'
            : '待处理 ' + value.count + ' 个文件：\n' + value.files.map((f) => '  ' + f).join('\n'))
            + (value.note ? '\n' + value.note : ''),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        // 独立扫描，不调用转换脚本（那脚本一跑就真转+归档）。目录不存在时返回空清单而非报错。
        // 优先级：调用参数 > 插件配置 > 平台中性默认值
        const MUSIC_DIR = String(args?.downloadDir || cfg('downloadDir') || DEFAULTS.downloadDir)
        let names = []
        try { names = readdirSync(MUSIC_DIR) } catch (e) {
          throw new Error('music_scan: 无法读取下载目录 ' + MUSIC_DIR + '：' + e.message)
        }
        // 扫描范围跟着 lib/decrypt 注册表走——新增解密格式时这里零改动。
        // 用 __dirname 派生绝对路径而非相对说明符：相对 import 在插件被 symlink 到
        // node_modules 后会解析到宿主的 node_modules 外面，直接 ERR_MODULE_NOT_FOUND。
        const { SUPPORTED_EXTENSIONS } = await import(join(__dirname, 'lib', 'decrypt', 'index.js'))
        const want = new Set(SUPPORTED_EXTENSIONS.map((e) => e.toLowerCase()))
        const files = names
          .filter((f) => {
            const lower = f.toLowerCase()
            if (lower.endsWith('.flac') && !lower.endsWith('.backup.flac')) return true
            const ext = lower.slice(lower.lastIndexOf('.'))
            return want.has(ext)
          })
          .map((f) => join(MUSIC_DIR, f))

        // ffmpeg 探测结果一并报出来：这是 ffmpegPath 配置项在 host 侧的消费点。
        // 非 FLAC 封装的源（如 MP3-in-NCM）解密后要靠 ffmpeg 无损转 FLAC，
        // 缺 ffmpeg 时那类文件会停在 needs-transcode——扫描时就把话说清，
        // 免得用户只看到「某首歌不见了」去瞎猜。
        let ffmpeg = null
        try {
          ffmpeg = platform.findToolPath('ffmpeg', { explicit: String(cfg('ffmpegPath') || '') })
        } catch (e) {
          // 配置了但路径无效：findToolPath 抛错。不静默——把原因放进 note，
          // 但扫描本身照做（ffmpeg 只影响一类文件的转码，不该挡住清单输出）。
          return { files, count: files.length, ffmpeg: null, note: 'ffmpeg 配置有问题：' + e.message }
        }
        const note = ffmpeg ? null
          : '未检测到 ffmpeg：MP3/OGG 封装的源解密后无法转成 FLAC，会停在 needs-transcode（不删源）。需要时在配置 ffmpegPath 填路径或让 ffmpeg 出现在 PATH。'
        return note ? { files, count: files.length, ffmpeg, note } : { files, count: files.length, ffmpeg }
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
            description: 'OTG 存储卡挂载点：Android 传 /storage/<卷标>，Windows 传盘符如 E:\\，macOS 传 /Volumes/<卷名>。不传则用插件配置 otgMountPoint',
          },
        },
        required: [],
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
        // 挂载点来源：调用参数 > 插件配置 otgMountPoint
        const mnt = String(args?.targetMountPoint || cfg('otgMountPoint') || '').trim()
        if (!mnt) {
          throw new Error(
            'music_transfer: 未指定目标挂载点。请传 targetMountPoint，或在插件配置里填 otgMountPoint。\n' +
            '  Android: /storage/<卷标>\n  Windows: 盘符（如 E:\\）\n  macOS: /Volumes/<卷名>',
          )
        }
        // 平台中性的外置挂载点判定：Android 要求 /storage/ 下且不是内部存储；
        // Windows 要求非系统盘的盘符根；macOS 要求 /Volumes/ 下的卷。
        if (!isRemovableMount(mnt)) {
          throw new Error(
            'music_transfer: targetMountPoint 不是可识别的『外置』挂载点：' + mnt + '\n' +
            '  当前平台：' + platform.PLATFORM_NAME + '\n' +
            '  Android 传 /storage/<卷标>（不能是 /storage/emulated 手机内部存储）\n' +
            '  Windows 传盘符（如 E:\\，不能是系统盘）\n' +
            '  macOS 传 /Volumes/<卷名>',
          )
        }
        let stdout
        try {
          // 脚本约定：位置参数是挂载短名（脚本内部拼 <存储根>/<短名>）。
          // mountLabel() 统一把绝对路径（/storage/ABCD-1234、E:\）和裸卷标都归一成短名，
          // 修掉原先「传绝对路径会被拼成 /storage//storage/xxx」的坑。
          // --yes-delete-ncm 复用用户此前已确认的「传完删源」语义。
          // 防 ASI 分号陷阱：上一行以分号结尾，本行行首再补一个分号双保险
          const shortName = mountLabel(mnt, platform.storageRoot());
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
