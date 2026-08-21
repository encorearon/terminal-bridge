// Yearning SQL 自动化客户端
//
// 用法：
//   node yr-example.mjs ping                 # 探测编辑器/按钮
//   node yr-example.mjs "SELECT 1"           # 执行查询（注入+点查询+收结果）
//   node yr-example.mjs "SELECT ..." 30000   # 指定超时 ms
//   node yr-example.mjs "SELECT ..." 60000 --csv  # 结果另存 CSV（当前目录）
//
// 多页面时用环境变量指定目标 tab：YEARNING_TAB_ID=123 node yr-example.mjs "..."
// 不指定时使用 popup「Yearning 监听」列表中选中的页面。
//
// 前置：Yearning 页面已开 + popup 已点「📡 监听当前 Yearning 页」；多页面时先选中目标 tab

import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const BRIDGE = process.env.BRIDGE || "ws://127.0.0.1:8787/ssh";
const selectedTabId = process.env.YEARNING_TAB_ID ? Number(process.env.YEARNING_TAB_ID) : undefined;

function yrRun(msg, timeoutMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BRIDGE);
    const reqId = randomBytes(4).toString("hex");
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(r);
    };
    const fallback = setTimeout(
      () => finish({ ok: false, error: "client timeout" }),
      timeoutMs + 5000
    );
    ws.on("open", () => ws.send(JSON.stringify({ type: "yr-run", reqId, tabId: selectedTabId, ...msg })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "result" && m.reqId === reqId) {
        clearTimeout(fallback);
        finish({ ok: !!m.ok, output: m.output, error: m.error, message: m.message, elapsedMs: m.elapsedMs });
      }
    });
    ws.on("error", (err) => { clearTimeout(fallback); finish({ ok: false, error: "ws error: " + err.message }); });
  });
}

// CSV cell 转义：含逗号/引号/换行的值加引号，内部引号翻倍（RFC 4180）
function csvCell(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 结果 JSON（yr-run output）转 CSV 文件。多结果集写多个文件。
function saveResultCsv(jsonText) {
  let obj;
  try { obj = JSON.parse(jsonText); } catch { return; }
  if (!Array.isArray(obj.results)) return;
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

const mode = process.argv[2] || "ping";
const csvExport = process.argv.includes("--csv");

if (mode === "ping") {
  const ws = new WebSocket(BRIDGE);
  ws.on("open", () => ws.send(JSON.stringify({ type: "yr-ping", reqId: randomBytes(4).toString("hex"), tabId: selectedTabId })));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { process.exit(1); }
    if (m.type !== "result") return;
    console.log(m.ok ? "✓ ping ok" : "✗ ping failed");
    console.log(m.output || m.error || "");
    process.exit(m.ok ? 0 : 1);
  });
  ws.on("error", (e) => { console.error("✗", e.message); process.exit(1); });
  setTimeout(() => { console.error("✗ timeout"); process.exit(1); }, 8000);
} else {
  const cliArgs = process.argv.slice(2).filter(a => a !== "--csv");
  const sql = cliArgs[0];
  const timeoutMs = Number(cliArgs[1] || 60000);
  console.log(`→ yr-run${selectedTabId ? ` [tab ${selectedTabId}]` : ""}: ${sql.slice(0, 100)}`);
  const r = await yrRun({ sql, timeoutMs }, timeoutMs);
  if (r.ok) {
    console.log(`✓ ok (${r.elapsedMs}ms)`);
    if (csvExport) saveResultCsv(r.output);
    console.log(r.output);
  } else {
    console.error(`✗ failed: ${r.error}`);
    if (r.message) console.error(r.message);
    if (r.output) console.log(r.output);
    process.exit(1);
  }
}
