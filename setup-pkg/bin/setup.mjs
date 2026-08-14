#!/usr/bin/env node
// terminal-bridge-setup —— 终端桥接一次性安装器
//
// 做 5 件事：
//   1. 把插件源码 + 代理 + native host + skill 释放到 ~/.terminal-bridge/
//   2. 在代理目录跑 npm install（装 ws）
//   3. 注册 native messaging host 到 Chrome（复用 native/install.sh）
//   4. 安装 skill 到 ~/.agents/skills/（让 Agent 自动发现）
//   5. 打开 chrome://extensions + Finder，引导用户"加载已解压扩展"
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

  // 支持 --registry 透传（国内网络/公司内网常用）
  // 用法：npx terminal-bridge-setup --registry=https://registry.npmmirror.com
  const registryArg = process.argv.find(a => a.startsWith("--registry="));
  const npmArgs = ["install", "--no-audit", "--no-fund"];
  if (registryArg) {
    npmArgs.push(registryArg);
    console.log(c.dim(`  使用 registry: ${registryArg.split("=")[1]}`));
  } else {
    npmArgs.push("--silent");
  }

  console.log(c.dim("  运行 npm install ..."));
  const result = spawnSync("npm", npmArgs, {
    cwd: proxyDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    // 失败时给出明确的排查建议
    console.error("");
    console.error(c.red("  ✗ npm install 失败"));
    console.error(c.yellow("  常见原因和解决方法："));
    console.error("");
    console.error("  1. 网络不通/防火墙拦截：");
    console.error("     检查：curl -I https://registry.npmjs.org/ws");
    console.error("");
    console.error("  2. 公司内网/国内网络慢：换国内镜像重试");
    console.error("     命令：npx terminal-bridge-setup --registry=https://registry.npmmirror.com");
    console.error("");
    console.error("  3. 需要代理：");
    console.error("     命令：npm config set proxy http://your-proxy:port");
    console.error("     然后重跑 npx terminal-bridge-setup");
    console.error("");
    fail("npm install 失败（见上方排查建议）");
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
  const plat = platform();

  console.log("");
  console.log(c.bold("需要手动加载插件（一次性操作）："));
  console.log("");
  console.log(`  ${c.cyan("1.")} 已为你打开 ${c.bold("chrome://extensions")}`);
  console.log("");
  console.log(`  ${c.cyan("2.")} 右上角打开「${c.bold("开发者模式")}」开关`);
  console.log("");
  console.log(`  ${c.cyan("3.")} 点左上角「${c.bold("加载已解压的扩展程序")}」`);
  console.log(`     ${c.dim("已为你打开 Finder，选择这个文件夹：")}`);
  console.log(`     ${c.green(extDir)}`);
  console.log("");
  console.log(`  ${c.cyan("4.")} 加载后确认插件 ID 是：`);
  console.log(`     ${c.bold(EXTENSION_ID)}`);
  console.log(`     ${c.dim("(ID 固定，native host 已按此注册)")}`);
  console.log("");

  // ① 打开 chrome://extensions
  //    macOS: open -a 指定 Chrome；open URL scheme 更可靠
  //    Linux: 直接给 google-chrome 传 URL
  let chromeOpened = false;
  try {
    if (plat === "darwin") {
      // 优先用 Google Chrome，回退到默认浏览器
      const r = spawnSync("open", ["-a", "Google Chrome", "chrome://extensions"], { stdio: "ignore" });
      if (r.status !== 0) {
        spawnSync("open", ["chrome://extensions"], { stdio: "ignore" });
      }
      chromeOpened = true;
    } else if (plat === "linux") {
      // 试几个常见的 Chrome 命令名
      for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
        const r = spawnSync(bin, ["chrome://extensions"], { stdio: "ignore" });
        if (r.status === 0) { chromeOpened = true; break; }
      }
      if (!chromeOpened) spawnSync("xdg-open", ["chrome://extensions"], { stdio: "ignore" });
      chromeOpened = true;
    }
  } catch {}
  if (chromeOpened) ok("已打开 chrome://extensions");

  // ② 在 Finder/文件管理器里打开 extension 目录，方便用户直接拖拽选择
  try {
    if (plat === "darwin") {
      // open <dir> 会用 Finder 打开，并选中该文件夹
      spawnSync("open", [extDir], { stdio: "ignore" });
      ok(`已在 Finder 打开 ${extDir}`);
    } else if (plat === "linux") {
      spawnSync("xdg-open", [extDir], { stdio: "ignore" });
      ok(`已在文件管理器打开 ${extDir}`);
    }
  } catch {}

  // ③ 交互式等待用户确认加载完成，然后校验
  console.log("");
  console.log(c.yellow("→ 完成上述操作后，按 Enter 继续（校验插件是否加载成功）..."));
  console.log(c.dim("   （如果跳过，可稍后在插件 popup 里点「启动代理」验证）"));

  // 等待用户按 Enter（阻塞读取 stdin）
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      verifyExtensionLoaded();
      resolve();
    });
    // 超时兜底：60 秒没按 Enter 就继续
    setTimeout(() => {
      console.log(c.dim("\n  (等待超时，继续完成安装)"));
      process.stdin.pause();
      resolve();
    }, 60000);
  });
}

// 校验插件是否加载：通过探测 native host 间接判断
// （插件加载后 popup 才能点"启动代理"，代理起来说明 native host + 插件都通了）
function verifyExtensionLoaded() {
  console.log("");
  console.log(c.dim("  校验方式：稍后在插件 popup 里点「🚀 启动代理」"));
  console.log(c.dim("  绿灯亮 = 插件 + native host + 代理全部就绪"));
}

// ===================== 主流程 =====================
async function main() {
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
  await guideLoadExtension();

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
