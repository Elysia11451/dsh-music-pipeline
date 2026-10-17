# Changelog

本项目遵循 [约定式提交](https://www.conventionalcommits.org/zh-hans/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。
每条变更均标注**影响面**，便于判断是否与自己的使用场景相关。

## v0.2.0 预览版 (2026-10-18)

> **为什么是预览版**：以下两项验证缺口未闭合，故不标正式版。
>
> **验证边界（发布前审计结论，请如实评估）**
> - **KGM / QMC / KWM：算法正确性已验证，真实样本未覆盖** —— 开发环境无任何真实酷狗/QQ音乐/酷我加密文件。依据是①与上游参考实现在任意输入下逐字节输出一致；②测试侧独立实现加密器做正向还原。这不等于真实歌曲验证。
> - **Windows：逻辑已模拟验证（伪造 `process.platform='win32'`），真机未覆盖。**
> - **NCM：已用真实文件（19,310,233 B）走完整链路验证。**
> 首次使用请先拿一两首歌试，并自行保留原件。

### Added — 跨平台（Windows + Android）

- **`lib/platform.js` 平台抽象层**：集中处理平台判定、路径、外部命令、挂载点。业务代码不再出现 `/storage/`、`/data/data/`、`C:\` 等硬编码前缀。影响面：同一份代码在 Android 与桌面平台各用符合本地惯例的默认目录。
  - `canonPath()` 沿父链上溯到真实存在的祖先再做 `realpathSync`，解决 Android 上 `/data/user/0/<pkg>` 与 `/data/data/<pkg>` 互为别名导致「字符串比较判为不同目录」的问题（后果是重复建目录、重复复制、漏删文件）
  - `findToolPath()` 三级探测：显式配置 > 平台默认安装位置 > PATH。**配置了错误路径时明确抛错，不静默回落**——否则用户会误以为自己的配置生效了
  - `isRemovableMount()` 分平台判定外置挂载点：Android `/storage/<卷标>`（排除 `/storage/emulated` 内部存储）、Windows 非系统盘盘符、macOS `/Volumes/*`
- **外部命令统一 `execFile(binary, [args])`**：数组参数不走 shell。影响面：路径含空格/中文/引号时不再被拆坏或注入。
- **新增配置项 `ffmpegPath` / `otgMountPoint`**：均可留空走自动探测。影响面：换机器、换卡只改配置不改源码。

### Added — 全格式解密

- **`lib/decrypt/` 统一调度层**：`decrypt()` 按「扩展名精确匹配 → 文件头魔数嗅探 → 明确报错」路由，输出统一形状 `{ok, output, format, title, artist, album, audioBytes}`。影响面：新增格式只需加一个文件 + 注册表一行，扫描/转换/传输链路零改动。
- **KGM / KGMA / VPR（酷狗）**：17 字节逐文件密钥 + 三张 272 字节掩码表。流式 64KB 分块解密。
- **QMC 系列（QQ 音乐）**：V1 静态掩码（32768 字节）与 V2（Tencent TEA 双层派生 + RC4 变体 / MapMask 两条分支）；支持 STag 头部、QTag 尾部、raw 尾部三种容器布局。
- **KWM（酷我）**：seed 十进制 ASCII 与 32 字节 ROOT 异或派生掩码，循环 XOR。
- **非 FLAC 产物接入 ffmpeg 无损转码**：此前 MP3/OGG 封装的源只能标 `needs-transcode` 并删产物（等于「能解不能用」）；检测到 ffmpeg 时自动转 FLAC 走完整链路，未装则保持原行为并说明原因。影响面：转换脚本输出新增 `ffmpeg` 字段如实报告探测结果。
- **常量表程序化提取（`scripts/gen-decrypt-tables.cjs`）**：掩码表/S 盒从上游参考实现自动提取写入，幂等可复现。影响面：手抄 272×3 字节表必错且错误不可见（错一字节整首歌解不出来），现在改表只需重跑脚本。

### Changed

- **`music_scan` 扫描范围跟着解密注册表走**：不再写死 `.ncm`。影响面：新增格式自动被扫描到。
- **`music_transfer` 的 `targetMountPoint` 改为可选**：可回落配置项 `otgMountPoint`。影响面：桌面用户配一次即可，不必每次传参。
- **删除写死的默认候选卷标 `62B8-A13F`**：无参数且未配置时明确报错退出（exit 2）。影响面：换机器/换卡不会再「插了卡却传到不存在的卷标」。
- **`index.js` 去除与 `lib/platform.js` 重复的 `nodeExecutable()` / `execFileP()`**：统一从 platform 取。影响面：Android 的 `process.execPath` 是 linker64（spawn 报 `bad ELF magic`）这一坑只在一处维护。

### Fixed

- **`decryptorFor('.ncm')` 裸扩展名返回 null**：条件 `ext.includes('.')` 会把 `.ncm` 送进 `path.extname`，而 `path.extname('.ncm') === ''`（POSIX 把 `.ncm` 整个当文件名），导致查表失败。影响面：所有以裸扩展名调用的地方静默拿到 null 走错分支。
- **`normalizeMeta(null, fallback)` 不退回文件名**：null 分支提前 return，跳过了 fallback 逻辑。影响面：元数据缺失时产物名退化成空串而非原文件名。
- **`isRemovableMount('E:\')` 在非 Windows 主机上恒为 false**：`canonPath` 走 `path.resolve`，`E:\` 在 POSIX 语义下是相对路径会被拼进 cwd，盘符特征丢失。修法：Windows 盘符判定移到归一化**之前**，直接对原始串做正则。
- **`mountLabel('/storage', '/storage')` 返回 `'storage'` 而非空串**：丢了「存储根本身不是挂载点」的检查。影响面：会被当卷标拼成 `/storage/storage` 这种不存在路径，报错信息误导排查。
- **`keyCompress` 收到 Uint8Array 时崩溃**：`Uint8Array.charCodeAt` 不存在。影响面：V2 走 MapMask 分支必炸。
- **JSDoc 注释内的 `.qmc*/.mflac*` 提前闭合块注释**：`*/` 出现在注释中间导致其后内容被当代码解析，报 `SyntaxError: Unexpected token '.'`。已加全项目扫描防复发。
- **ASI 分号陷阱全项目扫描**：新增 `scripts/asi-scan.cjs`（扫描前 mask 注释与字符串；安全行尾集合**故意不含 `)` 与 `]`**，因为 `f()` 后跟 `(x)` 正是陷阱本体）。当前生产代码 0 处候选。
- **【发布前审计】QMC 布局路由与上游不一致**：原实现按「命中 EXT_MAP_V1 才算 V1」，而上游是「只有命中 EXT_MAP_V2 才走 V2，其余默认 V1」。影响面：`.tkm` / `.tm0` / `.tm3` / `.qmc2` / `.qmc3a` 这些不在任一表里的扩展名会被错误路由到 V2，因找不到容器标记而误报「无内嵌密钥」。已对齐上游判据并实测这些扩展名按 V1 正确解密。
- **【发布前审计】OTG 多候选兜底只看第一个**：传输脚本的「原始值直接当路径」兜底轮引用的是 `candidates[0]`，传多个挂载点时第二、三个的原始路径永远不会被直接尝试（Windows 传多个盘符场景必失配）。已改为保留「原始值 ↔ 归一短名」配对逐个兜底，并实测第二候选可正确命中。
- **【发布前审计】`ffmpegPath` 配置项是死配置**：此前 host 侧无任何代码消费它（转换脚本由 cron 独立驱动、只读自己的 `--ffmpeg` / `NCM_FFMPEG`）。已接进 `music_scan` 作为诊断输出（探测结果与缺失提示随清单返回），并把配置描述改为如实说明其作用边界。

### Testing

- **单元测试 10 → 71 用例**（4 个文件）：新增多格式契约/坏输入/正向还原、调度层契约、跨平台模拟三套。
- **解密正确性采用「测试侧独立实现加密器」**：测试自己按算法事实把明文加密，再让被测解密器还原并逐字节比对。影响面：mock 会让 bug 与被测代码「错在一起」测不出来，这种方式解密器任一处写错断言即红。
- **E2E 改为直接跑两个生产脚本子进程**（此前是自带简化版 copy+md5，只覆盖 happy path）：真实覆盖扫描→解密→转码→重命名→归档→传输→MD5→结构校验→删源→清归档→幂等复跑，全程临时目录 + 假卡。
- **与上游参考实现逐字节交叉验证**（开发阶段）：KGM/VPR 在 2 分支 × 5 个偏移、QMC 的 V1/V2-RC4/V2-MapMask 三条路径与 detectKey 三种布局、KWM 的 buildMask/decryptChunk 均与上游输出一致。
- **真实 NCM 全链路验证通过**：`方大同 - 春风吹.ncm`（19,310,233 B）解密 → 重命名 → 传卡 → 校验 → 删源，产物与 v0.1.0 参考输出一致。

### Security

- **移除 QMC 联网取 ekey 能力**：musicex 布局一律返回明确错误，可手动提供 ekey。影响面：插件不联网、不代用户访问腾讯接口、不持有用户 Cookie。
- **空卷标拒绝猜测**：传入 `/storage`、`/storage/` 等存储根时明确报错退出。

### Dependencies

- **仍为零第三方运行时依赖**：新增解密器只用 Node 内置模块（`node:crypto`/`node:fs`/`node:path`），无 npm 包、无 WASM、无二进制。
- **新增许可合规文件**：`LICENSE`（本仓库 MIT，此前缺失）、`LICENSE-APACHE-2.0.txt`（上游全文副本）、`THIRD_PARTY_NOTICES.md`（逐条来源/许可/采纳范围/验证状态）。

### Notes — 关于 Unlock Music 与法律风险

任务原定为「移植 Unlock Music（MIT）」。实际执行时发现 **Unlock Music 的 GitHub 仓库已被 DMCA takedown 下架**（`github.com/unlock-music/unlock-music` 返回 "Repository unavailable due to DMCA takedown"）。因此改用仍正常分发、许可明确的 **OpenConverter（Apache-2.0）** 作为移植基准，并在代码注释中如实署名（初稿曾误标为 MIT，已更正）。

这一变化本身即是风险信号：权利方在主动投诉下架同类工具。公开发布本插件的解密模块存在被同样处置的可能，详见 README「法律风险提示」。

---

## v0.1.0 (2026-10-17)

### Added

- **NCM 自动转换与 OTG 传输流水线**：监控下载目录 → 纯解密转 FLAC → 按「歌名 - 歌手」重命名 → 插卡后自动复制校验 → 删除手机源文件。影响面：用户无需手动处理 NCM，插卡即可同步。
- **`music_scan` 原生工具**：只读扫描网易云下载目录，返回待处理 `.ncm`/`.flac` 清单。影响面：不修改任何文件，可随时调用。
- **`music_transfer` 原生工具**：将「准备传输」中的 FLAC 复制到 OTG 挂载点，MD5 + 结构校验通过后删除手机源。影响面：高危操作，会删手机源文件，需用户明确要求后调用。
- **纯 JS FLAC 结构校验器**：无 `flac` 命令、无 ffmpeg 环境下完成帧头校验、元数据块链闭合校验、STREAMINFO 采样数与音频区体积比截断检测。影响面：坏文件不会进入 OTG 卡。
- **OTG 挂载点参数归一化**：兼容绝对路径（`/storage/<卷标>`）与卷标短名（`<卷标>`）两种传法，统一 `path.join` 拼装。影响面：修复调用方传绝对路径时 `'/storage/' + m` 拼成 `/storage//storage/xxx` 导致「插了卡也传不成」的问题。
- **Android 子进程执行兼容层**：`process.execPath` 在 Android 指向 `linker64`（ELF 是链接器非 node），改用 `process.argv0` 解析真实 node 路径，并以 callback 包装 Promise 替代 `promisify(execFile)`。影响面：插件在本机 Android 上才能拉起底层脚本。
- **三个可配置目录**：`downloadDir` / `stagingDir` / `processedDir`，均带默认值。影响面：不配置也能跑，配置后适配自定义目录布局。

### Fixed

- **挂载点探测误报**：旧逻辑对传入的绝对路径直接做字符串拼接，导致 `existsSync` 永远为 false，报 `ERROR no OTG mount found`。影响面：修复前即使 OTG 卡已插入且挂载正常，传输也必然失败。
- **TDZ 启动崩溃**：归一化逻辑中的报错语句在 `log` 函数定义之前调用，触发 `ReferenceError: Cannot access 'log' before initialization`。影响面：修复后 `/storage`、`/storage/` 等空卷标输入能正确报错退出，而非进程崩溃。

### Security

- **空卷标拒绝猜测**：传入 `/storage` 或 `/storage/` 时明确报错退出，不猜测默认挂载点。影响面：避免误操作写到非预期的存储位置。

### Dependencies

- **零第三方插件依赖**：NCM 解密核心内置于 `lib/ncm-decryptor.js`（仅用 Node 内置 `node:crypto`），不再复用 `dsh-audio-converter`。影响面：不再需要预装任何解密插件，也不需要 ffmpeg，插件完全自包含。

---

## v0.1.0 补记（当时漏记，实际已随 v0.1.0 tag 发布）

核对 `git show v0.1.0:package.json` 与 tag 文件树后确认：以下条目**已包含在 v0.1.0 的提交里**
（`lib/ncm-decryptor.js`、`test/ncm-decryptor.test.js` 均在 tag 内，files 白名单也已含它们），
只是当时 CHANGELOG 未合并进上面的版本段落。此处保留原文备查，避免误读成 v0.2.0 的新增内容。

- **NCM 解密核心内置化**：新增 `lib/ncm-decryptor.js`（AES-128-ECB + RC4 变体密钥盒，独立实现，参考 taurusxin/ncmdump 与 unlock-music 的公开算法事实，MIT）；已用真实 NCM（FLAC 封装）验证，产物与 `dsh-audio-converter` 输出逐字节一致（`cmp` 判定 IDENTICAL，md5 一致）
- **转换脚本去第三方化**：`ncm-auto-convert.mjs` 移除 `await import(...dsh-audio-converter/lib/pipeline.js)`，改为调用内置 `decryptNcmToFile()`；扫描/重命名/原生 FLAC 直通/归档/manifest 逻辑未改动
- 脚本层挂载点归一化与 `path.join` 改造（已 sandbox 端到端验证：`copied/verified/deleted/failures` 四字段结构正确，md5 卡上副本与源一致）
- **真卡终验已完成**：转换脚本与传输脚本在真实 OTG 卡上端到端跑通，`copied/verified/deleted/failures` 四字段结构正确，卡上副本 md5 与源一致
- **ASI 分号陷阱修复**：`index.js` 中 `const shortName = posix.basename(mnt)` 缺分号，下一行以 `(` 开头被合并解析为对字符串的函数调用。影响面：原生 `music_transfer` 调用必然崩溃（`node --check` 查不出，只有实际运行才炸）。已改为行尾分号 + 行首 `;` 双保险。
- **路径完全参数化**：`index.js` 与两个子脚本不再硬编码 应用私有数据目录、manifest 与日志改用 `os.homedir()` 派生，暂存/归档/源目录改为「环境变量 > 参数 > 中性默认值」三级覆盖。影响面：换机器、npm 安装到 `node_modules/` 后无需改任何路径。
- **测试可移植**：真实文件对比用例改为通过 `NCM_REF_NCM` / `NCM_REF_FLAC` 注入，缺省自动跳过。影响面：CI 或新机器上 `npm test` 不再因缺参考文件而失败。
