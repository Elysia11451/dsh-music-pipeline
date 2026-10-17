# Changelog

本项目遵循 [约定式提交](https://www.conventionalcommits.org/zh-hans/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。
每条变更均标注**影响面**，便于判断是否与自己的使用场景相关。

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

## 未发布（工作区）

以下变更已实现并验证，尚未纳入上述版本号：

- **NCM 解密核心内置化**：新增 `lib/ncm-decryptor.js`（AES-128-ECB + RC4 变体密钥盒，独立实现，参考 taurusxin/ncmdump 与 unlock-music 的公开算法事实，MIT）；已用真实 NCM（FLAC 封装）验证，产物与 `dsh-audio-converter` 输出逐字节一致（`cmp` 判定 IDENTICAL，md5 一致）
- **转换脚本去第三方化**：`ncm-auto-convert.mjs` 移除 `await import(...dsh-audio-converter/lib/pipeline.js)`，改为调用内置 `decryptNcmToFile()`；扫描/重命名/原生 FLAC 直通/归档/manifest 逻辑未改动
- 脚本层挂载点归一化与 `path.join` 改造（已 sandbox 端到端验证：`copied/verified/deleted/failures` 四字段结构正确，md5 卡上副本与源一致）
- **真卡终验已完成**：转换脚本与传输脚本在真实 OTG 卡上端到端跑通，`copied/verified/deleted/failures` 四字段结构正确，卡上副本 md5 与源一致
- **ASI 分号陷阱修复**：`index.js` 中 `const shortName = posix.basename(mnt)` 缺分号，下一行以 `(` 开头被合并解析为对字符串的函数调用。影响面：原生 `music_transfer` 调用必然崩溃（`node --check` 查不出，只有实际运行才炸）。已改为行尾分号 + 行首 `;` 双保险。
- **路径完全参数化**：`index.js` 与两个子脚本不再硬编码 应用私有数据目录、manifest 与日志改用 `os.homedir()` 派生，暂存/归档/源目录改为「环境变量 > 参数 > 中性默认值」三级覆盖。影响面：换机器、npm 安装到 `node_modules/` 后无需改任何路径。
- **测试可移植**：真实文件对比用例改为通过 `NCM_REF_NCM` / `NCM_REF_FLAC` 注入，缺省自动跳过。影响面：CI 或新机器上 `npm test` 不再因缺参考文件而失败。
