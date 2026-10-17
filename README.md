# dsh-music-pipeline

全格式加密音乐流水线：内置解密 → 规范重命名 → OTG 传卡校验。**Windows + Android 双平台**。

插卡即同步，无需手动处理各类加密音频。

## 支持的加密格式

| 平台 | 扩展名 | 解密方式 | 元数据 |
|---|---|---|---|
| 网易云音乐 | `.ncm` | 内置纯 JS（AES-128-ECB + RC4 变体） | 容器内嵌，可取歌名/歌手/专辑 |
| 酷狗音乐 | `.kgm` `.kgma` `.vpr` | 内置纯 JS（17 字节密钥 + 272 字节掩码表） | 容器不嵌，退回文件名 |
| QQ 音乐 | `.qmc0` `.qmc3` `.qmcflac` `.qmcogg` `.mflac*` `.mgg*` `.bkc*` 等 | 内置纯 JS（V1 静态掩码 / V2 TEA+RC4） | 容器不嵌，退回文件名 |
| 酷我音乐 | `.kwm` | 内置纯 JS（seed 派生 32 字节循环 XOR） | 容器不嵌，退回文件名 |

**零第三方依赖**：所有解密都是插件内置的纯 JS，只使用 Node 内置模块，不需要安装任何 npm 包。

## 功能

- **自动扫描**：监控下载目录，识别上表所有加密格式与原生 `.flac`
- **内置解密**：纯字节级还原，不依赖 ffmpeg；非 FLAC 产物在检测到 ffmpeg 时无损转 FLAC
- **规范重命名**：统一为「{歌曲名} - {艺术家}.flac」，非法路径字符替换为 `_`
- **原生 FLAC 直通**：已是 FLAC 的文件直接进入暂存，不重复转换
- **OTG 自动传输**：复制到外置存储 `/Music`
- **MD5 校验 + 结构校验**：逐字节 MD5 比对，再做纯 JS FLAC 结构完整性检查
- **安全删源**：校验全通过才删源文件；同名重复、冲突、质量裁决失败一律保留，绝不盲删
- **归档清理**：对应 FLAC 成功落卡后，按 manifest 记录清理已归档的加密源文件

## 跨平台说明

路径、外部命令、挂载点判定全部收敛到 [`lib/platform.js`](lib/platform.js)，业务代码不出现任何硬编码前缀。

| | Android | Windows | macOS / 桌面 Linux |
|---|---|---|---|
| 默认下载目录 | `/storage/emulated/0/Download/netease/cloudmusic/Music` | `<home>\Music\netease\cloudmusic\Music` | `~/Music/...` |
| 外置挂载点写法 | `/storage/<卷标>` | 盘符 `E:\` | `/Volumes/<卷名>` |
| 默认挂载根 | `/storage` | 无（必须显式指定） | 无（必须显式指定） |
| node 可执行 | `process.argv0`（`execPath` 是 linker64） | `process.execPath` | `process.execPath` |

> ⚠️ **Windows 分支目前只经过模拟测试**（伪造 `process.platform='win32'` 跑路径拼接与工具探测，见 [`test/platform-crossplatform.test.js`](test/platform-crossplatform.test.js)），**未在 Windows 真机上验证过**。真机差异（盘符大小写、`Program Files` 实际布局、路径分隔符混用）仍可能有问题。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-music-pipeline
```

> DSH 是长驻进程，插件入口只在进程启动时 import 一次。**安装或改完代码需要重启 DSH 才生效**（本插件不会自动重启它）。

## 使用

两个工具注册到 Agent 工具箱：

### `music_scan`（只读）

扫描下载目录，返回待处理文件清单。不修改任何文件，可随时调用。扫描范围跟着解密注册表走——新增格式时这里零改动。

### `music_transfer`（高危，会删源文件）

```text
music_transfer(targetMountPoint: "/storage/<卷标>")   # Android
music_transfer(targetMountPoint: "E:\\")              # Windows
music_transfer()                                      # 用配置里的 otgMountPoint
```

挂载点既可传绝对路径也可直接传卷标，内部统一归一化。**不传且未配置时明确报错，绝不猜设备专属卷标。**

典型流程：下载加密文件 → 跑转换脚本 → 插卡 → `music_transfer`。

返回：`{ "copied": 1, "verified": 1, "deleted": 2, "failures": [] }`
（`deleted` 通常比 `copied` 大 1：FLAC 源 + 对应归档的加密源都会清理）

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `downloadDir` | 平台默认（见上表） | 加密文件来源目录 |
| `stagingDir` | 平台默认 | 待传输 FLAC 暂存目录 |
| `processedDir` | 平台默认 | 已转换加密源归档目录 |
| `ffmpegPath` | `''`（自动探测） | ffmpeg 可执行文件路径。**只影响 `music_scan` 的诊断提示**——cron 驱动的转换脚本读自己的 `--ffmpeg` / `NCM_FFMPEG`，不读本项 |
| `otgMountPoint` | `''`（调用时指定） | OTG 挂载点，供 `music_transfer` 缺省使用 |

底层脚本另有等价环境变量（优先级高于内置默认）：`NCM_MUSIC_DIR` / `NCM_STAGING_DIR` / `NCM_ARCHIVE_DIR` / `NCM_MANIFEST` / `NCM_TRANSFER_LOG` / `NCM_STORAGE_ROOT` / `NCM_FFMPEG`。

## 关于 ffmpeg

**解密本身不需要 ffmpeg**。只有「源是 MP3/OGG 封装（如部分 NCM）」时，才需要 ffmpeg 无损转成 FLAC——因为传输链路的结构校验只认 FLAC。

- 未安装 ffmpeg：这类文件标记 `needs-transcode`，**不删源、不归档**，等你处理
- 已安装：自动探测并转码，走完整链路
- 转换脚本输出里有 `ffmpeg` 字段，如实报告探测结果（`null` 表示没找到）

## 目录结构

```
dsh-music-pipeline/
├── index.js                      # host 半边：注册 music_scan / music_transfer
├── cordis.patch.yml              # Cordis bundle 挂载声明
├── lib/
│   ├── platform.js               # 跨平台抽象层（路径/命令/挂载点）
│   ├── ncm-decryptor.js          # NCM 解密核心
│   └── decrypt/                  # 全格式解密 + 统一调度
│       ├── index.js              #   decrypt() 调度：扩展名 → 魔数 → 报错
│       └── ncm.js  kgm.js  kwm.js  qmc.js
├── scripts/
│   ├── ncm-auto-convert.mjs      # 转换（cron 驱动，插件不接管）
│   ├── ncm-otg-transfer.mjs      # OTG 传输（music_transfer 底层）
│   ├── gen-decrypt-tables.cjs    # 从上游程序化提取常量表（勿手抄）
│   └── asi-scan.cjs              # ASI 分号陷阱静态扫描
├── test/                         # 单测 + 跨平台模拟 + E2E
└── run-tests.mjs                 # 测试入口
```

脚本路径不硬编码：`index.js` 用 `import.meta.url` 反推自身目录，安装到任何位置都能定位子脚本。

## 开发命令

```bash
npm run test              # 单元测试（本机 node --test 有兼容问题，走 run-tests.mjs）
npm run e2e               # 全流程 E2E（临时目录 + 假卡，绝不碰真实下载目录/真实卡）
npm run verify:ffmpeg     # ffmpeg 接线验证（假 ffmpeg 记录 argv）
npm run verify:asi        # ASI 分号陷阱扫描
npm run gen:tables <目录> # 从上游参考实现重新提取常量表
```

真实文件对比用例通过环境变量注入，缺省自动跳过（CI 上不会因缺文件而红）：

```bash
NCM_REF_NCM=/path/to/源文件.ncm NCM_REF_FLAC=/path/to/产物.flac npm run test
```

## 测试策略：为什么不用 mock

解密器的正确性测试采用**测试侧独立实现加密器**的方式，而不是 mock 或调用被测模块的内部函数：

- 测试自己按算法事实把明文加密成密文，再让被测解密器还原，逐字节比对
- 解密器算法有任何一处错，这条断言就会红——mock 会让 bug 和被测代码「错在一起」，测不出来
- 开发阶段另做过与上游参考实现的逐字节交叉验证（结论记在 CHANGELOG）

E2E 则**直接跑两个生产脚本子进程**（靠环境变量指向临时沙箱），覆盖真实链路：扫描 → 解密 → 转码 → 重命名 → 归档 → 传输 → MD5 → 结构校验 → 删源 → 清归档 → 幂等复跑。

## 已知限制

### 验证边界（重要，请如实评估）

- **KGM / QMC / KWM 的真实样本未覆盖**：开发环境里没有任何真实的酷狗 / QQ 音乐 / 酷我加密文件。这三个解密器的正确性依据是两条：① 与上游 MIT/Apache-2.0 参考实现在任意输入下**逐字节输出一致**；② 测试侧独立实现加密器做**正向还原**（明文→加密→解密→逐字节比对）。这能证明算法实现正确，但**不等于真实歌曲验证**——真实文件可能碰到上游实现也未覆盖的容器变体。首次使用请务必先拿一两首歌试，并自行保留原件。
- **NCM 已用真实文件验证**：`方大同 - 春风吹.ncm`（19,310,233 B）走完整链路，产物与 v0.1.0 参考输出一致。
- **Windows 逻辑已模拟验证，真机未覆盖**：伪造 `process.platform='win32'` 跑通了路径拼接、工具探测、盘符判定、挂载点归一（见 `test/platform-crossplatform.test.js`），但没有 Windows 机器可做真机验证。

### 功能与平台限制

- **QQ 音乐 musicex 布局（2023+ 客户端）不支持**：该布局不内嵌密钥，必须联网用 Cookie 换取。本插件**不联网、不代用户访问腾讯接口**，遇到时返回明确错误，可手动提供 ekey
- **不做有损转码/音质处理**：只做字节级还原与 FLAC 无损转换，不重采样、不改位深、不嵌封面
- **Android 存储权限（实测）**：
  - `/storage/emulated/0/**`（内部共享存储，含下载目录）：进程 uid 在 `everybody` 组内即可读写，**无需 Shizuku**
  - `/storage/<卷标>`（OTG 外置卡）：`/storage` 目录本身对普通 uid 是 `Permission denied`，**无法自动枚举挂载点**——因此本插件要求显式传挂载点，刻意不猜卷标。实际能否读写取决于运行环境授予进程的存储授权（Termux 需 MANAGE_EXTERNAL_STORAGE；Shizuku / root 通道另计）
  - 插卡后建议重启 DSH 再调用 `music_transfer`，否则授权快照里可能还没有新挂载点
- **DSH 是长驻进程**：改完插件代码必须重启 DSH 才生效

## 许可证与第三方来源

本插件源码以 **MIT** 授权（见 [LICENSE](LICENSE)）。

部分解密实现移植自第三方开源项目，其许可义务另行适用：

- **NCM**：算法事实与常量表参考 **ncmdump（taurusxin/ncmdump, MIT）**；**Unlock Music（MIT）** 列为补充参考。本仓库为独立实现，**未复制任何上游源码文件**。Unlock Music 许可证全文（镜像站原文照录）见 [LICENSE.unlock-music](LICENSE.unlock-music)
- **KGM / KGMA / VPR、QMC 系列、KWM**：移植自 **OpenConverter（nowa277/OpenConverter, Apache-2.0）**；Apache-2.0 全文副本见 [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt)。其中 KWM 的算法上游 MusicDecrypto 为 LGPL-2.1，本仓库只采纳公开算法事实、未复制其代码（详见声明）
- **逐条来源、采纳范围与验证状态**见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

> ⚠️ **法律风险提示**：任务最初要求借鉴 Unlock Music，但该项目的 GitHub 仓库**已被 DMCA takedown 下架**（权利方主动投诉）。这说明公开分发同类解密工具存在真实的下架/投诉风险。本插件按「个人自有内容格式转换」定位，请自行评估所在司法辖区的合规性。

## 免责声明

本插件会**删除源文件**。虽已内置 MD5 校验、FLAC 结构完整性检查、同名冲突质量裁决等多重保护，且任何不确定情形下均保留原始文件，但**请首次使用时先以小批量验证，确认符合预期再正式使用**。

因使用本插件导致的数据丢失或损坏，作者不承担任何责任。请自行做好备份。
