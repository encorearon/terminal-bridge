// WS 监听（tap）探针客户端 —— 捕获非终端页面（Yearning 等）的 WebSocket 帧
//
// 用法：
//   node tap-example.mjs <urlIncludes> [maxFrames] [maxSeconds] [--quiet] [--csv]
//   node tap-example.mjs sql.meiyunji.net          # 监听 URL 含该关键字的帧，直到 Ctrl+C
//   node tap-example.mjs sql.meiyunji.net 20 60    # 收满 20 帧或 60 秒退出
//   node tap-example.mjs sql.meiyunji.net 0 300 --quiet --csv  # 只看有效帧并把每次查询结果存 CSV
//
// 工作原理：连本地代理发 tap-start，代理把插件 CDP 抓到的、URL 匹配的
// ws-recv 原始帧以 tap-frame 转发过来。opcode=2 的帧 data 是 base64，
// 本脚本自动解码后打印。配合插件 popup 的「📡 监听当前 Yearning 页」按钮使用。
// --csv：结果帧（results 数组）自动转 CSV 保存到当前目录（yearning-<时间戳>.csv，
//        多结果集会带 -1/-2 序号；带 BOM，Excel 直接打开中文不乱码）。

import WebSocket from "ws";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const BRIDGE = process.env.BRIDGE || "ws://127.0.0.1:8787/ssh";
const urlIncludes = process.argv[2] || "";
const maxFrames = Number(process.argv[3] || 0);   // 0 = 不限
const maxSeconds = Number(process.argv[4] || 0);  // 0 = 不限
const quiet = process.argv.includes("--quiet");   // 跳过心跳帧，只打印有效负载
const csvExport = process.argv.includes("--csv"); // 结果帧自动保存 CSV

// CSV cell 转义：含逗号/引号/换行的值加引号，内部引号翻倍（RFC 4180）
function csvCell(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

if (!urlIncludes) {
  console.error("用法: node tap-example.mjs <urlIncludes> [maxFrames] [maxSeconds]");
  process.exit(1);
}

const ws = new WebSocket(BRIDGE);
let frames = 0;
let bytes = 0;

ws.on("open", () => {
  console.log(`→ tap-start (urlIncludes=${urlIncludes})`);
  console.log("  请在浏览器目标页面操作（如执行 SQL 查询），帧将实时打印：\n");
  ws.send(JSON.stringify({ type: "tap-start", urlIncludes }));
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === "tap-started") {
    console.log(`✓ 监听已建立（${msg.urlIncludes}）\n`);
    return;
  }
  if (msg.type === "tap-error") {
    console.error("✗ tap-error:", msg.error);
    process.exit(1);
  }
  if (msg.type !== "tap-frame") return;

  let text = msg.data || "";
  if (msg.opcode === 2 && text) {
    // 二进制帧：CDP 给的是 base64。解码后若像 MessagePack（map/array/str 头）
    // 自动 msgpack 解码成 JSON 展示（Yearning 走 msgpack 二进制帧）
    const buf = Buffer.from(text, "base64");
    const first = buf[0];
    const looksMsgpack =
      (first >= 0x80 && first <= 0x8f) || first === 0xde || first === 0xdf ||
      first === 0x91 || (first >= 0x90 && first <= 0x9f);
    if (looksMsgpack) {
      try {
        text = JSON.stringify(msgpackDecode(buf), null, 1);
      } catch {
        text = buf.toString("utf8");  // 解码失败退回原文（乱码但可见）
      }
    } else {
      text = buf.toString("utf8");
    }
  }

  // --quiet：跳过纯心跳帧（results 为 null 且 heartbeat=pong），只打印有效负载帧
  if (quiet && text.includes('"results": null')) return;

  // CSV 导出：结果帧（results 数组）自动落盘。
  // 每个 result 元素是一张表（field=列定义 data=数据行），多表写多个文件。
  if (csvExport) {
    let obj = null;
    try { obj = JSON.parse(text); } catch {}
    if (obj && Array.isArray(obj.results) && obj.results.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      obj.results.forEach((table, idx) => {
        if (!table || !Array.isArray(table.field)) return;
        const headers = table.field.map(f => csvCell(f.title || f.dataIndex || ""));
        const rows = (table.data || []).map(row =>
          table.field.map(f => csvCell(row[f.dataIndex])).join(",")
        );
        const csv = "\uFEFF" + [headers.join(","), ...rows].join("\r\n") + "\r\n";
        const file = join(cwd(), `yearning-${stamp}${obj.results.length > 1 ? "-" + (idx + 1) : ""}.csv`);
        writeFileSync(file, csv, "utf8");
        console.log(`💾 CSV 已保存: ${file}（${rows.length} 行）`);
      });
    }
  }

  frames++;
  bytes += text.length;

  console.log(`--- frame #${frames} [${new Date(msg.t || Date.now()).toISOString()}] opcode=${msg.opcode} len=${text.length} url=${msg.url || "(unknown)"} ---`);
  console.log(text.length > 6000 ? text.slice(0, 6000) + `\n...[截断，共 ${text.length} 字符]` : text);
  console.log("");

  if (maxFrames > 0 && frames >= maxFrames) {
    console.log(`✓ 已收满 ${maxFrames} 帧（共 ${bytes} 字符），退出`);
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("✗ ws error:", err.message);
  process.exit(1);
});

if (maxSeconds > 0) {
  setTimeout(() => {
    console.log(`✓ 到达 ${maxSeconds}s 时限（收帧 ${frames} 个 / ${bytes} 字符），退出`);
    process.exit(0);
  }, maxSeconds * 1000);
}

process.on("SIGINT", () => {
  console.log(`\n✓ 手动停止（收帧 ${frames} 个 / ${bytes} 字符）`);
  process.exit(0);
});
