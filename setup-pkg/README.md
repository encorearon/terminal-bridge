# terminal-bridge-setup

> 一次性安装器：让 Agent 能通过浏览器 xterm 终端（JumpServer Web 终端 / Arthas Console）执行命令并拿回输出。

## 一键安装

需要 Node.js 18+ 和 Chrome 浏览器：

```bash
npx terminal-bridge-setup
```

安装器自动完成：

1. 释放文件到 `~/.terminal-bridge/`
2. 安装代理依赖
3. 注册 Native Messaging Host 到 Chrome
4. 打开 `chrome://extensions` 引导加载插件

## 加载 Chrome 插件（手动，一次性）

`npx` 会自动打开 `chrome://extensions`，按提示操作：

1. 右上角打开「开发者模式」
2. 点「加载已解压的扩展程序」
3. 选择目录：`~/.terminal-bridge/extension`
4. 确认插件 ID 是 `jkbnakjnbahigfefgiipfngheiafoein`

## 使用

1. 打开终端页面（JumpServer Web 终端 / Arthas Console），完成连接
2. 点插件图标 →「🔍 捕捉终端」→「🚀 启动代理」
3. 两个绿灯亮，Agent 即可通过桥接发命令

## 架构

```
Agent (命令)
  ↓ ws → 本地代理 (127.0.0.1:8787)
本地代理 (prompt 锚点配对 + Arthas 安全基线)
  ↓ ws → Chrome 插件 background
插件 (CDP 抓 WS 帧 + 注入 xterm)
  ↓ → 终端页面 xterm → 远端 SSH / JVM
```

## 特性

- **双终端支持**：JumpServer 堡垒机 Web 终端 + Arthas Web Console
- **Yearning SQL 自动化**：Agent 通过 yr-run 注入 SQL → 自动点查询 → MessagePack 结果帧解码返回；手动查询同样捕获
- **CSV 导出**：每次查询结果自动进 popup 的「CSV 导出记录」，点击即下载（BOM + RFC4180，Excel 直开）
- **多 Yearning 页面**：popup 列表展示数据源/数据库，选择目标页面，SQL 注入与结果按 tab 隔离
- **注入前新建 SQL 窗口**：不污染用户正在使用的编辑器；数据库未选择时提前报错
- **结构化输出**：ANSI 已清理，命令回显已去除，返回纯净文本
- **sudo 自动重试**：检测 sudo 别名劫持，询问用户后切 root 重试
- **Arthas 安全基线**：中风险命令（trace/watch）自动补 `-n`，高风险命令（retransform/profiler/stop）无条件禁用
- **多终端切换**：popup 内 tab 选择器，带 host 标签区分

## 卸载

```bash
rm -rf ~/.terminal-bridge
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wssniffer.host.json"
```

然后在 `chrome://extensions` 移除插件。

## License

MIT
