#!/usr/bin/env node
// Terminal Bridge Native Messaging Host
//
// Chrome 通过 native messaging 和这个脚本通信（stdin/stdout，4 字节小端长度前缀）。
// 职责：接收插件命令，启动/停止/查询 proxy/server.js。
//
// 关键设计：proxy 是独立的守护进程，不跟随 host 退出。
//   - start: 用 detached + unref 启动 proxy，PID 写到 PID 文件，立即返回
//   - stop:  读 PID 文件，发 SIGTERM
//   - status: 检查端口是否在监听 + PID 文件是否存在
// host 进程本身是短命的（每次命令一个连接），proxy 持久运行。

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");

const NODE_BIN = process.execPath;
const PROXY_DIR = path.resolve(__dirname, "..", "proxy");
const PROXY_SCRIPT = path.join(PROXY_DIR, "server.js");
const PROXY_PORT = Number(process.env.JTB_PORT || 8787);
const PID_FILE = path.join(PROXY_DIR, ".proxy.pid");
const LOG_FILE = path.join(PROXY_DIR, ".proxy.log");

// ============== Native messaging I/O ==============
function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function readMessages(onMessage) {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8"));
      buf = buf.slice(4 + len);
      onMessage(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// ============== 工具函数 ==============
function isProxyListening() {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(800);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(PROXY_PORT, "127.0.0.1");
  });
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    if (!/^\d{1,10}$/.test(raw)) return null;  // 纯数字白名单
    const pid = Number(raw);
    return pid > 0 ? pid : null;
  } catch { return null; }
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);  // 信号 0 = 探活，不发实际信号
    return true;
  } catch { return false; }
}

// ============== 命令处理 ==============
async function startProxy() {
  // 已在运行？
  if (await isProxyListening()) {
    return { ok: true, status: "running", msg: "proxy already running", port: PROXY_PORT };
  }

  // 清理失效的 PID 文件
  const oldPid = readPid();
  if (oldPid && !isPidAlive(oldPid)) clearPid();

  // 打开日志文件（append 模式），proxy 的 stdout/stderr 都写进去
  const logFd = fs.openSync(LOG_FILE, "a");

  try {
    const child = spawn(NODE_BIN, [PROXY_SCRIPT], {
      cwd: PROXY_DIR,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PORT: String(PROXY_PORT) },
      detached: true,   // 关键：脱离父进程，变成独立进程组
    });
    // unref 让父进程（host）可以不等子进程就退出
    child.unref();
    // 先落一份 spawn 返回的数字 PID（非外部输入）；代理 listening 后会自写权威值
    try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch {}
    fs.writeFileSync(logFd, `\n[host] proxy started PID=${child.pid} at ${new Date().toISOString()}\n`);

    // 等一小段时间确认端口起来
    await new Promise(r => setTimeout(r, 800));
    const up = await isProxyListening();
    if (up) {
      return { ok: true, status: "running", msg: "proxy started", port: PROXY_PORT };
    } else {
      return { ok: true, status: "running", msg: "proxy process started (port not ready yet)", port: PROXY_PORT };
    }
  } catch (err) {
    return { ok: false, status: "stopped", msg: "start error: " + err.message };
  }
}

function stopProxy() {
  return new Promise(async (resolve) => {
    const pid = readPid();
    if (!pid) {
      // 没有PID 文件。代理启动时会自己写 PID（server.js listening 后落盘），
      // 走到这里说明代理未通过正常途径启动——用端口状态兜底判断。
      const up = await isProxyListening();
      resolve(up
        ? { ok: false, status: "running", msg: "无法停止：PID 文件缺失，请手动停止占用 8787 端口的进程" }
        : { ok: true, status: "stopped", msg: "proxy was not running" });
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      // 等 2s 确认退出（Windows 上 SIGTERM 即强制终止）
      setTimeout(async () => {
        if (isPidAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
        clearPid();
        const stillUp = await isProxyListening();
        resolve({
          ok: !stillUp,
          status: stillUp ? "running" : "stopped",
          msg: stillUp
            ? "已发停止信号但端口仍被占用，可能有其他进程"
            : "proxy stopped",
        });
      }, 2000);
    } catch (err) {
      clearPid();
      resolve({ ok: true, status: "stopped", msg: "proxy was not running (stale pid)" });
    }
  });
}

async function status() {
  const up = await isProxyListening();
  return { ok: true, status: up ? "running" : "stopped", port: PROXY_PORT };
}

// ============== 主循环 ==============
readMessages(async (msg) => {
  const cmd = msg && msg.cmd;
  if (cmd === "start") {
    sendMessage(await startProxy());
  } else if (cmd === "stop") {
    sendMessage(await stopProxy());
  } else if (cmd === "status") {
    sendMessage(await status());
  } else {
    sendMessage({ ok: false, msg: "unknown cmd: " + cmd });
  }
});

process.stderr.write("[host] native messaging host ready\n");
