// lib/platform.js — 跨平台抽象层（Windows / macOS / Linux / Android 通吃）
//
// v0.2.0 新增。插件原先只跑在 Android 上，路径里散落 /storage/、/data/data/ 之类的
// 硬编码；这个文件把「平台差异」全部收敛到一处，业务代码（index.js、scripts/*）只跟
// 这里的接口打交道，不再自己判断平台。
//
// 覆盖四类差异：
//   1. 路径       —— homeDir() / tmpDir() / join() / sep / delimiter / defaultDirs()
//   2. 归一化     —— canonPath()：Android 上 /data/user/0 与 /data/data 是同一目录的别名，
//                    直接字符串比较会误判「不同路径」，必须 realpathSync 归一化后再比
//   3. 外部命令   —— findToolPath() / runTool() / runToolSync() / nodeExecutable()
//                    （Android 上 process.execPath 是 linker64 不是 node，必须走 argv0）
//   4. 挂载点     —— storageRoot() / isRemovableMount() / mountLabel()
//
// 约束：零第三方依赖，只用 Node 内置模块；本文件在 Node 与「被脚本 import」两种场景下
// 都必须可用，因此不做任何顶层副作用（不读配置、不建目录）。
'use strict'

import { existsSync, realpathSync, statSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

// ── 平台判定 ────────────────────────────────────────────────────────────────

/** 是否 Windows（含 WSL 之外的裸 Node on Windows） */
export const IS_WINDOWS = process.platform === 'win32'
/** 是否 Android。Termux/proot 下 process.platform 可能是 'android' 或 'linux'，两边都认 */
export const IS_ANDROID = detectAndroid()
/** 是否 macOS */
export const IS_MAC = process.platform === 'darwin'
/** 是否桌面 Linux */
export const IS_LINUX = process.platform === 'linux' && !IS_ANDROID

function detectAndroid() {
  if (process.platform === 'android') return true
  if (process.platform !== 'linux') return false
  // proot/Termux 里 process.platform 仍是 'linux'，用特征文件兜底判定
  try {
    return existsSync('/system/bin/adb') || existsSync('/system/build.prop')
  } catch {
    return false
  }
}

/** 平台名，日志/报错里用 */
export const PLATFORM_NAME = IS_WINDOWS ? 'windows' : IS_ANDROID ? 'android' : IS_MAC ? 'macos' : 'linux'

// ── 路径原语 ────────────────────────────────────────────────────────────────

/** 用户主目录。跨平台等价于 os.homedir()，单独包一层便于测试里打桩。 */
export function homeDir() {
  return homedir()
}

/** 系统临时目录。跨平台等价于 os.tmpdir()。 */
export function tmpDir() {
  return tmpdir()
}

/** 空设备。Windows 上是 'NUL'，POSIX 上是 '/dev/null'。 */
export function devNull() {
  return IS_WINDOWS ? 'NUL' : '/dev/null'
}

/** 路径分隔符 */
export const sep = path.sep
/** 路径列表分隔符（PATH 环境变量用） */
export const delimiter = path.delimiter

/** path.join 的直通导出，业务代码统一从本模块取，避免各处 import 方式不一致 */
export function join(...parts) {
  return path.join(...parts)
}

export function dirname(p) {
  return path.dirname(p)
}

export function basename(p, ext) {
  return path.basename(p, ext)
}

export function extname(p) {
  return path.extname(p)
}

export function isAbsolute(p) {
  return path.isAbsolute(p)
}

export function resolve(...parts) {
  return path.resolve(...parts)
}

export function normalize(p) {
  return path.normalize(p)
}

/**
 * 把一段路径归一化成「同一文件同一字符串」的形式。
 *
 * Android 的 /data/user/0/<pkg> 与 /data/data/<pkg> 是指向同一目录的符号链接别名，
 * 调用方传前者、插件内部拼出后者时，字符串比较会判为「不同目录」，从而重复建目录、
 * 重复复制或漏删文件。所以：先 realpathSync 解析别名，再走 path.normalize。
 *
 * 路径不存在时也不能原样返回——否则「将要创建的目录」永远无法归一化。做法是沿父链
 * 上溯到最近一个真实存在的祖先，解析它之后把后面几段拼回去。
 *
 * @param {string} p 任意路径（绝对/相对/不存在均可）
 * @returns {string} 归一化后的路径；输入为空时原样返回
 */
export function canonPath(p) {
  if (typeof p !== 'string' || p === '') return p
  const abs = path.resolve(p)
  const tail = []
  let cur = abs
  // 上溯有深度上限，防止符号链接成环时死循环
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur)
      if (tail.length === 0) return real
      return path.join(real, ...tail.reverse())
    } catch {
      // 不存在或无权限：继续找父目录
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    tail.push(path.basename(cur))
    cur = parent
  }
  return path.normalize(abs)
}

/** 两条路径是否指向同一位置（先归一化再比较） */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return canonPath(a) === canonPath(b)
}

/** 建目录（递归，已存在不报错） */
export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

// ── 平台默认目录 ────────────────────────────────────────────────────────────

/**
 * 平台相关的中性默认值。
 *
 * 刻意不绑定任何设备专属路径：Android 用公共下载目录，桌面用 home 下的 Music。
 * 换机器只需要改插件 Config 或环境变量，不要改源码。
 *
 * @returns {{downloadDir:string, stagingDir:string, processedDir:string,
 *   storageRoot:string|null, manifest:string, transferLog:string}}
 */
export function defaultDirs() {
  const home = homedir()
  if (IS_ANDROID) {
    const dl = '/storage/emulated/0/Download'
    const music = path.join(dl, 'netease', 'cloudmusic', 'Music')
    return {
      downloadDir: music,
      stagingDir: path.join(dl, '准备传输'),
      processedDir: path.join(music, '已处理NCM'),
      storageRoot: '/storage',
      manifest: path.join(home, 'ncm-manifest.jsonl'),
      transferLog: path.join(home, 'ncm-transfer.log'),
    }
  }
  const music = path.join(home, 'Music', 'netease', 'cloudmusic', 'Music')
  return {
    downloadDir: music,
    stagingDir: path.join(home, 'Music', '准备传输'),
    processedDir: path.join(music, '已处理NCM'),
    // 桌面平台没有统一的「外置存储根」概念：Windows 是盘符、macOS 是 /Volumes，
    // 由调用方显式传挂载点，这里给 null 表示「无默认值，不许猜」。
    storageRoot: null,
    manifest: path.join(home, 'ncm-manifest.jsonl'),
    transferLog: path.join(home, 'ncm-transfer.log'),
  }
}

// ── 外部命令 ────────────────────────────────────────────────────────────────

/** 这个路径是不是一个可执行文件（存在 + 有执行位；Windows 上只要有执行扩展名即算） */
export function looksExecutable(p) {
  if (typeof p !== 'string' || p === '') return false
  try {
    const st = statSync(p)
    if (!st.isFile()) return false
    if (IS_WINDOWS) {
      const ext = path.extname(p).toLowerCase()
      const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
      return ext === '' || pathext.includes(ext)
    }
    return (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Windows 上 PATH 搜索要带的扩展名列表 */
function pathextList() {
  if (!IS_WINDOWS) return ['']
  return (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 各平台常见工具的默认安装位置，优先于 PATH 搜索 */
function platformToolDirs() {
  const dirs = []
  if (IS_WINDOWS) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
    dirs.push(
      path.join(pf, 'ffmpeg', 'bin'),
      path.join(pf86, 'ffmpeg', 'bin'),
      path.join(local, 'Programs', 'ffmpeg', 'bin'),
      path.join(local, 'Microsoft', 'WindowsApps'),
    )
  } else if (IS_ANDROID) {
    dirs.push(
      '/data/data/com.termux/files/usr/bin',
      '/system/bin',
      '/system/xbin',
      '/vendor/bin',
    )
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin')
  }
  return dirs.filter((d) => typeof d === 'string' && d.length > 0)
}

/**
 * 多级探测一个外部工具的真实路径。
 *
 * 优先级：显式传入的路径（配置项 ffmpegPath 等） > 平台默认安装位置 > PATH 环境变量。
 * 找不到返回 null，由调用方决定报错还是降级——不抛异常，避免探测本身把主流程打挂。
 *
 * @param {string} toolName 工具名，如 'ffmpeg'（不带扩展名）
 * @param {{explicit?:string}} [opts] explicit = 用户配置里手填的绝对路径
 * @returns {string|null} 可执行文件的完整路径，或 null
 */
export function findToolPath(toolName, opts = {}) {
  const name = String(toolName || '').trim()
  if (!name) return null

  // 1) 配置显式指定：可以是完整路径，也可以只是目录
  const explicit = opts.explicit || opts.configPath || ''
  if (explicit) {
    const e = String(explicit).trim()
    if (looksExecutable(e)) return e
    const joined = path.join(e, name)
    if (looksExecutable(joined)) return joined
    // 配置填了但不可用：明确告知，而不是静默回落到 PATH（用户会以为自己的配置生效了）
    if (existsSync(e)) {
      throw new Error(`${PLATFORM_NAME}: 配置的工具路径不可执行：${e}（toolName=${name}）`)
    }
    throw new Error(`${PLATFORM_NAME}: 配置的工具路径不存在：${e}（toolName=${name}）`)
  }

  // 2) 平台默认安装位置
  const exts = pathextList()
  for (const dir of platformToolDirs()) {
    for (const ext of exts) {
      const cand = path.join(dir, name + ext)
      if (looksExecutable(cand)) return cand
    }
  }

  // 3) PATH 环境变量
  const pathEnv = process.env.PATH || ''
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const cand = path.join(dir, name + ext)
      if (looksExecutable(cand)) return cand
    }
  }
  return null
}

/**
 * callback 版 execFile 包成 Promise。
 *
 * 不用 promisify(execFile)：本机 Android/Node 下它产出的 error 对象自相矛盾
 * （code/signal/killed 全 undefined，message 却是无关文本），没法可靠判断失败原因。
 * 手写包装后把 stdout/stderr 挂到 error 上，调用方总能拿到日志。
 */
export function execFileP(cmd, args, opts) {
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

/**
 * 异步跑一个外部工具：先 findToolPath 定位，再 execFile（数组参数，不走 shell）。
 *
 * @param {string} toolName 工具名
 * @param {string[]} args 参数数组（绝不拼接成 shell 字符串，避免引号/空格/注入问题）
 * @param {object} [opts] execFile 选项 + {explicit?:string}
 */
export async function runTool(toolName, args, opts = {}) {
  const bin = findToolPath(toolName, opts)
  if (!bin) {
    throw new Error(`${PLATFORM_NAME}: 找不到可执行工具 ${toolName}（PATH=${process.env.PATH || ''}）`)
  }
  return execFileP(bin, args, opts)
}

/**
 * 同步跑一个外部工具。execFileSync(binary, [args])——同样是数组参数、不走 shell。
 * 不抛异常：失败时返回 {status, stdout, stderr, error}，由调用方决定怎么处理。
 *
 * @returns {{status:number, stdout:string, stderr:string, error:string|null, bin:string|null}}
 */
export function runToolSync(toolName, args, opts = {}) {
  const bin = findToolPath(toolName, opts)
  if (!bin) {
    return { status: 127, stdout: '', stderr: '', error: `找不到可执行工具 ${toolName}`, bin: null }
  }
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    })
    return { status: 0, stdout: String(stdout), stderr: '', error: null, bin }
  } catch (e) {
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
      error: e.message ? String(e.message) : String(e),
      bin,
    }
  }
}

/**
 * 真实 node 可执行文件的路径。
 *
 * Android 上 process.execPath 指向 /apex/com.android.runtime/bin/linker64
 * （ELF 是动态链接器，不是 node），execFile/spawn 它必报 `bad ELF magic`。
 * 真实入口在 process.argv0；两者都不可信时退化为 execPath（桌面平台本来就对）。
 */
export function nodeExecutable() {
  const a0 = process.argv0
  if (a0 && path.isAbsolute(a0) && existsSync(a0)) return a0
  return process.execPath
}

// ── 外置存储 / 挂载点 ───────────────────────────────────────────────────────

/** 外置存储根目录；桌面平台没有统一概念，返回 null（调用方必须显式传挂载点） */
export function storageRoot() {
  return defaultDirs().storageRoot
}

/**
 * 这个路径是不是「外置可移动挂载点」。
 *
 * Android：/storage/ 下且不是 /storage/emulated（手机内部存储）与 /storage/self。
 * Windows：盘符根目录（如 E:\），且不是系统盘。
 * macOS：/Volumes/ 下的卷。
 * 其它平台：宽松放行（无法可靠判定，交由后续 existsSync 兜底）。
 */
export function isRemovableMount(p) {
  if (typeof p !== 'string' || p.trim() === '') return false
  const raw = p.trim()
  // Windows 盘符判定必须在 canonPath 之前做：canonPath 走 path.resolve，
  // 而在非 Windows 主机（或跑单测时伪造 platform）上 'E:\' 是**相对路径**，
  // 会被拼成 <cwd>/E:\，盘符特征丢失，导致 E:\ 永远判不出外置挂载点。
  if (IS_WINDOWS) {
    const m = /^([A-Za-z]):[\\/]?$/.exec(raw)
    if (!m) return false
    const sysDrive = (process.env.SystemDrive || 'C:').replace(/:$/, '').toUpperCase()
    return m[1].toUpperCase() !== sysDrive
  }
  const s = canonPath(raw)
  if (IS_ANDROID) {
    if (!s.startsWith('/storage/')) return false
    if (s.startsWith('/storage/emulated')) return false
    if (s.startsWith('/storage/self')) return false
    return true
  }
  if (IS_MAC) return s.startsWith('/Volumes/')
  return true
}

/**
 * 从调用方传入的挂载点参数里提取「卷标/短名」。
 *
 * 调用方可能传绝对路径（/storage/ABCD-1234、E:\），也可能直接传卷标（ABCD-1234）。
 * 历史上直接字符串拼接 `/storage/ + m`，传入绝对路径时会拼成
 * `/storage//storage/ABCD-1234`，existsSync 永远 false，报「插了卡也传不成」。
 * 这里统一归一成「最后一段」。
 *
 * @param {string} v 调用方传入的挂载点
 * @param {string|null} [root] 外置存储根；缺省用 defaultDirs().storageRoot
 * @returns {string} 卷标短名；无法解析时返回空串（调用方必须报错，不许猜）
 */
export function mountLabel(v, root) {
  const storageRootDir = root || defaultDirs().storageRoot
  let s = String(v || '').trim().replace(/[\\/]+$/, '')
  if (s === '') return ''
  if (storageRootDir) {
    const bare = storageRootDir.replace(/[\\/]+$/, '')
    // 存储根本身不是挂载点（/storage、C:\ 这类根）：必须返回空串让调用方报错，
    // 否则会被当成卷标 'storage' 拼出 /storage/storage 这种不存在的路径。
    if (s === bare) return ''
    const prefix = bare + '/'
    const idx = s.indexOf(prefix)
    if (idx >= 0) s = s.slice(idx + prefix.length)
  }
  const parts = s.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return ''
  const last = parts[parts.length - 1]
  // Windows 盘符根（E:\）本身就是一个挂载点，最后一段是 'E:'，原样返回
  return last
}

/** 把卷标拼回完整挂载路径；桌面平台（无 storageRoot）时卷标即路径本身 */
export function mountPath(label, root) {
  const storageRootDir = root || defaultDirs().storageRoot
  if (!storageRootDir) return String(label || '')
  return path.join(storageRootDir, String(label || ''))
}

export default {
  IS_WINDOWS,
  IS_ANDROID,
  IS_MAC,
  IS_LINUX,
  PLATFORM_NAME,
  homeDir,
  tmpDir,
  devNull,
  sep,
  delimiter,
  join,
  dirname,
  basename,
  extname,
  isAbsolute,
  resolve,
  normalize,
  canonPath,
  samePath,
  ensureDir,
  defaultDirs,
  looksExecutable,
  findToolPath,
  execFileP,
  runTool,
  runToolSync,
  nodeExecutable,
  storageRoot,
  isRemovableMount,
  mountLabel,
  mountPath,
}
