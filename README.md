# Terminal Bridge

让 Agent 通过浏览器 xterm 终端（JumpServer Web 终端 / Arthas Console）执行命令并拿回输出。

## 快速开始

```bash
npx terminal-bridge-setup
```

安装器自动完成：释放文件 → 装依赖 → 注册 native host → 安装 skill → 打开 chrome://extensions 引导加载插件。

详见 [INSTALL.md](./INSTALL.md)。

## 工作原理

```
Agent (命令)
  ↓ ws → 本地代理 (127.0.0.1:8787)
本地代理 (prompt 锚点配对 + Arthas 安全基线)
  ↓ ws → Chrome 插件 background
插件 (CDP 抓 WS 帧 + 注入 xterm)
  ↓ → 终端页面 xterm → 远端 SSH / JVM
```

- **注入侧**：content script 找到 `.xterm` 的 textarea，dispatch InputEvent 模拟键盘输入
- **抓取侧**：CDP `Network.webSocketFrameReceived` 抓终端 WebSocket 帧
- **完成判定**：prompt 锚点（JumpServer 等 `]#`/`]$`，Arthas 等 `>`）

## 支持的终端

| 终端 | 用途 | WS 帧格式 | prompt |
|------|------|----------|--------|
| JumpServer (koko) | 堡垒机后端 SSH | 二进制 opcode=2（base64） | `[user@host dir]#` |
| Arthas Console | 线上 JVM 诊断 | 文本 opcode=1（明文 ANSI） | `arthas@pid>` |

## 特性

- **结构化输出**：ANSI 已清理，命令回显已去除
- **sudo 自动重试**：检测 sudo 别名劫持，询问用户后切 root
- **Arthas 安全基线**：中风险命令（trace/watch）自动补 `-n`，高风险命令（retransform/profiler/stop）禁用
- **多终端切换**：popup tab 选择器
- **reload 插件免刷新**：scripting 权限主动注入 content script

## 目录结构

```
ws-sniffer/
├── manifest.json          # Chrome 插件清单 (MV3)
├── background.js          # Service Worker：CDP 抓帧 + 连代理 + 路由命令
├── content.js             # 注入 xterm 命令（兼容 koko iframe / Arthas 顶层文档）
├── popup.html / popup.js  # 工具栏 UI：终端捕获 + 代理启停
├── native/                # Native Messaging Host
│   ├── host.js            #   接收插件命令，启动/停止代理
│   ├── install.sh         #   通用安装（从模板生成 host.sh + manifest）
│   └── *.template         #   模板（路径占位符，安装时填充）
├── proxy/                 # 本地代理
│   ├── server.js          #   ws://127.0.0.1:8787/ssh，请求-响应配对
│   ├── arthas-guard.js    #   Arthas 安全基线
│   └── client-example.mjs #   Agent 调用示例
├── skill/                 # Agent skill 源文件（安装到 ~/.agents/skills/）
│   ├── SKILL.md
│   └── references/protocol.md
└── setup-pkg/             # npx 安装包（发布到 npm）
    ├── bin/setup.mjs      #   安装器入口
    ├── sync-files.sh      #   打包前同步源码
    └── files/             #   携带的文件快照
```

## 开发

### 修改代码后同步到 npx 包

```bash
bash setup-pkg/sync-files.sh     # 同步源码到 setup-pkg/files/
```

### 发布新版本

```bash
cd setup-pkg
# 改 package.json 的 version
npm publish
```

### 本地测试安装器

```bash
node setup-pkg/bin/setup.mjs --force
```

## License

MIT
