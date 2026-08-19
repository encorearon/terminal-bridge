// Arthas 安全基线
//
// 为什么需要：Arthas 直接挂在线上 JVM 上，trace/watch/monitor 等命令通过
// 字节码增强持续拦截方法调用，高频方法上不加限制会显著拖慢线上服务；
// retransform 改字节码可能不可逆；profiler 长期采样吃 CPU/内存。
// 这个模块在代理层拦截 Arthas 命令，按风险分级管控。
//
// 设计原则：
//   - 默认严格（保护线上），可通过环境变量放宽
//   - 只拦截 Arthas 命令（不认识的不拦，shell 命令也不拦）
//   - 拦截结果分两类：
//       "transform"  —— 自动改写命令（加安全参数）后放行，对 Agent 透明
//       "deny"       —— 拒绝，返回 error 让 Agent 走人工确认流程
//   - 对中风险命令做会话级计数，超阈值后拒绝

// ===================== 风险分级 =====================
// 依据 Arthas 官方文档的性能说明和字节码增强机制分类。

// 🟢 只读 / 安全：无字节码增强，开销可忽略
const SAFE_COMMANDS = new Set([
  "help", "version", "pwd", "session", "history",
  "sysenv", "sysprop", "jvm", "memory", "perfcounter",
  "vmoption", "mbean", "logger",
  "dashboard",   // 虽然持续刷新但只读，靠超时控制即可
  "options",
]);

// 🟠 中风险：字节码增强 + 持续监听，必须限次/限时
//   - 不加 -n 会无限监听，高频方法上持续产生开销
//   - 官方建议配合 #cost 过滤慢调用
const MEDIUM_RISK_COMMANDS = new Set(["watch", "trace", "stack", "monitor"]);

// 🔴 高风险：修改字节码 / 长期采样 / 不可逆 / 关闭服务
//   必须人工确认才能执行
const HIGH_RISK_COMMANDS = new Set([
  "retransform",   // 改字节码，可能不可逆（需 retransform -d 才能回滚）
  "profiler",      // async-profiler 长期采样，吃 CPU/内存
  "stop",          // 关闭 Arthas server，会话断开
  "reset",         // 重置所有增强类（影响面大）
]);

// ===================== 配置（环境变量可调）=====================
const MAX_MEDIUM_RISK_PER_SESSION = Number(process.env.ARTHAS_MAX_MEDIUM || 20);
// 是否对中风险命令自动补 -n（false 时改为 deny，让 Agent 显式确认）
// 默认 true：自动补 -n 1 对 Agent 透明，体验最好
const AUTO_PATCH_MEDIUM = process.env.ARTHAS_AUTO_PATCH !== "0";

// ===================== 会话级计数 =====================
// 跟踪本代理进程内执行过的中风险命令次数。超过阈值后拒绝，防止 Agent 失控循环调用。
let mediumRiskCount = 0;

// ===================== 命令解析 =====================
// 从 Arthas 命令字符串提取子命令名（第一个 token）。
//   "trace com.foo.Bar run" → "trace"
//   "trace  -n 2 com.foo.Bar run '#cost>100'" → "trace"
// 注意：Arthas 命令行用空格分 token，引号内空格不算分隔。
function parseArthasCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return null;
  // 简单 tokenizer：按空格切，但尊重引号
  const tokens = trimmed.match(/\S+|"[^"]*"|'[^']*'/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens[0].toLowerCase();
}

// 判断 cmd 是不是 Arthas 命令（而非 shell 命令）。
// 启发式：第一个 token 在 Arthas 已知命令集里，就认为是 Arthas 命令。
// 这样能跟 JumpServer 的 shell 命令区分（ls/ps/cat 不在 Arthas 命令集）。
const ALL_ARTHAS_COMMANDS = new Set([
  ...SAFE_COMMANDS, ...MEDIUM_RISK_COMMANDS, ...HIGH_RISK_COMMANDS,
  // 这些是一次性查询类，归为低风险（放行但不补参数）
  "thread", "sc", "sm", "jad", "getstatic", "classloader", "vmtool",
  "cat", "echo", "grep", "tee", "base64", "tt", "line", "cls",
]);

function isArthasCommand(cmd) {
  const name = parseArthasCommand(cmd);
  return name !== null && ALL_ARTHAS_COMMANDS.has(name);
}

// ===================== 参数检查 =====================
// 中风险命令是否已带 -n 或 #cost（已自带限制就不再补）
function hasFrequencyLimit(cmd) {
  // -n 数字（如 -n 1、-n2）或 --limits 数字
  if (/\s-n\s*\d+/i.test(cmd) || /\s--limits?\s*\d+/i.test(cmd)) return true;
  // #cost 条件表达式
  if (/#cost\s*[><=]/i.test(cmd)) return true;
  return false;
}

// profiler 已被禁用（高风险），不再需要解析持续时间

// ===================== 主审计函数 =====================
// 返回值：
//   { action: "allow" }                              —— 放行，cmd 不变
//   { action: "transform", cmd: 新cmd, reason }      —— 放行但改写了命令
//   { action: "deny", error, suggest, message }      —— 拒绝
function auditArthasCommand(cmd) {
  const name = parseArthasCommand(cmd);
  if (!name) return { action: "allow" };

  // 只审计认识的 Arthas 命令；不认识的（可能是 shell）放行
  if (!ALL_ARTHAS_COMMANDS.has(name)) return { action: "allow" };

  // --- 🟢 安全命令 ---
  if (SAFE_COMMANDS.has(name)) {
    return { action: "allow" };
  }

  // --- 🔴 高风险命令：无条件禁用 ---
  // 这类命令（retransform/profiler/stop/reset）改字节码/长期采样/不可逆，
  // 通过桥接执行风险太高。一律拒绝，让用户去浏览器终端手动操作。
  if (HIGH_RISK_COMMANDS.has(name)) {
    const riskInfo = HIGH_RISK_INFO[name];
    return {
      action: "deny",
      error: "arthas-forbidden",
      suggest: riskInfo.suggest,
      message: riskInfo.message,
    };
  }

  // --- 🟠 中风险命令 ---
  if (MEDIUM_RISK_COMMANDS.has(name)) {
    // 会话计数超阈值
    if (mediumRiskCount >= MAX_MEDIUM_RISK_PER_SESSION) {
      return {
        action: "deny",
        error: "arthas-quota-exceeded",
        message: `中风险命令（${name}）本会话已执行 ${mediumRiskCount} 次，达到上限 ${MAX_MEDIUM_RISK_PER_SESSION}。为保护线上服务，已拒绝。如需继续，请重启代理重置计数。`,
      };
    }

    // 已自带 -n 或 #cost，直接放行
    if (hasFrequencyLimit(cmd)) {
      mediumRiskCount++;
      return { action: "allow" };
    }

    // 没带频率限制
    if (AUTO_PATCH_MEDIUM) {
      // 自动补 -n 1：只采样一次就停，开销可控，对 Agent 透明
      mediumRiskCount++;
      const patched = `${cmd} -n 1`;
      return {
        action: "transform",
        cmd: patched,
        reason: `中风险命令 ${name} 未带 -n/#cost，已自动补 -n 1（只采样一次）`,
      };
    } else {
      // 严格模式：拒绝，让 Agent 显式确认
      return {
        action: "deny",
        error: "arthas-needs-limit",
        suggest: `${cmd} -n 1`,
        message: `中风险命令 ${name} 未带频率限制（-n 或 #cost）。高频方法上持续增强会拖慢线上服务。建议加 -n 1（只采样一次）或 '#cost>100'（只看慢调用）后重试。`,
      };
    }
  }

  // --- 其他低风险 Arthas 命令（thread/jad/sc 等一次性查询）---
  return { action: "allow" };
}

// 高风险命令的禁用提示信息
// message 告诉用户为什么禁用 + 去哪里手动操作；suggest 给替代方案
const HIGH_RISK_INFO = {
  retransform: {
    suggest: "用 jad 查看字节码（只读）；如确需 retransform，请在浏览器 Arthas 终端手动执行",
    message: "retransform 会直接修改线上 JVM 字节码，且可能不可逆（需 retransform -d 才能回滚），stop arthas 后改动仍可能生效。此命令已通过桥接禁用，请到浏览器 Arthas 终端手动执行。",
  },
  profiler: {
    suggest: "用 thread/memory/jvm 查看概况；如需火焰图，请在浏览器 Arthas 终端手动执行 profiler start -d 60",
    message: "profiler（async-profiler）会持续采样，消耗 CPU 和内存，通过桥接执行难以控制采样窗口。此命令已禁用，请到浏览器 Arthas 终端手动执行（务必带 -d 限时）。",
  },
  stop: {
    suggest: "如需断开，关闭浏览器 Arthas 页面即可",
    message: "stop 会关闭整个 Arthas server，导致所有诊断会话断开、所有增强被重置，影响其他使用该 arthas 会话的人。此命令已禁用。如需断开，关闭浏览器页面即可。",
  },
  reset: {
    suggest: "用 reset <具体类> 只重置需要的类（但 reset 本身也被禁用，请到浏览器手动执行）",
    message: "reset 会重置所有被增强的类，影响面大。此命令已禁用，请到浏览器 Arthas 终端手动执行（建议只 reset 特定类）。",
  },
};

// ===================== 导出 =====================
export {
  auditArthasCommand,
  isArthasCommand,
  parseArthasCommand,
  SAFE_COMMANDS,
  MEDIUM_RISK_COMMANDS,
  HIGH_RISK_COMMANDS,
};
