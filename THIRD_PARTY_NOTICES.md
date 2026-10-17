# 第三方来源与许可声明（THIRD-PARTY-NOTICES）

本插件的解密能力建立在若干上游项目的公开算法事实之上。为免歧义，逐条列明
**实际移植来源**、**许可类型**与**采纳范围**。

---

## 1. NCM（网易云音乐）— `lib/ncm-decryptor.js`、`lib/decrypt/ncm.js`

- **算法事实来源**：
  - ncmdump（taurusxin/ncmdump，MIT）— 两层加密容器结构与固定密钥
  - Unlock Music（unlock-music/unlock-music，MIT）— 补充参考
  - manalogues《NCM 文件的加解密笔记》（CC BY 4.0）
- **采纳范围**：仅采纳公开算法事实与协议常量（magic、core key、meta key、
  RC4 变体密钥盒构造）。代码为本仓库独立实现，未复制任何上游源码文件。
- **关于 Unlock Music**：本项目 GitHub 仓库已被 DMCA takedown 下架，
  本仓库未复制其任何源码；因其被列为格式事实的补充参考，仍随包保留其
  MIT 许可证全文（见 [LICENSE.unlock-music](LICENSE.unlock-music)，版权行 *Copyright (c) 2019-2023 MengYX* 取自其镜像站原文照录）。
- **验证状态**：已用真实 NCM 文件验证，解密产物与 `dsh-audio-converter`
  输出逐字节一致。

## 2. KGM / KGMA / VPR（酷狗）— `lib/decrypt/kgm.js`

- **实际移植来源**：**OpenConverter（nowa277/OpenConverter，Apache-2.0）**
  的 `src/decoders/kgm.js`
- **上游自述**：该文件自称 "Re-implemented from scratch based on
  huangbao/MyKgmWasm (MIT, 2025)"
- **采纳范围**：容器布局事实、16 字节 magic 常量、17 字节密钥派生规则、
  三张 272 字节掩码表（`MASK_V2_PRE_DEF` / `TABLE1` / `TABLE2`）与
  `VPR_MASK_DIFF`。掩码表由 `scripts/gen-decrypt-tables.cjs` 从上游
  程序化提取（不手抄），解密逻辑按本仓库契约重写为流式实现。
- **许可义务**：Apache-2.0 要求保留版权与许可声明，故附
  [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt) 全文副本。
- **验证状态**：与上游实现在 KGM/VPR 两分支、多个偏移下逐字节一致；
  端到端正向还原由 `test/decrypt-formats.test.js` 覆盖（测试侧独立实现
  加密器，不复用被测代码）。

## 3. QMC 系列（QQ 音乐：qmc0/qmc3/qmcflac/qmcogg/mflac/mgg/bkc…）
##    — `lib/decrypt/qmc.js`

- **实际移植来源**：**OpenConverter（nowa277/OpenConverter，Apache-2.0）**
  的 `src/decoders/qmc.js`
- **采纳范围**：V1 静态盒（`QMC1_STATIC_BOX`，256 字节）与 V1 掩码派生规则、
  V2 的 ekey 派生链（Tencent TEA 变体 + `MIX_KEY_1`/`MIX_KEY_2` +
  `keyCompress`）、RC4 变体分段规则、STag/QTag/musicex/raw 四种容器布局。
- **本仓库的改动**：改为流式解密（不全量读入内存）；`detectKey` 改为
  只读头尾窗口的按需视图；**移除联网取 ekey 的能力**——musicex 布局
  一律返回 `ok:false` 并说明需要用户提供 ekey，不代替用户访问腾讯接口。
- **许可义务**：同上，附 Apache-2.0 全文副本。
- **验证状态**：V1 端到端逐字节还原、V2/MapMask 端到端逐字节还原、
  `qmcDeriveKey` 与 `detectKey` 三种布局均与上游一致。
  V2/RC4 分支（长 ekey）已与上游交叉验证一致，但端到端仅由合成样本覆盖。

## 4. KWM（酷我）— `lib/decrypt/kwm.js`

- **实际移植来源**：**OpenConverter（nowa277/OpenConverter，Apache-2.0）**
  的 `src/decoders/kwm.js`
- **上游自述**：该文件自称 "Re-implemented from scratch based on
  davidxuang/MusicDecrypto (**LGPL-2.1, do not copy**)"
- **关于 LGPL 的说明（重要）**：MusicDecrypto 是 LGPL-2.1，且上游文件头
  明确标注 "do not copy"。本文件**未复制任何 LGPL 代码**——只采纳该算法
  的公开事实（`yeelion-kuwo` magic、0x400 音频偏移、seed 十进制 ASCII
  与 32 字节 ROOT 常量异或派生掩码、循环 XOR），代码按 Apache-2.0
  上游的接口重写为流式实现。
- **验证状态**：`buildMask` 与 `decryptChunk` 均与上游一致；端到端
  正向还原由测试覆盖。

---

## 为什么不是 Unlock Music

任务最初要求「借鉴 Unlock Music（MIT）」。实际情况：

**Unlock Music 的 GitHub 仓库已被 DMCA takedown 下架**
（访问 `github.com/unlock-music/unlock-music` 返回
"Repository unavailable due to DMCA takedown"）。因此本仓库**没有**以它
为移植来源，改用仍正常分发、许可明确的 OpenConverter（Apache-2.0）。

这一变化同时意味着一个真实风险：上游因同类功能被权利方投诉下架。
本插件按「个人自有内容格式转换」定位分发，若权利方提出投诉，
本仓库可能面临同样处置。使用者请自行评估所在司法辖区的合规性。

## 常量表的生成方式

`lib/decrypt/*.js` 中标注「自动生成，勿手改」的字节表由
`scripts/gen-decrypt-tables.cjs` 从上游参考实现**程序化提取**后写入。
这样做的理由：这些表（272×3、256、32 字节等）手抄极易出错且错误不可见
（错一个字节整首歌解不出来）。重跑脚本可复现，不依赖任何二进制产物。
