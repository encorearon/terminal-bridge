// Agent 调用示例：通过本地代理向 JumpServer 终端发命令并拿回输出。
//
// 用法：
//   node client-example.mjs                       # 默认跑 `uname -a`
//   node client-example.mjs "ls -la /etc"         # 自定义命令
//   node client-example.mjs "find / -name foo" 30000  # 指定超时 30s
//
// 内含两个可复用函数：
//   run(cmd, timeoutMs)              —— 单次执行，返回 {ok, output, error}
//   runWithSudoRetry(cmd, timeoutMs) —— 带 sudo 自动重试：检测到 sudo-required
//                                       时询问用户是否切 root，确认则切 root
//                                       后自动重发原命令。Agent 应优先用这个。

import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const BRIDGE = process.env.BRIDGE || "ws://127.0.0.1:8787/ssh";

/**
 * 向 JumpServer 终端发一条命令，等执行完返回输出。
 * @param {string} cmd - 要执行的 linux 命令
 * @param {number} timeoutMs - 超时（默认 10s）
 * @returns {Promise<{ok: boolean, output?: string, error?: string, suggest?: string, message?: string}>}
 */
function run(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BRIDGE);
    const reqId = randomBytes(4).toString("hex");
    let settled = false;

    // 兜底超时定时器。关键：finish 时必须 clearTimeout——
    // 否则即使结果 100ms 就到了，这个挂着的定时器会让 node 进程
    // 一直活到定时器触发才退出，每次调用墙钟时间恒等于 timeoutMs+5000。
    const fallbackTimer = setTimeout(
      () => finish({ ok: false, error: "client timeout" }),
      timeoutMs + 5000
    );

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      try { ws.close(); } catch {}
      resolve(result);
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "run", reqId, cmd, timeoutMs }));
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "result" && msg.reqId === reqId) {
        finish({
          ok: !!msg.ok,
          output: msg.output,
          error: msg.error,
          suggest: msg.suggest,
          message: msg.message,
          elapsedMs: msg.elapsedMs
        });
      }
    });

    ws.on("error", (err) => finish({ ok: false, error: "ws error: " + err.message }));
  });
}

/**
 * 带sudo 自动重试的执行（Agent 推荐用这个）。
 *
 * 流程：
 *   1. 执行 cmd
 *   2. 如果返回 error === "sudo-required"（检测到 sudo 密码提示）：
 *      - 询问用户是否切 root
 *      - 用户同意 → 执行 "sudo su root" 切换 → 重新执行原 cmd
 *      - 用户拒绝 → 返回原错误
 *   3. 其他情况正常返回
 *
 * @param {string} cmd - 要执行的 linux 命令
 * @param {number} timeoutMs - 超时
 * @param {function} ask - 可选的自定义询问函数，默认用 readline 控制台提问。
 *                         Agent 接入时应传入自己的 AskUserQuestion 逻辑。
 *                         签名: async (message) => boolean
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
async function runWithSudoRetry(cmd, timeoutMs = 10000, ask = defaultAsk) {
  let result = await run(cmd, timeoutMs);

  if (result.error === "sudo-required") {
    const approved = await ask(result.message || "检测到需要 sudo 权限，是否切换到 root 后重试？");
    if (!approved) {
      return { ok: false, error: "user declined sudo", output: "" };
    }
    // 切 root（sudo su root 通常免密，prompt 锚点能正常判定完成）
    console.log("→ 切换到 root: sudo su root");
    const switchResult = await run("sudo su root", timeoutMs);
    if (!switchResult.ok) {
      return { ok: false, error: "sudo su root 失败: " + (switchResult.error || ""), output: switchResult.output || "" };
    }
    // 切成功后重发原命令
    console.log("→ 重新执行原命令");
    result = await run(cmd, timeoutMs);
  }

  return result;
}

// 默认询问函数：控制台 readline 提问
async function defaultAsk(message) {
  const rl = readline.createInterface({ input, output });
  try {
    const ans = await rl.question(`\n⚠ ${message} [y/N] `);
    return ans.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

/**
 * 带 Arthas 安全基线处理的执行（Agent 操作 Arthas 终端时用这个）。
 *
 * 处理代理返回的 guard 错误：
 *   - arthas-forbidden      —— 高风险命令被禁用，告知用户去浏览器手动操作，不重试
 *   - arthas-needs-limit    —— 中风险命令未带频率限制（严格模式），按 suggest 补参数重发一次
 *   - arthas-quota-exceeded —— 中风险命令会话内超限，告知用户，不重试
 *
 * @param {string} cmd - Arthas 命令
 * @param {number} timeoutMs - 超时
 * @param {function} ask - 可选的自定义询问函数（Agent 应传 AskUserQuestion 逻辑）
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
async function runWithArthasGuard(cmd, timeoutMs = 10000, ask = defaultAsk) {
  let currentCmd = cmd;

  // 最多重试 2 次（补参数算一次）
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(currentCmd, timeoutMs);

    if (result.ok) return result;

    // --- 高风险命令被禁用：告知用户，不重试 ---
    if (result.error === "arthas-forbidden") {
      console.error("⚠ " + (result.message || "高风险 Arthas 命令已被禁用"));
      if (result.suggest) console.error("  替代方案: " + result.suggest);
      return result;
    }

    // --- 中风险命令缺频率限制：按建议补参数重发一次 ---
    if (result.error === "arthas-needs-limit") {
      if (result.suggest) {
        console.log("→ 按建议补频率限制: " + result.suggest);
        currentCmd = result.suggest;
        continue;
      }
      return result;
    }

    // --- 会话超限：不重试 ---
    if (result.error === "arthas-quota-exceeded") {
      console.error("⚠ " + (result.message || "中风险命令超限"));
      return result;
    }

    // --- sudo-required：复用 sudo 重试逻辑（Arthas 不会有，但保险） ---
    if (result.error === "sudo-required") {
      return runWithSudoRetry(currentCmd, timeoutMs, ask);
    }

    // 其他错误直接返回
    return result;
  }

  return { ok: false, error: "max retries exceeded", output: "" };
}

// --- CLI ---
const cmd = process.argv[2] || "uname -a";
const timeoutMs = Number(process.argv[3] || 10000);

console.log(`→ run: ${cmd}`);
// 自动判断用哪种 wrapper：Arthas 命令走 guard，其他走 sudo 重试
const { isArthasCommand } = await import("./arthas-guard.js");
const result = isArthasCommand(cmd)
  ? await runWithArthasGuard(cmd, timeoutMs)
  : await runWithSudoRetry(cmd, timeoutMs);
if (result.ok) {
  console.log(`✓ ok (${result.elapsedMs}ms)`);
  console.log(result.output);
} else {
  console.error(`✗ failed: ${result.error || "unknown"}`);
  if (result.output) console.log("--- partial output ---\n" + result.output);
  process.exit(1);
}
