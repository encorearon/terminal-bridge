// JumpServer xterm 桥接代理
//
// 在 Agent 和 Chrome 插件之间做"请求-响应"配对：
//   Agent 发 run{cmd} → 代理把 cmd 包成 `cmd; printf 哨兵\r` → 发给插件
//   插件注入 xterm → 远端 SSH 执行 → koko WS recv 帧 → 代理在帧流里
//   匹配到哨兵 → 截取哨兵前的内容作为这条命令的输出 → 返回给 Agent
//
// 端点：ws://127.0.0.1:8787/ssh
// 两类客户端连这个端点：
//   - 插件 background：上报 ws-recv/ws-send 帧，接收 run-cmd 指令
//   - Agent：发 run 请求，接收 result 响应
//   （它们用同一端点，靠消息 type 区分角色）

import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PID 文件：native host「停止代理」时读取。代理自己在 listening 后写入。
const PID_FILE = fileURLToPath(new URL("./.proxy.pid", import.meta.url));
import {
  auditArthasCommand,
  isArthasCommand,
} from "./arthas-guard.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 10000);
const PROBE_LOG = process.env.PROBE_LOG !== "0"; // 默认开探针日志

const TAG = "[proxy]";

// ===================== 客户端管理 =====================
// 一个端点两类客户端：插件（唯一）和 Agent（多个）。
// 我们不严格区分谁连进来，靠消息 type 路由。
const clients = new Set();        // 所有连进来的 ws
let extensionWs = null;           // 最新一个发过 hello/role:extension 的连接

function broadcast(obj, except = null) {
  const line = JSON.stringify(obj);
  for (const c of clients) {
    if (c === except) continue;
    if (c.readyState !== c.OPEN) continue;
    try { c.send(line); } catch {}
  }
}

function sendToExtension(obj) {
  if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
    try { extensionWs.send(JSON.stringify(obj)); } catch {}
    return true;
  }
  return false;
}

// ===================== WS 监听（tap）通道 =====================
// 非终端页面（Yearning SQL 结果等）没有 xterm/prompt，无法走命令配对。
// Agent 客户端发 {type:"tap-start", urlIncludes:"..."} 注册后，代理把
// URL 匹配的原始 ws-recv 帧以 {type:"tap-frame", ...} 转发给它，由 Agent
// 自行解析协议。与终端命令通道互不影响（终端配对只吃终端特征 URL）。
const tapClients = new Map();  // ws -> { urlIncludes, tabId? }
let activeYearningTabId = null;  // background 选中的 Yearning tab

function broadcastTap(payload) {
  // 内部 Yearning 编排等待者也吃一份（yr-run 等结果帧）
  feedYearningWaiters(payload);
  if (tapClients.size === 0) return;
  const url = (payload && payload.url) || "";
  for (const [client, filter] of tapClients) {
    if (client.readyState !== client.OPEN) continue;
    // url 匹配则转发；url 为空也转发（CDP 在 attach 前建立的连接会错过
    // webSocketCreated，帧拿不到 url——宁可多送让客户端判断，不能静默丢弃）
    if (filter.tabId != null && payload.tabId != null && filter.tabId !== payload.tabId) continue;
    if (url && url.indexOf(filter.urlIncludes) === -1) continue;
    try {
      client.send(JSON.stringify({
        type: "tap-frame",
        tabId: payload.tabId,
        url,
        data: payload.data,
        opcode: payload.opcode,
        t: payload.t
      }));
    } catch {}
  }
}

// ===================== Yearning SQL 自动化编排 =====================
// Agent 发 {type:"yr-run", sql, timeoutMs}：
//   1. yr-cmd sql-set   → 插件把 SQL 注入 Yearning 编辑器（CodeMirror/monaco/DOM）
//   2. yr-cmd query-click → 插件点「查询」按钮
//   3. 等 tap 帧里出现 results != null 的结果帧（msgpack 解码）→ resolve 返回
// 前置条件：用户已在 Yearning 页面点「📡 监听当前页 WS」（tap tab 存在）。
const yrCmdWaiters = new Map();  // reqId -> resolve
const yrRunWaiters = new Set();  // { tryConsume(payload) -> boolean }

function sendYrCmd(sub, sql, tabId) {
  const reqId = genReqId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      yrCmdWaiters.delete(reqId);
      resolve({ ok: false, error: `yr-cmd ${sub} timeout` });
    }, 5000);
    yrCmdWaiters.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    const ok = sendToExtension({ type: "yr-cmd", sub, sql, reqId, tabId });
    if (!ok) {
      yrCmdWaiters.delete(reqId);
      clearTimeout(timer);
      resolve({ ok: false, error: "extension not connected" });
    }
  });
}

// 插件回的 yr-result：唤醒对应的 yr-cmd 等待者
function handleYrResult(msg) {
  const waiter = yrCmdWaiters.get(msg.reqId);
  if (waiter) {
    yrCmdWaiters.delete(msg.reqId);
    waiter({ ok: !!msg.ok, via: msg.via, error: msg.error, info: msg.editor || msg.buttons });
  }
}

// tap 帧喂给 yr-run 等待者：结果帧（msgpack 解码后 results 非空）被消费。
// 没有 yr-run 等待者时（用户在页面上手点「查 询」），同样生成 CSV 导出记录——
// 桥接查询和手动查询的产出统一进 popup 列表。
function feedYearningWaiters(payload) {
  const url = (payload && payload.url) || "";
  if (url && url.indexOf("sql.meiyunji.net") === -1) return;
  const frameTabId = payload && payload.tabId;

  const opcode = payload && payload.opcode;
  const data = payload && payload.data;
  if (opcode !== 2 || typeof data !== "string") return;
  let obj = null;
  try {
    obj = msgpackDecode(Buffer.from(data, "base64"));
  } catch { return; }
  if (!obj || obj.results == null) return;  // 心跳帧忽略

  let consumed = false;
  if (yrRunWaiters.size > 0) {
    for (const waiter of [...yrRunWaiters]) {
      // tabId 双向可识别时严格隔离；帧缺 tabId（attach 前建立的旧 WS 连接，
      // CDP 拿不到 webSocketCreated）时：仅当恰好只有一个 waiter 才兜底消费——
      // 多 waiter 场景宁可不消费走超时，也不能猜错页面串结果。
      if (waiter.tabId != null && payload.tabId != null && waiter.tabId !== payload.tabId) continue;
      if (waiter.tabId != null && payload.tabId == null && yrRunWaiters.size > 1) continue;
      if (waiter.tryConsume(obj)) { consumed = true; break; }
    }
  }

  // 未被 yr-run 消费的结果帧 = 手动查询（或 yr-run 已完成后的重复帧），
  // 也生成 CSV 记录。同一帧 yr-run 路径已经发过 export，不重复。
  if (!consumed) {
    const rows = Array.isArray(obj.results)
      ? obj.results.map(t => (t && t.data ? t.data.length : 0)).reduce((a, b) => a + b, 0)
      : 0;
    sendToExtension({
      type: "yr-export-csv",
      reqId: "manual-" + genReqId(),
      tabId: frameTabId ?? activeYearningTabId,
      sql: "manual-query",
      rows,
      payload: JSON.stringify(obj),
    });
  }
}

async function handleYrRun(ws, msg) {
  const reqId = msg.reqId || genReqId();
  const sql = (msg.sql || "").toString();
  const tabId = msg.tabId != null ? Number(msg.tabId) : activeYearningTabId;
  const timeoutMs = Math.min(Number(msg.timeoutMs || 60000), 300000);
  if (!sql.trim()) {
    ws.send(JSON.stringify({ type: "result", reqId, ok: false, error: "empty sql" }));
    return;
  }

  // 结果帧等待者：收到第一个 results 非空帧即完成
  let settled = false;
  const runEntry = {
    tabId,
    sentAt: Date.now(),
    tryConsume: (obj) => {
      if (settled) return true;
      settled = true;
      yrRunWaiters.delete(runEntry);
      console.log(TAG, `[yr-run ${reqId}] 结果帧到达（query_time=${obj.query_time ?? "?"}）`);
      // 同步发给插件：浏览器侧生成 CSV 落下载（popup 可见、可重新下载）
      sendToExtension({
        type: "yr-export-csv",
        reqId,
        tabId: tabId ?? activeYearningTabId,
        sql: sql.slice(0, 120),
        rows: Array.isArray(obj.results)
          ? obj.results.map(t => (t && t.data ? t.data.length : 0)).reduce((a, b) => a + b, 0)
          : 0,
        payload: JSON.stringify(obj),
      });
      ws.send(JSON.stringify({
        type: "result", reqId, ok: true,
        output: JSON.stringify(obj),
        elapsedMs: Date.now() - runEntry.sentAt,
      }));
      return true;
    },
  };
  yrRunWaiters.add(runEntry);

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    yrRunWaiters.delete(runEntry);
    ws.send(JSON.stringify({
      type: "result", reqId, ok: false, error: "timeout",
      message: "Yearning 查询未在时限内返回结果帧（确认页面已点「监听当前页 WS」且查询能正常执行）",
      elapsedMs: Date.now() - runEntry.sentAt,
    }));
  }, timeoutMs);

  // 1. 注入 SQL
  const setRes = await sendYrCmd("sql-set", sql, tabId);
  if (!setRes.ok) {
    if (!settled) {
      settled = true;
      yrRunWaiters.delete(runEntry);
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: "result", reqId, ok: false, error: "sql-set failed: " + (setRes.error || ""), message: "SQL 注入 Yearning 编辑器失败" }));
    }
    return;
  }
  console.log(TAG, `[yr-run ${reqId}] SQL 已注入（via ${setRes.via}）`);

  // 2. 点「查询」
  const clickRes = await sendYrCmd("query-click", "", tabId);
  if (!clickRes.ok) {
    if (!settled) {
      settled = true;
      yrRunWaiters.delete(runEntry);
      clearTimeout(timer);
      ws.send(JSON.stringify({
        type: "result", reqId, ok: false,
        error: "query-click failed: " + (clickRes.error || ""),
        message: "未找到「查询」按钮；页面按钮: " + JSON.stringify(clickRes.info || []).slice(0, 300),
      }));
    }
    return;
  }
  console.log(TAG, `[yr-run ${reqId}] 已点「查询」（via ${clickRes.via}），等待结果帧...`);
  // 3. 结果帧由 feedYearningWaiters 消费（timer 兜底）
}

// ===================== 请求-响应配对 =====================
// pending: reqId -> { resolve, timer, buffer, cmd, sentAt }
//
// 设计要点：
//  - 同一时刻只让一个 pending 跑（SSH 单会话命令会交错，必须串行）。
//    后来的 run 进入 queue，前一个完成（命中哨兵或超时）后才放行。
//  - 每个 recv 帧追加到当前 pending 的 buffer；buffer 里出现该 reqId 的
//    哨兵时，切出哨兵之前的内容当输出，resolve 掉。
const pending = new Map();
const queue = [];
let running = false;

function genReqId() {
  return randomBytes(4).toString("hex");
}

// Agent 发来的 run 请求
// 支持两种命令下发方式：
//   { cmd: "..." }          —— 明文命令（原有）
//   { cmdB64: "<base64>" }  —— base64 编码命令（多层引号场景的安全传参通道）
//       代理解码后包装成 `echo <b64> | base64 -d | sh` 下发：
//       base64 字符集（A-Za-z0-9+/=）不含引号/空格/元字符，四层引号嵌套
//       （Bash→mjs→SSH→kubectl exec→sh -c）下也不会被任何一层剥离篡改。
function handleRun(ws, msg) {
  const reqId = msg.reqId || genReqId();
  const timeoutMs = Number(msg.timeoutMs || DEFAULT_TIMEOUT_MS);

  let cmd;
  let wrapped = null;  // 实际注入终端的完整文本（base64 通道时为 wrapper 命令）

  if (msg.cmdB64) {
    // base64 通道：解码 → 校验 → 包装
    let decoded;
    try {
      decoded = Buffer.from(String(msg.cmdB64), "base64").toString("utf8");
    } catch {
      ws.send(JSON.stringify({ type: "result", reqId, ok: false, error: "invalid cmdB64" }));
      return;
    }
    if (!decoded.trim()) {
      ws.send(JSON.stringify({ type: "result", reqId, ok: false, error: "empty cmd" }));
      return;
    }
    if (decoded.length > 16 * 1024) {
      ws.send(JSON.stringify({ type: "result", reqId, ok: false, error: "cmd too long (max 16KB after decode)" }));
      return;
    }
    cmd = decoded;
    wrapped = `echo ${Buffer.from(cmd, "utf8").toString("base64")} | base64 -d | sh`;
  } else {
    cmd = (msg.cmd || "").toString();
  }

  if (!cmd) {
    ws.send(JSON.stringify({ type: "result", reqId, ok: false, error: "empty cmd" }));
    return;
  }

  // ====== Arthas 安全基线审计 ======
  // 只对 Arthas 命令做拦截（shell 命令不拦）。拦截结果三种：
  //   allow    —— 放行
  //   transform —— 自动补安全参数后放行（对 Agent 透明）
  //   deny     —— 拒绝（高风险命令无条件禁用；中风险超限或缺参数在严格模式下拒绝）
  let finalCmd = cmd;
  if (isArthasCommand(cmd)) {
    const audit = auditArthasCommand(cmd);

    if (audit.action === "deny") {
      console.warn(TAG, `[guard] 拒绝命令: ${cmd.slice(0, 80)} → ${audit.error}`);
      ws.send(JSON.stringify({
        type: "result",
        reqId,
        ok: false,
        error: audit.error,
        suggest: audit.suggest,
        message: audit.message,
      }));
      return;
    }

    if (audit.action === "transform") {
      // 自动改写：用补了安全参数的命令替换原命令
      console.log(TAG, `[guard] 改写命令: ${cmd.slice(0, 60)} → 补参数 (${audit.reason})`);
      finalCmd = audit.cmd;
    }
  }

  const job = { ws, reqId, cmd: finalCmd, wrapped, timeoutMs, sentAt: Date.now() };
  queue.push(job);
  maybeRunNext();
}

function maybeRunNext() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;

  running = true;

  // ====== prompt 锚点方案 ======
  // kitty 终端逐字符注入会重绘，把任何标记字符串（BEGIN/END/哨兵）打散，
  // 标记方案不可靠。改用 shell prompt 作为命令完成的锚点（expect/pexpect 经典做法）。
  //
  // 典型 shell prompt: [root@host /path]# 或 [user@host ~]$
  // 关键：prompt 是服务端 shell 在命令完成后输出的，不受 kitty 输入重绘影响。
  //
  // 流程：
  //   1. 发 cmd + \r（base64 通道时发 `echo <b64> | base64 -d | sh` + \r）
  //   2. 在 ws-recv 流里累积，找 prompt 正则匹配（]\s*[#$]\s*$ 在行尾）
  //   3. 第一次匹配到 prompt：说明之前的 buffer 含"上一条命令的尾部 prompt + cmd 回显"，
  //      从这个 prompt 之后开始才是本命令的输出区域
  //   4. 第二次匹配到 prompt：命令执行完毕，两个 prompt 之间就是输出
  // 注：wrapped 优先用 handleRun 传入的 base64 wrapper（此时终端回显的是 wrapper
  // 命令而非原始 cmd，回显清理必须按 wrapper 比对才能删掉）。
  const wrapped = `${job.wrapped != null ? job.wrapped : job.cmd}\r`;

  // 状态机：
  //   phase 0 (wait_prompt_1) : 等 prompt 第 1 次出现（命令回显前的 prompt）
  //   phase 1 (wait_prompt_2) : 等 prompt 第 2 次出现（命令完成后的 prompt）
  const entry = {
    resolve: (result) => {
      if (pending.has(job.reqId)) {
        clearTimeout(entry.timer);
        if (entry.weakTimer != null) { clearTimeout(entry.weakTimer); entry.weakTimer = null; }
        if (entry.ps2Timer != null) { clearTimeout(entry.ps2Timer); entry.ps2Timer = null; }
        pending.delete(job.reqId);
        try {
          job.ws.send(JSON.stringify({ type: "result", reqId: job.reqId, ...result }));
        } catch {}
      }
      running = false;
      setImmediate(maybeRunNext);
    },
    timer: null,
    phase: 0,
    buffer: "",
    cmd: job.cmd,
    // 回显清理用的比对串：base64 通道下终端实际回显的是 wrapper 命令
    echoCmd: job.wrapped != null ? job.wrapped : job.cmd,
    promptCount: 0
  };
  pending.set(job.reqId, entry);
  entry.sentAt = job.sentAt;

  // 超时：resolve 失败 + 发 Ctrl+C 复位终端
  entry.timer = setTimeout(() => {
    console.warn(TAG, `run [${job.reqId}] timeout (phase=${entry.phase}), sending Ctrl+C to reset terminal`);
    sendCtrlC();
    entry.resolve({
      ok: false,
      error: "timeout",
      output: finalizeOutput(entry),
      elapsedMs: Date.now() - job.sentAt
    });
  }, job.timeoutMs);

  const ok = sendToExtension({ type: "run-cmd", text: wrapped, reqId: job.reqId });
  if (!ok) {
    entry.resolve({ ok: false, error: "extension not connected" });
  } else {
    console.log(TAG, `run [${job.reqId}] dispatched: ${job.cmd.slice(0, 80)}`);
  }
}

// 发 Ctrl+C 复位终端（超时/交互卡死时调用）
function sendCtrlC() {
  const ok = sendToExtension({ type: "run-cmd", text: "\x03", reqId: "__ctrlc__" });
  if (!ok) console.warn(TAG, "Ctrl+C 发送失败：插件未连接");
}

// ===================== 终端类型感知 =====================
// 截断根因：原来用单一 PROMPT_RE = /\]\s*[#$]\s*$|>\s*$/，其中 >\s*$ 太宽——
// JumpServer 输出里只要某行以 > 结尾（JSON 片段、shell 重定向、日志）就会被误判成
// Arthas prompt，导致代理提前认为命令结束、resolve 返回，后面的输出全丢。
//
// 根治：自动探测终端类型，按类型选 prompt 正则。
//   - jumpserver (koko/SSH): prompt = [user@host dir]# 或 ]$，只认 ]\s*[#$]\s*$
//   - arthas: prompt = arthas@pid>，只认 arthas@\S+>\s*$
//   - unknown（探测未出结果前）: 用宽松兜底，保持向后兼容
//
// 探测依据：koko 和 Arthas 的 prompt 特征泾渭分明。
// 每条 ws-recv 帧喂给 detectTerminalType()，命中特征即锁定类型（一旦锁定不再改）。

let terminalType = "unknown";  // "unknown" | "jumpserver" | "arthas"

// 各类型的 prompt 正则
const PROMPT_RE_BY_TYPE = {
  // JumpServer shell prompt（强匹配）：[user@host /dir]# 或 ]$
  // 注意：不匹配裸 >，避免输出内容里的 > 行误触发
  jumpserver: /\]\s*[#$]\s*$/,
  // Arthas prompt：arthas@pid>（带 arthas@ 前缀，不匹配裸 >）
  arthas: /arthas@\S+>\s*$/,
  // 未知类型：宽松兜底（探测完成前的窗口期，行为同旧版）
  unknown: /\]\s*[#$]\s*$|>\s*$/,
};

// 弱 prompt（无方括号的 bash 默认 PS1）：user@host:~/path$ 或 root@host:~#
// Ubuntu/Debian 系资产的 PS1 没有方括号，强正则永远不匹配 → 全部超时。
// 弱匹配特征：行尾是 $ 或 #，且行内含 user@host: 或 ~/ 特征。
// 防误判（输出行恰好以 #/$ 结尾）：不立即判定，等 WEAK_QUIET_MS 无新数据才确认。
const WEAK_PROMPT_LINE_RE = /[$#]$/;
const WEAK_PROMPT_CONTEXT_RE = /@[\w.-]+:|~\//;
const WEAK_QUIET_MS = 350;

// 旧名保留（cleanOutput 等处仍引用），指向宽松兜底，仅用于"删 prompt 行"的清理逻辑
const PROMPT_RE = PROMPT_RE_BY_TYPE.unknown;

// ANSI 清理（CSI + OSC），prompt 匹配统一在清理后的文本上做
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

// 取 ANSI 清理后文本的最后一个非空行（去尾部空白），prompt 判定用
function lastNonEmptyLine(s) {
  const lines = stripAnsi(s).split("\n").map(l => l.replace(/\s+$/, ""));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) return lines[i];
  }
  return "";
}

// 探测终端类型：扫描 ANSI 清理后的文本，按 prompt 特征判定
// 支持切换：如果已锁定类型 A，但检测到明确的类型 B 特征，则切换到 B
// （用户在 popup 切 tab 从 Arthas 切到 JumpServer 时，代理靠这条路径纠正）
function detectTerminalType(text) {
  const clean = stripAnsi(text);

  // Arthas prompt 特征：arthas@<pid>> （出现在任意行尾）
  if (/arthas@\S+>\s*$/m.test(clean)) {
    if (terminalType !== "arthas") {
      terminalType = "arthas";
      console.log(TAG, "[probe] 终端类型切换 → arthas（检测到 arthas@pid> prompt）");
    }
    return;
  }

  // JumpServer shell prompt 特征（红帽系）：[user@host /dir]# 或 ]$
  if (/\[[^\]\n]+@[^\]\n]+\][^\n]*[#$]\s*$/m.test(clean)) {
    if (terminalType !== "jumpserver") {
      terminalType = "jumpserver";
      console.log(TAG, "[probe] 终端类型切换 → jumpserver（检测到 [user@host]# prompt）");
    }
    return;
  }

  // JumpServer shell prompt 特征（Ubuntu/Debian 默认 PS1，无方括号）：
  //   user@host:~/path$  或  root@host:~#
  if (/[\w.-]+@[\w.-]+:\S*[$#]\s*$/m.test(clean)) {
    if (terminalType !== "jumpserver") {
      terminalType = "jumpserver";
      console.log(TAG, "[probe] 终端类型切换 → jumpserver（检测到 user@host:path$ prompt，无方括号）");
    }
    return;
  }
  // 未命中任一特征，保持当前类型不变
}

// 插件上报的 ws-recv 帧
function handleWsRecv(payload) {
  const data = payload && payload.data;
  const opcode = payload && payload.opcode;

  // ---------- 探针日志 ----------
  // 第一次见到 recv 帧时，把原始数据形态打到日志，便于判断 koko 走文本还是二进制
  if (PROBE_LOG && !probeSeen) {
    probeSeen = true;
    probeLog(data, opcode);
  }

  if (data == null || data === "") return;

  // 关键：opcode=2（二进制帧）时，CDP 返回的 payloadData 是 base64 字符串，
  // 解码后才是真实的终端明文（koko 走二进制帧，但 payload 是普通 SSH PTY 文本）。
  // opcode=1（文本帧）时 data 本身就是明文。
  // 探针实测：koko 是 opcode=2，base64 解码后能看到 echo 回显、ANSI、哨兵等明文。
  let text;
  if (opcode === 2 && typeof data === "string") {
    try {
      text = Buffer.from(data, "base64").toString("utf8");
    } catch {
      text = data; // 解码失败兜底，至少能匹配 base64 形式的哨兵（几乎不会发生）
    }
  } else {
    text = typeof data === "string" ? data : String(data);
  }

  // 给当前 pending（同时只会有一个）喂帧，按 prompt 锚点状态机处理
  for (const [reqId, entry] of pending) {
    entry.buffer += text;

    // 终端类型探测：每帧喂一次，一旦锁定就不再改
    // 在 prompt 匹配之前做，确保本帧用到的正则已是正确类型
    detectTerminalType(text);

    // 按探测到的终端类型选 prompt 正则（截断根治的核心）
    const activePromptRE = PROMPT_RE_BY_TYPE[terminalType];

    // 在 ANSI 清理后的文本上找 prompt。注意：kitty 可能逐字符推送，
    // prompt 可能跨多个 ws-recv 帧才完整，所以每次都重新扫整个 buffer 尾部。
    // 为了避免重复计数同一个 prompt，记录上次扫描的长度。
    if (entry.lastScanLen === undefined) entry.lastScanLen = 0;
    if (entry.buffer.length <= entry.lastScanLen) continue;

    // 只扫描新增部分 + 一点重叠（prompt 可能跨帧，重叠 64 字符足够覆盖一个 prompt）
    const scanFrom = Math.max(0, entry.lastScanLen - 64);
    const newPart = entry.buffer.slice(scanFrom);

    // ANSI 清理后判断行尾是否是 prompt
    // 用"找换行后的 prompt 模式"：prompt 总是出现在某行行尾
    const cleanNew = newPart
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");

    // 找所有以 ]# 或 ]$ 结尾的位置（prompt）
    // cleanNew 是新片段，它的行尾可能是 prompt
    // 但更可靠：检查清理后整个 buffer 的尾部
    const cleanFull = entry.buffer
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");

    // ====== sudo 密码提示实时检测（优先于 prompt 检测）======
    // 一旦发现 [sudo] password for / Sorry, try again / [sudo] password for root
    // 立即失败 + Ctrl+C 复位，返回特殊错误让 Agent 询问用户是否切 root。
    // 不等超时——sudo 提示是交互式的，等 10s 没意义。
    const sudoPatterns = [
      /\[sudo\] password for /,
      /Sorry, try again\./,
      /sudo: /,
    ];
    const sudoHit = sudoPatterns.some(re => re.test(cleanFull));
    if (sudoHit) {
      console.warn(TAG, `[DEBUG ${reqId}] sudo prompt detected, auto Ctrl+C + return sudo-required`);
      sendCtrlC();
      entry.resolve({
        ok: false,
        error: "sudo-required",
        suggest: "sudo su root",
        message: "命令触发了 sudo 密码提示（可能是 alias 劫持）。是否切换到 root 后重试？",
        elapsedMs: Date.now() - entry.sentAt
      });
      continue;  // 已 resolve，跳过后续 prompt 检测
    }

    // ====== PS2 续行快速失败（问题 3，必须在 prompt 匹配之前）======
    // 多层引号在某层被剥离/篡改后，远端 shell 因引号未闭合进入续行等待，
    // 终端显示行首孤立的 >（PS2 提示符）。此时 prompt 锚点永远不会命中 →
    // 死等超时。检测到孤立 > 且 400ms 无新数据时立即失败并 Ctrl+C 退出续行
    // （终端回到正常 prompt，可继续执行后续命令），返回明确的错误类型。
    // 顺序关键：unknown 类型的宽松兜底正则含裸 >，PS2 的 > 若先落到那里
    // 会被误判成"命令完成"（实测：ok + 空输出），所以 PS2 必须先检查。
    if (entry.phase === 0 && /^\s*>$/.test(lastNonEmptyLine(entry.buffer))) {
      if (entry.ps2Timer == null) {
        const ps2SnapLen = entry.buffer.length;
        entry.ps2Timer = setTimeout(() => {
          entry.ps2Timer = null;
          if (!pending.has(reqId) || entry.buffer.length !== ps2SnapLen) return;
          if (!/^\s*>$/.test(lastNonEmptyLine(entry.buffer))) return;
          console.warn(TAG, `[${reqId}] PS2 续行命中（未闭合引号），快速失败 + Ctrl+C 退出续行`);
          sendCtrlC();
          entry.resolve({
            ok: false,
            error: "unterminated-quote",
            message: "命令疑似包含未闭合的引号/括号，远端 shell 进入续行等待（PS2 >）。已自动 Ctrl+C 退出续行。多层引号场景请改用 base64 通道下发命令。",
            suggest: "用 client 的 --b64 参数（或 run 帧的 cmdB64 字段）下发，规避多层引号剥离",
            output: finalizeOutput(entry),
            elapsedMs: Date.now() - entry.sentAt
          });
        }, 400);
      }
      // PS2 等待期间不做 prompt 匹配（下一帧数据到达会重新进入本循环）
      continue;
    }
    if (entry.ps2Timer != null) {
      clearTimeout(entry.ps2Timer);
      entry.ps2Timer = null;
    }

    // 检查清理后 buffer 的尾部是否以 prompt 结尾
    // 用按终端类型选出的正则（截断根治：jumpserver 不再被裸 > 误触发）
    const tail = cleanFull.slice(-200);
    const promptMatch = tail.match(activePromptRE);
    if (promptMatch) {
      entry.promptCount = (entry.promptCount || 0) + 1;
      entry.lastScanLen = entry.buffer.length;

      if (entry.phase === 0) {
        // 注：终端在我们注入命令前就已经处于 prompt 状态，但那个 prompt 字节
        // 早已流过（attach 之前）。我们注入 cmd 后，第一个出现的 prompt 就是
        // 命令完成后的 prompt。所以只需等 1 个 prompt。
        // buffer 里 = kitty 重绘碎片 + cmd 回显 + 真实输出 + 最终 prompt
        // 切掉末尾 prompt，前面的内容交给清理器（finalizeOutput 含空兜底）
        const output = finalizeOutput(entry);
        entry.resolve({
          ok: true,
          output,
          elapsedMs: Date.now() - entry.sentAt
        });
      }
    } else if (entry.phase === 0 && (terminalType === "jumpserver" || terminalType === "unknown")) {
      // ====== 弱 prompt 兜底（Ubuntu/Debian 默认 PS1 无方括号）======
      // 强正则要求 ] 前缀；user@host:~/path$ 这种 prompt 永远匹配不上 → 全部超时。
      // 弱匹配：最后一个非空行以 $/# 结尾且行内含 @ 或 : 特征。
      // 防误判：不立即判定，等 WEAK_QUIET_MS 无新数据再确认
      // （输出行恰好以 #/$ 结尾时，后续输出到达会取消定时器）。
      const lastLine = lastNonEmptyLine(entry.buffer);
      const weakHit = WEAK_PROMPT_LINE_RE.test(lastLine) && WEAK_PROMPT_CONTEXT_RE.test(lastLine);
      if (weakHit) {
        if (entry.weakTimer == null) {
          const snapLen = entry.buffer.length;
          entry.weakTimer = setTimeout(() => {
            entry.weakTimer = null;
            if (!pending.has(reqId) || entry.buffer.length !== snapLen) return;
            const lineNow = lastNonEmptyLine(entry.buffer);
            if (WEAK_PROMPT_LINE_RE.test(lineNow) && WEAK_PROMPT_CONTEXT_RE.test(lineNow)) {
              console.log(TAG, `[${reqId}] 弱 prompt 确认完成（${WEAK_QUIET_MS}ms 静默）: ${lineNow.slice(-60)}`);
              entry.lastScanLen = entry.buffer.length;
              entry.resolve({
                ok: true,
                output: finalizeOutput(entry),
                elapsedMs: Date.now() - entry.sentAt
              });
            }
          }, WEAK_QUIET_MS);
        }
      } else if (entry.weakTimer != null) {
        // 新数据不再是弱 prompt 形态，取消待确认的判定
        clearTimeout(entry.weakTimer);
        entry.weakTimer = null;
      }
    }
  }
}

// ===================== 探针 =====================
let probeSeen = false;
function probeLog(data, opcode) {
  console.log("=".repeat(60));
  console.log(TAG, "[PROBE] 首个 ws-recv 帧已到达");
  console.log(TAG, `[PROBE] opcode = ${opcode} (${opcode === 2 ? "二进制帧" : opcode === 1 ? "文本帧" : "其他"})`);
  console.log(TAG, `[PROBE] 原始 payloadData（前 120 字符）: ${JSON.stringify(typeof data === "string" ? data.slice(0, 120) : String(data))}`);

  // 对二进制帧展示 base64 解码后的内容
  if (opcode === 2 && typeof data === "string") {
    try {
      const decoded = Buffer.from(data, "base64").toString("utf8");
      const sample = decoded.slice(0, 200);
      const looksText = /^[\x09\x0a\x0d\x1b\x20-\x7e]*$/.test(sample);
      console.log(TAG, `[PROBE] base64 解码后（前 200 字符）: ${JSON.stringify(sample)}`);
      console.log(TAG, `[PROBE] 解码后是否可打印 ASCII（含 ANSI）: ${looksText}`);
      console.log(TAG, looksText
        ? "[PROBE] 结论：二进制帧，但 payload 是明文终端流（已自动解码）"
        : "[PROBE] 结论：真正的二进制协议，需要专门的解析器");
    } catch (e) {
      console.log(TAG, "[PROBE] base64 解码失败:", e.message);
    }
  }
  console.log("=".repeat(60));
}

// ===================== 输出清理 =====================
// prompt 锚点方案：buffer = kitty 重绘碎片 + cmd 回显 + 真实输出 + 最终 prompt
// 清理策略（收紧：只删确定属于终端噪音的内容，其余原样保留）：
//   1. 去 ANSI（颜色、OSC 标题）
//   2. 控制字符替换为空格（NUL/x00 等，/proc/*/cmdline 场景；绝不因含控制字符丢整段）
//   3. 删 prompt 行（要求 prompt 出现在行首附近，且 #$ 紧跟 prompt——
//      旧行为 "]/…任意内容…/#$" 会把含 ] 和 $ 的长 JSON 输出整行误删，即问题 1 根因）
//   4. 删 koko 控制消息行
//   5. 删命令回显行（折行感知：终端宽度折行会把长命令拆成多行，先做软换行 join 再比对）
function cleanOutput(text, cmd) {
  if (!text) return "";
  let out = text
    // ANSI CSI 序列：ESC [ ... 字母（颜色、光标移动、清行等）
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // ANSI OSC 序列：ESC ] ... BEL 或 ESC \（标题设置等）
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // 控制字符 → 空格：NUL 等 C0 控制符（保留 \t\n\r，它们在下一步处理）。
    // /proc/*/cmdline、environ 都是 NUL 分隔，替换而非丢弃（问题 2）
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
    // \r\n 和孤立 \r → \n
    .replace(/\r\n?/g, "\n");

  // 删除 prompt 行（命令回显行 = prompt + 命令文本，可能粘有 kitty 重绘碎片）：
  //   - 红帽系：[user@host /cwd]# —— user/host 段各限长 64（真实 prompt 远短于此）。
  //     不限长时的实测反例（Case A）：head -c 600 截断的 JSON 无闭合 ]，
  //     "data":[ 的 [ 落在前缀窗口内，[^\]]+ 跨过整段 JSON 匹配到 prompt 的 @…]
  //     → 647 字符合并行整行被误删。长度约束让这种跨吞匹配失败。
  //   - Ubuntu/Debian：user@host:~/path$ —— 同样限长
  //   - Arthas：行尾 > 且行短（≤60 字符）
  // 前缀窗口 40 字符：正常 prompt 行 prompt 就在行首；碎片通常几到几十字符。
  out = out.split("\n").filter(line => {
    if (/^.{0,40}\[[^\]\n]{1,64}@[^\]\n]{1,64}\]\s*[#$]/.test(line)) return false;
    if (/^.{0,40}[\w.-]{1,64}@[\w.-]{1,64}:[^\s]{0,128}[$#]/.test(line)) return false;
    // Arthas / 通用 REPL prompt：行尾 > （允许前面有 arthas@xxx 等前缀）
    if (/>\s*$/.test(line) && line.trim().length <= 60) return false;
    return true;
  }).join("\n");

  // 行尾 prompt 后缀剥离：无尾换行的输出（head -c N 截断）会与后续 prompt
  // 合并成同一物理行。上面的整行过滤（带前缀窗口）会放过这种合并行——内容
  // 保住了，但 prompt 碎片粘在输出尾巴上（如 JSON 尾 + [root@host dir]#），
  // 污染 Agent 的后续解析。这里只剥离行尾的 prompt 形态后缀，内容原样保留。
  out = out.split("\n").map(line => {
    if (line.length <= 100) return line;  // 短行已由整行过滤处理，避免误伤
    return line
      .replace(/\[[^\]\n]{1,64}@[^\]\n]{1,64}\]\s*[#$]\s*$/, "")   // 红帽系后缀
      .replace(/[\w.-]{1,64}@[\w.-]{1,64}:[^\s]{0,128}[$#]\s*$/, ""); // Ubuntu 后缀
  }).join("\n");

  // 删除 koko 控制消息：koko 偶尔在终端流里发送 JSON 控制消息
  // （TERMINAL_RESIZE、PING 等），特征是以 {"id": 开头的 JSON 行（可能前面带 # ）
  out = out.split("\n").filter(line => {
    const t = line.trim();
    if (/^#?\s*\{"id":/.test(t) && /"type":/.test(t)) return false;
    return true;
  }).join("\n");

  // 删除命令回显行：整行（去空白后）等于 cmd 的行。
  // 折行感知（问题 4）：长命令在终端宽度处折行会拆开 token（--com\nmand=），
  // 单行比对失败 → 残留回显碎片。这里允许把连续 1-4 行 join 后再与 cmd 比对，
  // 匹配则整组删除。只做"合并后完全相等"的精确匹配，不做子串匹配（防误删真实输出）。
  if (cmd && cmd.trim()) {
    const cmdNoWs = cmd.replace(/\s+/g, "");
    const lines = out.split("\n");
    const kept = [];
    let i = 0;
    while (i < lines.length) {
      let matched = false;
      let joinedNoWs = "";
      for (let k = 0; i + k < lines.length; k++) {
        joinedNoWs += lines[i + k].replace(/\s+/g, "");
        if (joinedNoWs.length > cmdNoWs.length) break;
        if (joinedNoWs === cmdNoWs) {
          i += k + 1;
          matched = true;
          break;
        }
      }
      if (!matched) {
        kept.push(lines[i]);
        i++;
      }
    }
    out = kept.join("\n");
  }

  return out
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ===================== 输出兜底（问题 1 的安全网）=====================
// 两层防御：
//   1. 清理后为空 + 原始内容 ≥512 字符 → 返回截断原始内容 + warning
//   2. 清理损失率 >80%（原始 ≥512 字符但清理后 <20%）→ 保留清理结果，
//      但附加 warning + 原始内容截断——任何未来的 filter 误杀都不再静默
// （Case A 教训：REDHAT 正则曾跨吞 647 字节合并行，靠这层兜底可暴露）
const RAW_FALLBACK_THRESHOLD = 512;   // 原始内容低于此值视为真无输出
const RAW_FALLBACK_LIMIT = 4000;      // 兜底输出截断长度

function finalizeOutput(entry) {
  const echoCmd = entry.echoCmd != null ? entry.echoCmd : entry.cmd;
  const cleaned = cleanOutput(entry.buffer, echoCmd);

  const raw = stripAnsi(entry.buffer)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (raw.length < RAW_FALLBACK_THRESHOLD) return cleaned;

  const truncated = raw.length > RAW_FALLBACK_LIMIT
    ? raw.slice(0, RAW_FALLBACK_LIMIT) + "\n...[truncated]"
    : raw;

  if (cleaned.length === 0) {
    return truncated + `\n[warning] output filtered to empty by cleaner; raw ${raw.length} chars shown]`;
  }
  if (cleaned.length < raw.length * 0.2) {
    return cleaned + `\n[warning] cleaner dropped ${(100 - Math.round(cleaned.length / raw.length * 100))}% of output; raw tail:\n${truncated}`;
  }
  return cleaned;
}

// ===================== WebSocket 服务 =====================
const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("connection", (ws, req) => {
  const url = req.url || "/ssh";
  if (!url.startsWith("/ssh")) {
    // 本代理只暴露 /ssh 端点，其他路径直接关
    ws.close(4000, "unknown endpoint");
    return;
  }

  clients.add(ws);
  console.log(TAG, `client connected (total=${clients.size}) url=${url}`);

  ws.on("message", (raw) => {
    const text = raw.toString("utf8").trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch {
      console.error(TAG, "无法解析:", text.slice(0, 200));
      return;
    }

    // --- 插件 hello ---
    if (msg.type === "hello") {
      if (msg.payload && msg.payload.role === "extension") {
        extensionWs = ws;
        console.log(TAG, "extension 已连接");
      }
      ws.send(JSON.stringify({ type: "hello-ack", payload: { ok: true } }));
      return;
    }

    // --- Agent 发来的 run 请求 ---
    if (msg.type === "run") {
      handleRun(ws, msg);
      return;
    }

    // --- Agent 发来的 Yearning SQL 查询（注入编辑器 + 点查询 + 收 WS 结果）---
    if (msg.type === "yr-run") {
      handleYrRun(ws, msg);
      return;
    }
    if (msg.type === "yr-result") {
      handleYrResult(msg);
      return;
    }
    if (msg.type === "yr-active-tab") {
      activeYearningTabId = msg.tabId != null ? Number(msg.tabId) : null;
      console.log(TAG, `[yr] active tab = ${activeYearningTabId}`);
      return;
    }
    if (msg.type === "yr-ping") {
      // 探测：编辑器类型 + 查询按钮（不执行任何操作）
      sendYrCmd("ping", "", msg.tabId != null ? Number(msg.tabId) : activeYearningTabId).then(r => {
        ws.send(JSON.stringify({ type: "result", reqId: msg.reqId || "", ok: r.ok, output: JSON.stringify({ via: r.via, error: r.error, info: r.info }, null, 1) }));
      });
      return;
    }
    if (msg.type === "yr-set") {
      // 只注入 SQL 不点查询（用户手动点，配合 tap 探针收结果）
      sendYrCmd("sql-set", msg.sql || "", msg.tabId != null ? Number(msg.tabId) : activeYearningTabId).then(r => {
        ws.send(JSON.stringify({ type: "result", reqId: msg.reqId || "", ok: r.ok, output: JSON.stringify({ via: r.via, error: r.error }) }));
      });
      return;
    }

    // --- Agent 发来的 WS 监听（tap）请求：非终端页面（Yearning 等）的帧流 ---
    if (msg.type === "tap-start") {
      const urlIncludes = (msg.urlIncludes || "").toString();
      if (!urlIncludes) {
        ws.send(JSON.stringify({ type: "tap-error", error: "missing urlIncludes" }));
        return;
      }
      const tapTabId = msg.tabId != null ? Number(msg.tabId) : null;
      tapClients.set(ws, { urlIncludes, tabId: tapTabId });
      console.log(TAG, `tap client 已注册 (urlIncludes=${urlIncludes}, tabId=${tapTabId}, total=${tapClients.size})`);
      ws.send(JSON.stringify({ type: "tap-started", urlIncludes }));
      return;
    }
    if (msg.type === "tap-stop") {
      tapClients.delete(ws);
      console.log(TAG, `tap client 已注销 (total=${tapClients.size})`);
      ws.send(JSON.stringify({ type: "tap-stopped" }));
      return;
    }

    // --- 插件上报的 WS 帧 ---
    if (msg.type === "ws-recv") {
      // 先喂 tap 通道（按 URL 过滤转发原始帧），再喂终端配对。
      // 终端配对只吃终端特征的 URL（koko / arthas / 空 = 旧插件不带 url），
      // 防止 tap 页面（Yearning JSON 帧）污染终端命令的输出配对。
      broadcastTap(msg.payload);
      const frameUrl = (msg.payload && msg.payload.url) || "";
      const isTerminalUrl = !frameUrl || /\/koko\/ws|connectArthas/i.test(frameUrl);
      if (isTerminalUrl) handleWsRecv(msg.payload);
      return;
    }
    if (msg.type === "ws-send") {
      // 调试用，暂不处理（命令是我们自己注入的，不用回放）
      return;
    }
    if (msg.type === "ws-open") {
      console.log(TAG, "koko WS 连接已建立:", msg.payload && msg.payload.url);
      return;
    }
    if (msg.type === "inject-failed") {
      console.error(TAG, "插件注入失败:", msg.payload);
      // 把对应 pending 失败掉
      const reqId = msg.payload && msg.payload.reqId;
      if (reqId && pending.has(reqId)) {
        pending.get(reqId).resolve({
          ok: false,
          error: msg.payload.error || "inject failed"
        });
      }
      return;
    }

    // 未知消息：忽略（避免 ping/pong 等噪音刷屏）
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (tapClients.delete(ws)) {
      console.log(TAG, `tap client 已断开 (total=${tapClients.size})`);
    }
    if (ws === extensionWs) {
      extensionWs = null;
      console.log(TAG, "extension 已断开");
      // 失败所有 pending（没有插件就没法拿输出了）
      for (const [, entry] of pending) {
        entry.resolve({ ok: false, error: "extension disconnected" });
      }
    } else {
      console.log(TAG, `client disconnected (total=${clients.size})`);
    }
  });

  ws.on("error", (err) => console.error(TAG, "ws error:", err.message));
});

wss.on("listening", () => {
  const { address, port } = wss.address();
  console.log(TAG, `监听 ws://${address}:${port}/ssh`);
  console.log(TAG, "等待插件连接（role: extension）和 Agent 连接（发 run 请求）");

  // 写 PID 文件：native host 的「停止代理」靠它找到本进程。
  // 由代理自己写（而不是 host 代写）保证准确性——手动 node server.js
  // 启动时也有 PID 文件可停。进程自己写自己的 process.pid，无注入面。
  try {
    writeFileSync(PID_FILE, String(process.pid));
    console.log(TAG, `PID ${process.pid} → ${PID_FILE}`);
  } catch {}
});

function shutdown() {
  console.error(TAG, "shutting down");
  try { unlinkSync(PID_FILE); } catch {}
  wss.clients.forEach((c) => c.close(1001, "shutting down"));
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
  }
  setTimeout(() => process.exit(0), 100);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
