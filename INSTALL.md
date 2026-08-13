# 终端桥接 —— 安装指南

让 Agent 能通过浏览器 xterm 终端（JumpServer Web 终端 / Arthas Console）执行命令并拿回输出。

## 一键安装

需要 Node.js 18+ 和 Chrome 浏览器。在终端运行：

```bash
npx terminal-bridge-setup
```

安装器会自动完成：
1. 释放文件到 `~/.terminal-bridge/`
2. 安装代理依赖
3. 注册 Native Messaging Host 到 Chrome
4. 打开 `chrome://extensions` 引导你加载插件

按提示完成最后一步（加载已解压扩展）即可。

> **本地开发/内部分发**（未发布到 npm 时）：
> ```bash
> git clone <repo> && cd terminal-bridge
> bash setup-pkg/sync-files.sh        # 同步源码到包目录
> node setup-pkg/bin/setup.mjs         # 运行安装器
> ```

## 加载 Chrome 插件（手动，一次性）

`npx` 会自动打开 `chrome://extensions`，你需要：

1. 右上角打开**「开发者模式」**
2. 点**「加载已解压的扩展程序」**
3. 选择目录：`~/.terminal-bridge/extension`
4. 确认插件 ID 是 `jkbnakjnbahigfefgiipfngheiafoein`
   （ID 固定不变，native host 已按此 ID 注册）

## 使用

1. 打开终端页面（JumpServer Web 终端 / Arthas Console），完成连接
2. 点插件图标 → **「🔍 捕捉终端」**（灰点变绿）
3. 点 **「🚀 启动代理」**（橙点变绿）
4. 两个都绿，Agent 即可通过桥接发命令

多终端场景：在 popup 下方 tab 列表点选目标终端（带 host 标签和「当前」标注区分）。

## 卸载

```bash
rm -rf ~/.terminal-bridge
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wssniffer.host.json"
```
然后在 `chrome://extensions` 移除插件。

## 排错

| 问题 | 解决 |
|------|------|
| 「启动代理」失败 | 确认已运行过 `npx terminal-bridge-setup`（注册了 native host） |
| 点「启动代理」无反应 | `chrome://extensions` 刷新插件 ↻，确认插件 ID 正确 |
| 捕捉不到终端 | 终端页面按 F5 刷新，再点「🔍 捕捉终端」 |
| `npx` 报错 | 确认 Node.js 18+（`node --version`） |

## 架构

```
Agent (命令)
  ↓ ws → 本地代理 (127.0.0.1:8787)
本地代理 (prompt 锚点配对 + Arthas 安全基线)
  ↓ ws → Chrome 插件 background
插件 (CDP 抓 WS 帧 + 注入 xterm)
  ↓ → 终端页面 xterm → 远端 SSH / JVM
```

文件位置：
- 插件 + 代理 + native host：`~/.terminal-bridge/`
- Chrome native host 注册：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wssniffer.host.json`
