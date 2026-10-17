# dsh-music-pipeline

NCM 自动转换与 OTG 自动传输流水线——插卡即同步，无需手动处理网易云加密音频。

## 功能

- **自动扫描**：监控网易云下载目录，识别待处理的 `.ncm` 与原生 `.flac`
- **纯解密转换**：NCM → FLAC，走纯解密拷贝路径，不依赖 ffmpeg
- **规范重命名**：统一为「{歌曲名} - {艺术家}.flac」，非法路径字符替换为 `_`
- **原生 FLAC 直通**：已是 FLAC 的文件直接进入暂存，不重复转换
- **OTG 自动传输**：插卡后一键复制到外置存储 `/Music`
- **MD5 校验 + 结构校验**：复制后逐字节 MD5 比对，再做纯 JS FLAC 结构完整性检查
- **安全删源**：校验全通过才删手机源；同名重复、冲突、质量裁决失败一律保留，绝不盲删
- **NCM 归档清理**：对应 FLAC 成功落卡后，按 manifest 记录清理已归档的 `.ncm`

## 前提依赖

- **零第三方插件依赖**：NCM 解密核心已内置于 [`lib/ncm-decryptor.js`](lib/ncm-decryptor.js)，不依赖 `dsh-audio-converter`，也不需要 ffmpeg
- **不需要 ffmpeg**：转换固定走纯解密路径（`embedCover: false` + `writeTags: false`），因此也**不做重采样/格式互转**
- Android 10+，外置 OTG 卡（建议文件系统 exFAT/FAT32）

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-music-pipeline
```

安装后由 `@deepseek-ai/dsh-hmr` 热挂载，无需重启即可注册工具。

## 使用

两个原生工具会注册到 Agent 工具箱：

### `music_scan`（只读）

扫描下载目录，返回待处理文件列表。不修改任何文件，可随时调用。

### `music_transfer`（高危，会删手机源）

```text
music_transfer(targetMountPoint: "/storage/<卷标>")
```

`targetMountPoint` 必须是 `/storage/` 下的外置挂载点；传 `/storage/emulated`（手机内部存储）会被拒绝。

**挂载点兼容**：既可传绝对路径 `/storage/<卷标>`，也可直接传卷标短名，脚本内部统一归一化。

**典型流程**：

1. 网易云下载 NCM 到下载目录（默认 `/storage/emulated/0/Download/netease/cloudmusic/Music`）
2. 运行 `ncm-auto-convert.mjs`（由 cron 定时触发，本插件不接管）→ 解密、重命名、进入「准备传输」
3. 插入 OTG 卡
4. 调用 `music_transfer` → 复制 → MD5 校验 → 结构校验 → 删手机源 → 清理归档 NCM

返回结构：

```json
{ "copied": 1, "verified": 1, "deleted": 2, "failures": [] }
```

> `deleted` 通常比 `copied` 大 1：除了 FLAC 源文件，对应的归档 `.ncm` 也会被清理。

## 可配置目录

通过插件 Config 修改三个目录（有默认值，不配也能跑）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `downloadDir` | `/storage/emulated/0/Download/netease/cloudmusic/Music` | NCM/FLAC 来源目录 |
| `stagingDir` | `/storage/emulated/0/Download/准备传输` | 待传输 FLAC 暂存目录 |
| `processedDir` | `/storage/emulated/0/Download/netease/cloudmusic/Music/已处理NCM` | 已转换 NCM 归档目录 |

默认值只是 Android 网易云客户端的常见落点，**换目录请改配置，不要改源码**。`music_scan` 也接受 `downloadDir` 参数，可临时覆盖。

### 底层脚本的环境变量

两个 `scripts/` 子脚本另有一套等价的**环境变量**，优先级高于内置默认值，方便在不改代码的情况下适配别的机器：

| 变量 | 作用 |
|---|---|
| `NCM_MUSIC_DIR` / `NCM_DIR` | 转换的源目录（同 `--dir`） |
| `NCM_STAGING_DIR` / `NCM_OUT` | 暂存目录（同 `--out`） |
| `NCM_ARCHIVE_DIR` | 已转换 NCM 归档目录 |
| `NCM_MANIFEST` | manifest JSONL 路径，默认 `<home>/ncm-manifest.jsonl` |
| `NCM_TRANSFER_LOG` | 传输日志路径，默认 `<home>/ncm-transfer.log` |
| `NCM_STORAGE_ROOT` | 外置存储根，默认 `/storage` |

## 目录结构与打包完整性

插件**完全自包含**，所有运行时文件都随 npm 包一起分发（`package.json` 的 `files` 字段显式列出）：

```
dsh-music-pipeline/
├── index.js                        # host 半边：注册 music_scan / music_transfer 工具
├── cordis.patch.yml                # Cordis bundle 挂载声明
├── lib/ncm-decryptor.js            # 内置纯 JS NCM 解密核心（零第三方依赖）
├── scripts/                        # 被 index.js 调用的两个子脚本
│   ├── ncm-auto-convert.mjs        #   转换（cron 驱动，插件不接管）
│   └── ncm-otg-transfer.mjs        #   OTG 传输（music_transfer 的底层）
├── test/ncm-decryptor.test.js      # 解密器单元测试
└── run-tests.mjs                   # 测试入口
```

脚本路径不是硬编码的：`index.js` 用 ESM 的 `import.meta.url` 反推自身所在目录，再拼 `scripts/`，因此插件安装到任何位置都能正确定位子脚本（详见下面「开发踩坑」）。

### 定时任务配置

转换脚本需要 cron 之类的定时器驱动，插件本身只注册工具、不启动定时任务。手动跑一次验证：

```bash
node scripts/ncm-auto-convert.mjs
```

> 该脚本会真实执行解密 + 重命名 + 归档 `.ncm`，请在确认目录无误后再运行。

## 开发踩坑（Android/Node 实测）

### 1. ASI 分号陷阱：下一行以 `(` 开头会被合并解析

JavaScript 的自动分号插入（ASI）在「上一行没有分号、下一行以 `(` 开头」时不会插入分号，而是把两行当**同一个表达式**继续解析：

```js
// 危险写法
const shortName = posix.basename(mnt)
({ stdout } = await execFileP(...))   // 被解析成 posix.basename(mnt)({stdout} = ...)

// 安全写法
const shortName = posix.basename(mnt);
;({ stdout } = await execFileP(...))   // 行首分号 + 行尾分号双保险
```

真实报错是 `TypeError: posix.basename(...) is not a function`——因为 `basename` 返回的是字符串，却被当成函数调用。**注意 `node --check` 查不出这类 TDZ/ASI 问题**（语法合法），只有真实运行才会炸，所以验证必须走实际调用，不能只做静态检查。

### 2. ESM 里没有 `__dirname`

`index.js` 是 ESM（`"type": "module"`），不能直接用 `__dirname`。用 `import.meta.url` 反推：

```js
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRANSFER_SCRIPT = join(__dirname, 'scripts', 'ncm-otg-transfer.mjs')
```

这样脚本路径随插件一起走，`npm install` 到 `node_modules/<pkg>/` 后依然有效，不需要按机器改路径。

### 3. `process.execPath` 在 Android 上不是 Node

Android 的 Node 里 `process.execPath` 指向动态链接器（`linker64` 之类），`execFile` 它会报 `bad ELF magic`。真实 node 路径在 `process.argv0`，插件封装了 `nodeExecutable()` 优先取它。

### 4. 测试里的真实文件用例是可跳过的

`test/ncm-decryptor.test.js` 需要一对「参考 NCM + 其解密产物」才能跑逐字节比对。这对文件通过环境变量注入：

```bash
NCM_REF_NCM=/path/to/源文件.ncm \
NCM_REF_FLAC=/path/to/解密产物.flac \
npm test
```

未提供时，依赖真实文件的 3 个用例自动跳过（其余 7 个仍全绿），因此 CI 或新机器上 `npm test` 不会因为缺文件而失败。

## 已知限制

- **不做转码**：源内容若不是 FLAC（如 MP3 封装的 NCM），内置解密只做纯还原，会标记 `needs-transcode` 并保留原文件
- **不处理 musicex 等需账号授权的格式**：仅支持标准 NCM 解密
- **OTG 权限需系统层授予**：Android 对外部存储的授权在引擎启动时注入，**插卡后建议重启 DSH** 再调用 `music_transfer`，否则原生工具可能拿不到挂载点
- **卷标假定**：不传参数时按内置候选卷标探测，其他卷标请显式传入
- **Android 进程限制**：DSH 进程的 `process.execPath` 指向 `linker64` 而非真 Node，插件内部用 `process.argv0` 解析真实 node 路径后 spawn 脚本

## 免责声明

本插件会**删除手机上的源文件**。虽已内置 MD5 校验、FLAC 结构完整性检查、同名冲突质量裁决等多重保护，且任何不确定情形下均保留原始文件，但**请在首次使用时先以小批量文件验证，确认符合预期后再正式使用**。

因使用本插件导致的数据丢失或损坏，作者不承担任何责任。请自行斟酌并做好备份。

## License

MIT
