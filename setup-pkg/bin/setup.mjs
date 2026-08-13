#!/usr/bin/env node
// terminal-bridge-setup —— 终端桥接一次性安装器
//
// 做 4 件事：
//   1. 把插件源码 + 代理 + native host 释放到 ~/.terminal-bridge/
//   2. 在代理目录跑 npm install（装 ws）
//   3. 注册 native messaging host 到 Chrome（复用 native/install.sh）
//   4. 打开 chrome://extensions，引导用户"加载已解压扩展"
//
// 用法（发布后）：
//   npx terminal-bridge-setup
// 本地测试：
//   node setup-pkg/bin/setup.mjs

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILES_DIR = join(__dirname, "..", "files");
const INSTALL_DIR = join(homedir(), ".terminal-bridge");

// 插件 ID（由 manifest.json 的 key 字段决定，固定不变）
const EXTENSION_ID = "jkbnakjnbahigfefgiipfngheiafoein";

// 颜色输出（简单的 ANSI，不用 chalk 避免依赖）
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (msg) => console.log(msg);
const ok = (msg) => console.log(c.green("✓ ") + msg);
const fail = (msg) => { console.error(c.red("✗ ") + msg); process.exit(1); };
const step = (n, total, msg) => console.log(`\n${c.bold(c.cyan(`[${n}/${total}]`))} ${msg}`);
const STEPS = 5;

// ===================== 步骤 1：释放文件 =====================
function releaseFiles() {
  step(1, STEPS, `释放文件到 ${c.dim(INSTALL_DIR)}`);

  if (!existsSync(FILES_DIR)) {
    fail(`安装包不完整：未找到 ${FILES_DIR}`);
  }

  // 已存在：提示用户。除非带 --force，否则保留用户的 extension 配置覆盖。
  const isForce = process.argv.includes("--force");
  if (existsSync(INSTALL_DIR)) {
    if (isForce) {
      console.log(c.yellow("  已存在 ~/.terminal-bridge/，--force 模式：覆盖"));
      rmSync(INSTALL_DIR, { recursive: true, force: true });
    } else {
      // 不强制覆盖时，仍然更新文件（保留 .proxy.pid/.proxy.log 等运行时产物）
      console.log(c.yellow("  ~/.terminal-bridge/ 已存在，将更新文件（运行时产物保留）"));
    }
  }

  mkdirSync(INSTALL_DIR, { recursive: true });

  // 复制四个子目录（skill 只释放到 ~/.terminal-bridge/skill 备份，
  // 实际安装到 ~/.agents/skills/ 由 installSkill 负责）
  for (const sub of ["proxy", "native", "extension", "skill"]) {
    const src = join(FILES_DIR, sub);
    const dst = join(INSTALL_DIR, sub);
    if (!existsSync(src)) {
      fail(`安装包缺少 files/${sub}/`);
    }
    cpSync(src, dst, { recursive: true, force: true });
    ok(`释放 ${sub}/`);
  }
}

// ===================== 步骤 2：装代理依赖 =====================
function installProxyDeps() {
  step(2, STEPS, "安装代理依赖 (ws)");

  // 如果 node_modules/ws 已存在（从包里带出来的），跳过
  const wsPath = join(INSTALL_DIR, "proxy", "node_modules", "ws");
  if (existsSync(wsPath)) {
    ok("依赖已存在，跳过");
    return;
  }

  const proxyDir = join(INSTALL_DIR, "proxy");
  console.log(c.dim("  运行 npm install ..."));
  const result = spawnSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], {
    cwd: proxyDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    fail("npm install 失败，请检查网络后重试");
  }
  ok("依赖安装完成");
}

// ===================== 步骤 3：注册 native host =====================
function registerNativeHost() {
  step(3, STEPS, "注册 Native Messaging Host");

  // macOS / Linux 路径不同
  const plat = platform();
  let destDir;
  if (plat === "darwin") {
    destDir = join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  } else if (plat === "linux") {
    destDir = join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
  } else {
    console.log(c.yellow("  ⚠ Windows 平台需要手动配置 native host，跳过自动注册"));
    console.log(c.dim("  参考：https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging"));
    return false;
  }

  const installSh = join(INSTALL_DIR, "native", "install.sh");
  if (!existsSync(installSh)) {
    fail(`未找到 ${installSh}`);
  }

  // 调用通用 install.sh，传入 INSTALL_DIR 作为项目根
  // install.sh 会：检测 node → 生成 host.sh → 生成 manifest → 复制到 destDir
  const result = spawnSync("bash", [installSh, INSTALL_DIR], { stdio: "inherit" });
  if (result.status !== 0) {
    fail("install.sh 执行失败");
  }

  // 校验：manifest 确实到了目标目录
  const destManifest = join(destDir, "com.wssniffer.host.json");
  if (!existsSync(destManifest)) {
    fail(`注册校验失败：${destManifest} 不存在`);
  }
  ok(`已注册到 ${destDir}`);
  return true;
}

// ===================== 步骤 4：安装 skill =====================
// 把 skill 释放到 ~/.agents/skills/jumpserver-term-bridge/
// 这样 Agent（如 ZCode）能自动发现并触发，知道怎么调用桥接、怎么处理各种错误。
function installSkill() {
  step(4, STEPS, "安装 Agent skill");

  const skillSrc = join(INSTALL_DIR, "skill");
  if (!existsSync(skillSrc)) {
    console.log(c.yellow("  ⚠ 未找到 skill 源文件，跳过（不影响核心功能）"));
    return;
  }

  // skill 安装位置：~/.agents/skills/jumpserver-term-bridge/
  // 这是 ZCode 的用户级 skill 目录，放这里 Agent 能自动发现
  const skillDest = join(homedir(), ".agents", "skills", "jumpserver-term-bridge");
  mkdirSync(skillDest, { recursive: true });
  cpSync(skillSrc, skillDest, { recursive: true, force: true });
  ok(`skill → ${skillDest}`);
  console.log(c.dim("  Agent 现在能自动识别 jumpserver/arthas 终端并使用桥接"));
}

// ===================== 步骤 5：引导加载插件 =====================
function guideLoadExtension() {
  step(5, STEPS, "加载 Chrome 插件");

  const extDir = join(INSTALL_DIR, "extension");
  console.log("");
  console.log(c.bold("请在 Chrome 中操作："));
  console.log("");
  console.log(`  ${c.cyan("1.")} 打开 ${c.bold("chrome://extensions")}`);
  console.log(`     ${c.dim("(我会尝试帮你打开)")}`);
  console.log("");
  console.log(`  ${c.cyan("2.")} 右上角打开「${c.bold("开发者模式")}」`);
  console.log("");
  console.log(`  ${c.cyan("3.")} 点「${c.bold("加载已解压的扩展程序")}」`);
  console.log(`     选择目录：`);
  console.log(`     ${c.green(extDir)}`);
  console.log("");
  console.log(`  ${c.cyan("4.")} 加载后确认插件 ID 是：`);
  console.log(`     ${c.bold(EXTENSION_ID)}`);
  console.log(`     ${c.dim("(ID 由 manifest key 固定，native host 已按此 ID 注册)")}`);
  console.log("");

  // 尝试用系统默认方式打开 chrome://extensions
  const plat = platform();
  let opened = false;
  try {
    if (plat === "darwin") {
      spawnSync("open", ["chrome://extensions"], { stdio: "ignore" });
      opened = true;
    } else if (plat === "linux") {
      spawnSync("xdg-open", ["chrome://extensions"], { stdio: "ignore" });
      opened = true;
    }
  } catch {}
  if (opened) ok("已尝试打开 chrome://extensions");
}

// ===================== 主流程 =====================
function main() {
  console.log(c.bold(c.cyan("\n🔌 终端桥接安装器")));
  console.log(c.dim("  JumpServer Web 终端 · Arthas Console\n"));

  // 前置检查：node 版本
  const nodeVer = process.versions.node.split(".")[0];
  if (Number(nodeVer) < 18) {
    fail(`需要 Node.js >= 18，当前是 ${process.versions.node}`);
  }
  ok(`Node.js ${process.versions.node}`);

  releaseFiles();
  installProxyDeps();
  registerNativeHost();
  installSkill();
  guideLoadExtension();

  console.log("");
  console.log(c.green(c.bold("✓ 安装完成！")));
  console.log("");
  console.log(c.bold("下一步："));
  console.log(`  ${c.cyan("•")} 打开 JumpServer 终端 或 Arthas Console 页面`);
  console.log(`  ${c.cyan("•")} 点插件图标 →「🔍 捕捉终端」→「🚀 启动代理」`);
  console.log(`  ${c.cyan("•")} 两个绿灯亮，即可通过 Agent 发命令`);
  console.log("");
  console.log(c.dim(`文件位置：${INSTALL_DIR}`));
  console.log(c.dim(`卸载：rm -rf ${INSTALL_DIR} && rm ~/Library/Application\\ Support/Google/Chrome/NativeMessagingHosts/com.wssniffer.host.json`));
  console.log("");
}

main();
