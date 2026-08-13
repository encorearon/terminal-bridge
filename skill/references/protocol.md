# 消息协议详解

代理端点 `ws://127.0.0.1:8787/ssh`，所有消息均为单行 JSON。

支持两类终端，Agent 侧协议完全一致，差异在桥接层自动处理：
- **JumpServer (koko)**：堡垒机后端 SSH，跑 shell 命令
- **Arthas Console**：线上 JVM 诊断，跑 Arthas 命令（thread/jad/watch 等）

## 角色与连接

同一端点接两类客户端，靠消息 `type` 路由：

- **插件（Chrome extension background）**：唯一，连上后发 `hello{role:extension}` 声明身份。负责上报 WS 帧、接收注入指令。
- **Agent**：可有多个。发 `run` 请求，收 `result` 响应。

## 完整消息列表

### Agent → 代理

#### `run` — 发命令执行
```json
{
  "type": "run",
  "reqId": "abc123",
  "cmd": "ls -la /etc",
  "timeoutMs": 10000
}
```
- `reqId`：可选。不传则代理生成（8 位 hex）。用于配对 result。
- `cmd`：必填。命令本身，**不要自己加哨兵/换行**——代理会自动包末尾 `\r`。
  - JumpServer：linux 命令，如 `ps aux | grep java`
  - Arthas：Arthas 命令，如 `jad com.foo.Bar`
- `timeoutMs`：可选，默认 10000。超时则返回 `ok:false, error:timeout`。

### 代理 → Agent

#### `result` — 命令执行结果
```json
{
  "type": "result",
  "reqId": "abc123",
  "ok": true,
  "output": "total 48\ndrwxr-xr-x ...",
  "elapsedMs": 234
}
```
失败时：
```json
{
  "type": "result",
  "reqId": "abc123",
  "ok": false,
  "error": "timeout | inject failed | extension disconnected | sudo-required | arthas-forbidden | arthas-needs-limit | arthas-quota-exceeded",
  "output": "部分输出（可能为空）",
  "suggest": "更安全的替代命令（部分错误才有）",
  "message": "给用户看的说明文字（部分错误才有）",
  "elapsedMs": 10000
}
```
- `output`：prompt 锚点出现前的所有 recv 帧拼接，已去 ANSI、`\r\n`→`\n`、删 prompt 行和命令回显行、首尾 trim。
- `error` 枚举：
  - `timeout` — 命令超时（交互式/持续命令会触发）
  - `inject failed` — content script 注入失败（xterm 没捕捉到）
  - `extension disconnected` — 插件断开
  - `sudo-required` — JumpServer sudo 别名劫持，按 sudo 重试流程处理
  - `arthas-forbidden` — Arthas 高风险命令（retransform/profiler/stop/reset）被禁用，告知用户去浏览器手动执行，不重试
  - `arthas-needs-limit` — Arthas 中风险命令缺 `-n`/`#cost`（严格模式），按 `suggest` 补参数
  - `arthas-quota-exceeded` — Arthas 中风险命令会话超限，不重试

#### `hello-ack` — 握手回应
任何 `hello` 都会收到 `{type:"hello-ack", payload:{ok:true}}`。

### 插件 → 代理

#### `hello` — 声明角色
```json
{ "type": "hello", "payload": { "role": "extension" } }
```

#### `ws-recv` / `ws-send` — 上报 WS 帧
```json
{ "type": "ws-recv", "payload": { "data": "帧内容", "opcode": 1, "t": 1786512876000 } }
```
- `data`：CDP 的 `payloadData`。
  - 文本帧（opcode=1，Arthas）：直接是明文 ANSI string
  - 二进制帧（opcode=2，koko）：是 base64 string，代理解码后得明文
- `opcode`：1=文本，2=二进制。代理按此判断是否需要 base64 解码。

#### `ws-open` — 新 WS 连接
```json
{ "type": "ws-open", "payload": { "url": "wss://...", "requestId": "..." } }
```

#### `inject-failed` — 注入失败通知
```json
{ "type": "inject-failed", "payload": { "reqId": "...", "error": "no terminal frame with xterm in active tab" } }
```

### 代理 → 插件

#### `run-cmd` — 注入指令
```json
{ "type": "run-cmd", "text": "ls -la\r", "reqId": "abc123" }
```
`text` 是命令本身 + 末尾 `\r`（触发 xterm onData 提交）。插件批量注入 xterm textarea（一次 InputEvent 派发整段文本，末尾 Enter keydown 触发执行）。

## prompt 锚点机制（核心）

### 为什么不用标记字符串

曾尝试过哨兵（`cmd; printf '哨兵'`）和双标记（`echo BEGIN; cmd; echo END`）方案，都失败了——**kitty 终端逐字符注入时会重绘输入行**，把标记字符串打散到 WebSocket 流里，无法可靠匹配。

### prompt 锚点（expect/pexpect 经典方案）

命令完成后，终端会输出 prompt。prompt 是**服务端输出的**，不受 kitty 输入重绘影响。

流程：
1. 代理发 `cmd\r`，插件批量注入 xterm
2. 代理在 ws-recv 流里累积解码后的文本
3. 每次 ANSI 清理后检查 buffer 尾部是否匹配 prompt 正则
4. prompt 出现 = 命令执行完毕
5. buffer 交给 cleanOutput 清理（删 prompt 行、命令回显行、ANSI）

### 双 prompt 正则（兼容两种终端）

```js
const PROMPT_RE = /\]\s*[#$]\s*$|>\s*$/;
```

| 终端 | prompt 样式 | 匹配部分 |
|------|------------|---------|
| JumpServer (shell) | `[root@host /path]#` 或 `]$` | `]\s*[#$]\s*$` |
| Arthas | `arthas@pid>` 或 `[arthas@...]` | `>\s*$` |

注意：单独的 `>` 较宽（命令输出里 `>` 偶尔出现），但配合"行尾 + ANSI 清理后 + 注入命令后才出现"三个条件，误判率可接受。

### 输出清理规则

`cleanOutput(text, cmd)` 做了：
1. 去 ANSI CSI（`\x1b\[[0-9;?]*[ -/]*[@-~]`）—— 颜色、光标移动、清行
2. 去 ANSI OSC（`\x1b\]...(\x07|\x1b\\)`）—— 标题设置等
3. `\r\n` 和孤立 `\r` → `\n`
4. 删含 prompt 模式的行：
   - shell 风格 `[user@host /cwd]#` → 整行删
   - Arthas/REPL 风格：行尾是 `>` 且行不长（≤60 字符）→ 整行删
5. 删 koko 控制消息行（`{"id":...,"type":...}` JSON）
6. 删整行等于 cmd 的行（精确匹配，去空白后比较）—— 命令回显
7. 压缩多余空行，首尾 trim

### timeout 与 Ctrl+C 复位

超时（默认 10s）时，代理自动发 `\x03`（Ctrl+C）复位终端。这很关键——交互式命令（sudo 密码提示、vim、Arthas 持续刷新命令）会让 prompt 永远不出现，如果不复位，下一条命令会被当成输入污染终端。

### 已知限制

- **kitty 重绘碎片（JumpServer）**：长命令逐字符注入时，kitty 重绘产生的命令文本片段可能残留在输出里（1-3 行）。不影响 Agent 理解，但不是绝对干净。Arthas 无此问题（批量注入）。
- **交互式/持续命令不适用**：vim、less、top、需密码的 sudo、Arthas 的 dashboard/monitor/watch（持续刷新）会超时。
- **sudo 别名（仅 JumpServer）**：部分机器把常用命令 alias 成 sudo 版本，用绝对路径（`/bin/cat`）绕过，或走 sudo 自动重试流程。

## 探针（probe）

代理收到第一个 `ws-recv` 帧时，会把原始数据形态打到日志。两种终端的典型输出：

**koko（二进制帧）：**
```
[proxy] [PROBE] opcode = 2 (二进制帧)
[proxy] [PROBE] 原始 payloadData（前 120 字符）: "ZWNobyBoZWxsbw=="...
[proxy] [PROBE] base64 解码后（前 200 字符）: "\r\n..."
[proxy] [PROBE] 结论：二进制帧，但 payload 是明文终端流（已自动解码）
```

**Arthas（文本帧）：**
```
[proxy] [PROBE] opcode = 1 (文本帧)
[proxy] [PROBE] 原始 payloadData（前 120 字符）: "\u001b[1;31m  ,---.  ..."
```

判读：
- `opcode = 1` → 文本帧。payload 直接是明文（可能带 ANSI 颜色码），无需解码。
- `opcode = 2` → 二进制帧。代理自动 base64 解码。
- 关闭探针日志：启动时 `PROBE_LOG=0 node server.js`。
