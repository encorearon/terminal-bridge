# WS Sniffer

两个能力，一个插件：

1. **抓 WebSocket**（原有）：基于 `chrome.debugger` + Chrome DevTools Protocol，抓页面所有 WebSocket（含 `wss://`、Worker 内）的收发帧，包括二进制帧。
2. **桥接 JumpServer 终端**（新增）：通过本地代理，让外部 Agent 把 linux 命令注入 JumpServer 页面的 xterm 终端，并把 WebSocket 返回值配对成结构化输出返回。

## 为什么用 chrome.debugger

- Console 注入 hook `WebSocket` 的方式对时机敏感（连接早于 hook 就漏掉），且无法捕获 Worker 内的连接。
- `chrome.debugger` 走 CDP 的 `Network.webSocketFrame*` 事件，在网络层监听，**任何 WebSocket 连接都能抓到**，并能拿到原始的 opcode 与 payload。

## 目录结构

```
ws-sniffer/
├── manifest.json   # 插件清单 (Manifest V3)：debugger + tabs + content_scripts + nativeMessaging
├── background.js   # Service Worker：抓 WS + 连代理 + 路由命令 + 上行帧 + native messaging
├── content.js      # ISOLATED world：注 koko iframe，把命令注入 xterm textarea
├── popup.html      # 工具栏弹窗 UI（抓包控制 + 代理启停）
├── popup.js        # 弹窗交互：开始/停止/导出/清空 + 启动/停止代理
├── README.md
├── native/         # Native Messaging Host：让插件能启动本地代理
│   ├── host.js         # host 逻辑：接收插件命令，启动/停止 proxy/server.js
│   ├── host.sh         # wrapper（用绝对路径调 node）
│   ├── com.wssniffer.host.json  # 注册到 Chrome 的 manifest
│   └── install.sh      # 一键安装
└── proxy/
    ├── server.js           # 本地代理：ws://127.0.0.1:8787/ssh，请求-响应配对
    ├── client-example.mjs  # Agent 调用示例
    └── package.json
```

配套 skill（用户级，跨项目可用）：`~/.agents/skills/jumpserver-term-bridge/`

---

## 能力一：纯抓包（手动分析）

### 安装

1. 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录
4. 浏览器右上角会出现插件图标（建议固定到工具栏）

### 使用

1. 打开目标页面（如 jump.meiyunji.net 终端）
2. 点插件图标 → 「▶ 开始抓取」
   - 浏览器顶部会出现黄色提示条「WS Sniffer 已开始调试此浏览器」，这是 debugger API 的正常表现
3. 刷新页面，登录并打开终端，正常操作
4. 弹窗会每 2 秒刷新一次帧数统计
5. 点「💾 导出 JSON」下载 `ws-frames-<时间戳>.json`

### 导出数据结构

```json
{
  "_all_": [
    { "t": 1786512876000, "dir": "open", "url": "wss://..." },
    { "t": 1786512876001, "dir": "recv", "type": "text", "value": "...", "len": 128 },
    { "t": 1786512876002, "dir": "send", "type": "binary", "base64": "AAAA...", "len": 256 }
  ],
  "wss://jump.meiyunji.net/...": [
    { "t": 1786512876000, "dir": "open", "url": "wss://..." }
  ]
}
```

字段说明：
- `dir`: `open` / `send` / `recv`
- `type`: `text` / `binary` / `close` / `ping` / `pong`
- `value`: 文本帧内容（超 2000 字符会截断）
- `base64`: 二进制帧的 base64 编码
- `len`: 原始字节长度

---

## 能力二：JumpServer 终端桥接（Agent 自动化）

### 工作原理

```
Agent (发 linux 命令)
  ↓ ws → 本地代理 :8787/ssh
本地代理 (把 cmd 包成 `cmd; printf 哨兵\r`，请求-响应配对)
  ↓ ws → 插件 background
插件 background (转发给 content script + CDP 抓 WS recv 帧)
  ↓ chrome.tabs.sendMessage → koko iframe 的 content script
content script (往 .xterm textarea 注入字符，触发 onData)
  ↓ xterm → koko WS → 远端 SSH
SSH 输出回显
  ↓ koko WS recv 帧
插件 background (CDP 抓到，发给代理)
  ↓ ws
代理 (在 recv 流里匹配哨兵，切出输出) → Agent 拿到结构化结果
```

### 启动

**方式一：从插件 popup 启动（推荐，一次安装后零终端操作）**

```bash
# 一次性安装 native messaging host（注册到 Chrome）
cd ~/Code/testwork/ws-sniffer
bash native/install.sh
```

然后在 Chrome：
1. `chrome://extensions/` → **刷新 WS Sniffer**（加载新的 key + nativeMessaging 权限）
2. 确认插件 ID 是 `knknaiffipnhifen`
3. 点插件图标 → 「🔧 JumpServer 桥接代理」区域 → 点「🚀 启动代理」
4. 状态灯变绿 = 代理运行中（`:8787`）

之后无需再开终端，插件 popup 里随时启动/停止代理。

**方式二：手动终端启动（调试用）**

```bash
# 端口别被占（dailytest 的 server.js 也用 8787，二选一）
lsof -i:8787

cd ~/Code/testwork/ws-sniffer/proxy
npm install          # 首次
node server.js       # 前台跑，看日志
```

Chrome 侧：在 `chrome://extensions/` **刷新 WS Sniffer**（manifest 改过），打开 JumpServer 终端，连上一个资产。

### 调用

```bash
cd ~/Code/testwork/ws-sniffer/proxy
node client-example.mjs "uname -a"
node client-example.mjs "df -h" 15000
```

或在 Agent 代码里复制 `client-example.mjs` 的 `run()` 函数：

```js
const result = await run("systemctl status nginx", 15000);
// { ok: true, output: "● nginx.service ...", elapsedMs: 234 }
```

### 关键约定

- **命令发到真实 SSH 会话**，有副作用。危险操作需用户授权。
- **默认超时 10s**，长命令调大 `timeoutMs`。
- **串行执行**，代理排队，不会交错。
- **输出已清理**：ANSI 颜色码、prompt 行、命令回显行已去掉，`\r\n`→`\n`。可能残留少量 kitty 重绘碎片（不影响理解）。
- **完成判定靠 prompt 锚点**：发 cmd 后等 shell prompt 再次出现即完成。比标记字符串可靠（kitty 逐字符注入会重绘打散标记）。
- **交互式命令不适用**：vim/less/top/需密码的 sudo 会超时。超时自动 Ctrl+C 复位终端。
- **sudo 别名（自动处理）**：部分机器把 `cat`/`df` alias 成 sudo 版本，触发密码提示时代理自动检测并返回 `sudo-required` 错误，Agent 问用户是否切 root，确认后自动 `sudo su root` + 重发原命令。
- **koko 协议**：实测走二进制帧（opcode=2），payloadData 是 base64，解码后是明文终端流。代理已自动解码。

详见 skill `~/.agents/skills/jumpserver-term-bridge/SKILL.md` 和 `proxy/server.js` 顶部注释。

---

## 注意事项

- 服务终端站点（如 JumpServer/koko）通常走二进制 SSH 流，导出后会看到大量 `type: "binary"`，可用 `base64 -d` 解码后分析协议。
- 每次「开始抓取」都会触发调试提示条，关闭即停止抓取。**桥接模式下不需要手动点"开始抓取"**——content script 上报 term-ready 时自动 attach。
- Manifest V3 的 Service Worker 会被 Chrome 休眠，但 CDP 事件会持续唤醒它；桥接模式下还用 `chrome.alarms` 每 30s 检查代理连接。
- 桥接模式下，content script 用 `<all_urls>` + `all_frames` 注入，但在 content.js 里用 `isKokoFrame()` 守卫，只在 koko connect iframe 里工作，其他 frame 零副作用。

