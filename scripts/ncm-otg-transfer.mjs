#!/usr/bin/env node
// ncm-otg-transfer.mjs v3 — 传输 + MD5 校验 + 查重 + 传后完整性检查 + 条件清理
// 用法: node ncm-otg-transfer.mjs [--yes-delete-ncm] [卷标候选...]
// v3 新增: ①传卡前查重——卡里已有同名同 MD5 文件 → 核实(卡上副本 jsCheck 完好)后删手机 FLAC
//         ②传后检查——复制+MD5 一致后再对卡上副本跑 JS 结构校验，坏的删卡上副本、保留手机源
// 规则: NCM 删除仍需 --yes-delete-ncm 二次确认；FLAC 删除均先记 WILL DELETE 日志
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, unlinkSync, appendFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// 路径全部可配置：环境变量 > 中性默认值（不绑定任何具体机器）。
// OUT_DIR 是待传输 FLAC 的暂存目录，ARCHIVE_DIR 是已转换 NCM 的归档目录。
const HOME = homedir();
const OUT_DIR = process.env.NCM_STAGING_DIR || "/storage/emulated/0/Download/准备传输";
const ARCHIVE_DIR = process.env.NCM_ARCHIVE_DIR || "/storage/emulated/0/Download/netease/cloudmusic/Music/已处理NCM";
const STORAGE_ROOT = process.env.NCM_STORAGE_ROOT || "/storage";
const MANIFEST = process.env.NCM_MANIFEST || join(HOME, "ncm-manifest.jsonl");
const LOG = process.env.NCM_TRANSFER_LOG || join(HOME, "ncm-transfer.log");
const log = (msg) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); try { appendFileSync(LOG, line + "\n"); } catch {} };
const YES = process.argv.includes("--yes-delete-ncm");
// 兼容清洗：调用方可能传短名（卷标）也可能传绝对路径（/storage/<卷标>）。
// 一律归一成短名，后面统一 join 出 /storage/<短名>，避免 "/storage//storage/xxx" 这类拼坏。
function mountShortName(v) {
  let s = String(v || "").trim().replace(/\/+$/, "");   // 去掉尾斜杠
  if (s === STORAGE_ROOT) return "";                     // "/storage" 本身不是挂载点
  const idx = s.indexOf(STORAGE_ROOT + "/");
  if (idx >= 0) s = s.slice(idx + STORAGE_ROOT.length + 1); // 取 /storage/ 之后的部分
  const parts = s.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";     // 只认最后一段当卷标
}
const candidates = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mounts = candidates.map(mountShortName).filter(Boolean);
if (candidates.length && !mounts.length) {
  log(`ERROR no usable mount name in args: ${candidates.join(", ")} (传 /storage/<卷标> 或直接 <卷标>)`);
  process.exit(2);
}
if (!mounts.length) mounts.push("62B8-A13F");             // 无参数时的历史默认候选
const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");

// --- 纯 JS FLAC 结构校验（自 scan-sdcard-audio.mjs 复用，只读） ---
function readAt(fd, pos, len) { const buf = Buffer.alloc(len); const n = readSync(fd, buf, 0, len, pos); return buf.subarray(0, n) }
function validUtf8Num(buf, off) {
  const b0 = buf[off]; if (b0 === undefined) return -1;
  let n = 1;
  if ((b0 & 0x80) === 0) n = 1; else if ((b0 & 0xE0) === 0xC0) n = 2; else if ((b0 & 0xF0) === 0xE0) n = 3;
  else if ((b0 & 0xF8) === 0xF0) n = 4; else if ((b0 & 0xFC) === 0xF8) n = 5; else if ((b0 & 0xFE) === 0xFC) n = 6;
  else if (b0 === 0xFE) n = 7; else return -1;
  for (let i = 1; i < n; i++) if ((buf[off + i] & 0xC0) !== 0x80) return -1;
  return off + n;
}
function frameHeaderAt(fd, pos, fileSize) {
  if (pos + 16 > fileSize) return false;
  const h = readAt(fd, pos, 16); if (h.length < 16) return false;
  if (h[0] !== 0xFF || (h[1] & 0xFC) !== 0xF8 || (h[1] & 0x01) !== 0) return false;
  const bs = h[2] >> 4, sr = h[2] & 0x0F, ch = h[3] >> 4, ss = (h[3] >> 1) & 0x07;
  if (bs === 0x0E || bs === 0x0F) return false;
  if (sr === 0x0F) return false;
  if (ch === 0x0F) return false;
  if (ss === 0x03) return false;
  if ((h[3] & 0x01) !== 0) return false;
  return validUtf8Num(h, 4) > 0;
}
function jsCheck(path) {
  const size = statSync(path).size;
  if (size < 42) return { ok: false, err: "文件过小，不是完整 FLAC (" + size + "B)" };
  const fd = openSync(path, "r");
  try {
    const head = readAt(fd, 0, 4 + 4 + 34);
    if (head.subarray(0, 4).toString("latin1") !== "fLaC") return { ok: false, err: "缺少 fLaC 魔数" };
    let off = 4, lastSeen = false, blocks = 0, streaminfo = null;
    while (!lastSeen) {
      if (off + 4 > size) return { ok: false, err: "元数据块链未闭合（截断）" };
      const bh = readAt(fd, off, 4);
      lastSeen = (bh[0] & 0x80) !== 0;
      const len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
      const type = bh[0] & 0x7F;
      if (type === 0) { const si = readAt(fd, off + 4, 34); if (si.length < 34) return { ok: false, err: "STREAMINFO 截断" }; streaminfo = { totalSamples: ((si[13] & 0x0F) * 2 ** 32) + (si[14] * 2 ** 24) + (si[15] * 2 ** 16) + (si[16] * 2 ** 8) + si[17] }; }
      off += 4 + len; blocks++;
      if (blocks > 10000) return { ok: false, err: "元数据块链异常" };
    }
    if (off + 16 > size) return { ok: false, err: "音频帧区截断" };
    if (!frameHeaderAt(fd, off, size)) return { ok: false, err: "音频区起始无合法帧头" };
    const tail = Math.max(off + 16, size - 65536);
    let tailOk = false;
    for (let p = tail; p <= size - 16 && p < tail + 65536; p++) { if (frameHeaderAt(fd, p, size)) { tailOk = true; break } }
    if (!tailOk) return { ok: false, err: "尾部无合法帧头（疑似截断，size=" + size + "B）" };
    if (streaminfo && streaminfo.totalSamples > 0) {
      const bps = (size - off) / streaminfo.totalSamples;
      if (bps < 0.5) return { ok: false, err: "音频数据量与采样数严重不符（" + bps.toFixed(3) + " B/采样），疑似截断" };
    }
    return { ok: true, note: "结构完整" };
  } finally { closeSync(fd) }
}

// FLAC 元数据（ffprobe 等价，纯 JS 读 STREAMINFO：采样率/位深/时长）
function flacInfo(p) {
  try {
    const fd = openSync(p, "r");
    try {
      const head = readAt(fd, 0, 42);
      if (head.subarray(0, 4).toString("latin1") !== "fLaC") return null;
      const bh = head.subarray(4, 8);
      if ((bh[0] & 0x7F) !== 0) return null;
      const si = head.subarray(8, 42);
      const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
      const bitsPerSample = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
      const totalSamples = ((si[13] & 0x0F) * 2 ** 32) + (si[14] * 2 ** 24) + (si[15] * 2 ** 16) + (si[16] * 2 ** 8) + si[17];
      return { sampleRate, bitsPerSample, durationSec: +(totalSamples / sampleRate).toFixed(3) };
    } finally { closeSync(fd) }
  } catch { return null }
}

log(`=== ncm-otg-transfer v3 start (yesDeleteNcm=${YES}) ===`);
// 挂载点探测：join('/storage', 短名)，不再手工拼字符串（ESLint no-path-concat）
let root = null;
for (const m of mounts) {
  const p = join(STORAGE_ROOT, m);
  if (existsSync(p)) { root = p; break; }
}
if (!root) { log(`ERROR no OTG mount found among: ${mounts.map((m) => join(STORAGE_ROOT, m)).join(", ")}`); process.exit(2); }
const musicDir = join(root, "Music");
log(`mount=${root} music=${musicDir}`);

let files = [];
try { files = readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith(".flac") && !f.toLowerCase().endsWith(".backup.flac")); }
catch { log(`ERROR cannot read ${OUT_DIR}`); process.exit(2); }
log(`found ${files.length} flac in 准备传输`);

// 卡上 Music 递归文件名→路径（查重用）
const cardIndex = new Map();
(function walk(d) { let es = []; try { es = readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== ".thumbnails") walk(p) } else if (e.name.toLowerCase().endsWith(".flac")) { if (!cardIndex.has(e.name)) cardIndex.set(e.name, p) } } })(musicDir);
log(`card flac index: ${cardIndex.size} entries`);

// NCM 清单匹配删除（仅 --yes-delete-ncm 时真删）
function handleNcm(flacName, failuresRef) {
  let matched = null, ambiguous = false, nativeHit = false;
  try {
    const hits = readFileSync(MANIFEST, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((e) => e && e.flac === flacName);
    if (hits.length > 1) {
      const ncmHits = hits.filter((h) => typeof h.ncm === "string" && h.ncm);
      if (ncmHits.length > 1) ambiguous = true; else if (ncmHits.length === 1 && !ncmHits[0].ncm.includes("/") && !ncmHits[0].ncm.includes("\\")) matched = ncmHits[0].ncm;
      else if (hits.some((h) => h.src === "native")) nativeHit = true;
    } else if (hits.length === 1) {
      const h = hits[0];
      if (h.src === "native" || typeof h.ncm !== "string" || !h.ncm) nativeHit = true;
      else if (!h.ncm.includes("/") && !h.ncm.includes("\\")) matched = h.ncm;
    }
  } catch {}
  if (nativeHit) { log(`native flac（原生下载，非 NCM 转换），无需删 NCM: ${flacName}`); return }
  if (ambiguous) { log(`AMBIGUOUS manifest entries for ${flacName}, ncm NOT deleted`); failuresRef.n++; return }
  if (!matched) { log(`no manifest record for ${flacName}, ncm NOT deleted (不瞎删)`); failuresRef.n++; return }
  const ncmPath = join(ARCHIVE_DIR, matched);
  if (!existsSync(ncmPath)) { log(`manifest ncm not found (already removed?): ${ncmPath}`); return }
  if (!YES) { log(`PENDING NCM delete (未带 --yes-delete-ncm 二次确认，保留): ${ncmPath}`); return }
  log(`WILL DELETE: ${ncmPath}`);
  try { unlinkSync(ncmPath); log(`deleted ncm after verify: ${matched}`); }
  catch (e) { log(`ERROR delete ncm ${matched}: ${e.message}`); failuresRef.n++; }
}

const F = { n: 0 };
for (const name of files) {
  const src = join(OUT_DIR, name);
  let srcMd5;
  try { srcMd5 = md5(src); } catch (e) { log(`ERROR read ${name}: ${e.message}`); F.n++; continue; }

  const dup = cardIndex.get(name);
  if (dup) {
    // 卡里已有同名文件
    let dupMd5;
    try { dupMd5 = md5(dup); } catch (e) { log(`ERROR read card dup ${name}: ${e.message}`); F.n++; continue; }
    if (dupMd5 !== srcMd5) {
      // 冲突文件质量裁决：元数据对比 > 完整性校验 > 体积辅助，无法确定时保留双份
      const a = flacInfo(src), b = flacInfo(dup);
      if (!a || !b) { log(`CONFLICT ${name}: 无法读取元数据，两份都保留`); F.n++; continue; }
      log(`CONFLICT ${name}: 手机端 ${a.bitsPerSample}bit/${a.sampleRate}Hz/${a.durationSec}s vs 卡上 ${b.bitsPerSample}bit/${b.sampleRate}Hz/${b.durationSec}s`);
      if (Math.abs(a.durationSec - b.durationSec) > 2) { log(`时长差 >2s，疑不同版本，两份都保留: ${name}`); F.n++; continue; }
      const ca = jsCheck(src), cb = jsCheck(dup);
      let verdict;
      if (ca.ok && !cb.ok) verdict = "card-broken";
      else if (!ca.ok && cb.ok) verdict = "phone-broken";
      else if (!ca.ok && !cb.ok) { log(`CONFLICT ${name}: 两份都不完整，都保留待人工处理`); F.n++; continue; }
      else if (a.bitsPerSample !== b.bitsPerSample || a.sampleRate !== b.sampleRate) verdict = a.bitsPerSample * a.sampleRate > b.bitsPerSample * b.sampleRate ? "phone-better" : "card-better";
      else {
        // 参数一致且都完整 → 保留卡上大体积主文件，手机端改 .backup 留在准备传输
        const bk = join(OUT_DIR, name.replace(/\.flac$/i, ".backup.flac"));
        if (existsSync(bk)) { log(`备份已存在，手机源保留原样: ${name}`); F.n++; continue; }
        renameSync(src, bk);
        log(`ADJUDICATED keep-card: ${name} 参数一致(${a.bitsPerSample}bit/${a.sampleRate}Hz)且都完整，保留大体积主文件(${statSync(dup).size}B)，手机端留作备份 -> ${bk}`);
        continue;
      }
      if (verdict === "card-better" || verdict === "phone-broken") {
        log(`WILL DELETE: ${src} (裁决：${verdict === "card-better" ? "卡上版本更高质" : "手机端不完整"}，卡上完整保留)`);
        unlinkSync(src); log(`deleted lower-quality phone copy: ${name}`);
        handleNcm(name, F); continue;
      }
      // phone-better / card-broken：删卡上坏/低质副本，传手机高质版
      log(`WILL DELETE: ${dup} (裁决：${verdict === "phone-better" ? "手机版本更高质" : "卡上副本不完整"})`);
      try { unlinkSync(dup); log(`deleted lower-quality card copy: ${name}`); } catch (e) { log(`ERROR delete card copy: ${e.message}`); F.n++; continue; }
      // 落到正常传输路径继续
    }
    const chk = jsCheck(dup);
    if (!chk.ok) {
      log(`DEDUP BUT CARD COPY BROKEN (${chk.err})：卡上同 MD5 副本损坏，判为坏传输，删卡上副本、保留手机源`);
      log(`WILL DELETE: ${dup}`);
      try { unlinkSync(dup); log(`deleted broken card copy: ${name}`); } catch (e) { log(`ERROR delete broken card copy: ${e.message}`); }
      F.n++; continue;
    }
    log(`DEDUP verified: ${name} 卡里已有同 MD5 且结构完整（${chk.note}），删手机下载副本`);
    log(`WILL DELETE: ${src}`);
    try { unlinkSync(src); log(`deleted duplicate source flac: ${name}`); } catch (e) { log(`ERROR delete: ${e.message}`); F.n++; continue }
    handleNcm(name, F);
    continue;
  }

  // 正常传输
  const dst = join(musicDir, name);
  try { copyFileSync(src, dst); log(`copied: ${name} (${statSync(src).size}B)`); }
  catch (e) { log(`ERROR copy ${name}: ${e.message}`); F.n++; continue; }
  let dstMd5;
  try { dstMd5 = md5(dst); } catch (e) { log(`ERROR verify read ${name}: ${e.message}`); F.n++; continue; }
  if (dstMd5 !== srcMd5) { log(`VERIFY FAIL keep source: ${name} src=${srcMd5} dst=${dstMd5}`); F.n++; continue; }
  // 传后完整性检查：坏的删卡上副本、保留手机源（防坏文件进卡）
  const chk = jsCheck(dst);
  if (!chk.ok) {
    log(`POST-CHECK FAIL (${chk.err})：卡上副本结构损坏，删卡上副本、保留手机源`);
    log(`WILL DELETE: ${dst}`);
    try { unlinkSync(dst); log(`deleted broken card copy: ${name}`); } catch (e) { log(`ERROR delete broken card copy: ${e.message}`); }
    F.n++; continue;
  }
  log(`post-check ok (${chk.note}): ${name}`);
  log(`WILL DELETE: ${src}`);
  try { unlinkSync(src); log(`deleted source after verify: ${name}`); }
  catch (e) { log(`ERROR delete ${name}: ${e.message}`); F.n++; continue; }
  handleNcm(name, F);
}
// 收尾清扫：清单里「FLAC 已不在准备传输（已传完/查重删源）且卡上仍有该文件」的 NCM
{
  let entries = [];
  try {
    entries = readFileSync(MANIFEST, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((e) => e && e.flac && typeof e.ncm === "string" && e.ncm && !e.ncm.includes("/") && !e.ncm.includes("\\"));
  } catch {}
  const pendingNames = new Set(files);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.flac)) continue; seen.add(e.flac);
    if (pendingNames.has(e.flac)) continue;                       // 还在排队，走主循环
    const cardPath = cardIndex.get(e.flac);
    if (!cardPath || !existsSync(cardPath)) continue;             // 卡上没有 → 未传完，不动
    const ncmPath = join(ARCHIVE_DIR, e.ncm);
    if (!existsSync(ncmPath)) continue;                           // 已删过
    if (!YES) { log(`SWEEP PENDING NCM delete (未带 --yes-delete-ncm，保留): ${ncmPath}`); continue; }
    log(`WILL DELETE: ${ncmPath}`);
    try { unlinkSync(ncmPath); log(`deleted ncm (sweep, 对应 flac 已在卡上): ${e.flac} <- ${e.ncm}`); }
    catch (err) { log(`ERROR delete ncm ${e.ncm}: ${err.message}`); F.n++; }
  }
}
log(`=== done, failures=${F.n} ===`);
process.exit(F.n ? 1 : 0);
