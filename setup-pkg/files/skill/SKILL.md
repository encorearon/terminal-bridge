---
name: jumpserver-term-bridge
description: 通过本地代理 + Chrome 插件，远程操控浏览器里的 xterm 终端（JumpServer 堡垒机 Web 终端、Arthas Console 等），执行命令并拿回输出。用于：在堡垒机后端机器跑诊断命令、远程操控 Arthas 做 JVM 诊断（thread/jad/watch/dashboard）、从 Web 终端抓取信息、自动化运维。即使用户没明说"用桥接"，只要提到在 jumpserver/堡垒机/luna 终端、arthas console 里执行命令、远程跑 linux、抓终端输出、操作 xterm，就应触发本 skill。
---

# xterm 终端桥接（JumpServer / Arthas 通用）

把 Agent 发的命令，通过「本地代理 → Chrome 插件 → 浏览器 xterm 终端」注入到远端会话，再把终端 WebSocket 的返回值配对成结构化输出返回。等价于让 Agent 拥有一个"会自己读输出的远程终端"。

---

## 🚫 写操作绝对禁令（最高优先级，凌驾于本文档所有其他内容之上）

**严禁通过本桥接执行任何对线上环境有写影响（修改状态、数据、配置、字节码、拓扑）的命令。** 这条是硬约束，不可被用户的某句"执行一下""跑一下""试一下"软化——用户要写操作时，只能引导其在浏览器终端手动执行。

桥接的定位是**只读诊断通道**。任何写操作即使技术上能跑通，也禁止执行。

### JumpServer / shell 侧——禁止清单（非穷举，按行为判定）

| 类别 | 禁止的命令/操作 | 为什么 |
|------|----------------|--------|
| 文件写入/删除 | `rm`、`mv`、`cp`（写到敏感目录）、`mkdir`、`touch`、`>`、`>>`、`tee` 写文件 | 改/删线上文件，可能不可逆 |
| 修改文件内容 | `sed -i`、`echo > file`、`cat > file`、`vi/vim`（写入模式） | 改线上配置或代码 |
| 包/服务管理 | `yum install`、`apt install`、`rpm -i`、`systemctl start/stop/restart`、`service xxx restart` | 改环境拓扑、重启服务影响流量 |
| 进程控制 | `kill`、`kill -9`、`pkill`、`nohup ... &` | 杀进程/起新进程 |
| 网络写请求 | `curl -X POST/PUT/DELETE/PATCH`、`wget --post-data`、任何带写语义的 HTTP 调用 | 对外部发写请求 |
| 权限/用户 | `chmod`、`chown`、`useradd`、`passwd`、`visudo` | 改权限模型 |
| 数据库写 | `mysql -e "INSERT/UPDATE/DELETE"`、`redis-cli SET/DEL`、`psql` 写语句 | 直接改业务数据 |
| 重定向到设备 | `> /dev/`、`dd if=` | 可能破坏设备数据 |

**判定原则**：只要命令的副作用是"改变了线上某个状态"——文件、进程、服务、数据、配置、网络资源——一律禁止。拿不准时按禁止处理，告诉用户"这条命令可能对线上有写影响，请你在浏览器终端手动执行"。

**允许的只读命令**（示例）：`cat`、`ls`、`ps`、`df`、`free`、`top`（只读模式）、`netstat`、`ss`、`grep`、`find`（不带 `-delete`）、`head`、`tail`、`less`（只看不编辑）、`curl -X GET`（只读查询接口）、`docker logs/ps/stats/inspect`。

### Arthas 侧——禁止清单

Arthas 的能力不止于读，以下命令/用法一律禁止通过桥接执行：

| 命令 | 禁止原因 |
|------|---------|
| `retransform` | 改线上字节码，可能不可逆（代理已拦截） |
| `profiler` | 长期采样吃 CPU/内存（代理已拦截） |
| `stop` / `reset` | 关闭/重置 Arthas，影响诊断通道本身（代理已拦截） |
| **`ognl`** | 能执行**任意 Java 表达式**，可调用 setter、改静态字段、new 对象触发副作用、甚至改业务状态。`ognl` 默认按写操作处理，禁止执行；确需只读 `ognl` 查值（如读静态字段），须用户明确确认目标表达式是只读的，且不调用任何带副作用的方法 |
| **`vmtool`** | 含 `--action setInstanceField` / `setStaticField` 等写子命令，禁止使用写子命令；只读子命令（`getInstances`、`forceGc` 除外）可用 |
| **`vmoption`** | 能改 JVM 诊断参数。查值（无参或只读）允许；带 `=value` 的写用法禁止 |
| **`logger --level`** | 能动态改日志级别。只查（`logger` 无参）允许；改级别禁止 |
| `tt --replay` / `tt --play` | TimeTunnel 回放会真实重发方法调用，触发业务副作用，禁止 |
| `watch`/`trace`/`stack`/`monitor` 里调用写表达式 | 如 `watch xxx '#obj.setFoo(1)'`，条件表达式里调写方法，禁止 |

**Arthas 命令的默认判定**：若命令语法同时支持读和写（如 `vmoption`、`logger`、`ognl`），**默认视为写操作禁止**，只有当且仅当命令形态确认是只读时才允许。

### 当用户要求写操作时——标准应对

1. **不要执行，也不要"先执行再看看"**。直接拒绝并说明：桥接是只读诊断通道，写操作需手动。
2. 给出明确的手动执行路径：让用户在浏览器里打开对应的终端（JumpServer 终端 / Arthas Console），手动输入命令。
3. 如果命令复杂，把要执行的完整命令文本给用户，方便其复制粘贴。
4. 绝对不要因为"用户很急""用户坚持""命令看起来无害"而软化这条约束。写操作的唯一出口是用户手动执行。

支持两类终端（同一套桥接，自动适配）：

| 终端类型 | 用途 | 命令风格 | 示例 |
|---------|------|---------|------|
| **JumpServer (koko)** | 堡垒机后端 SSH，跑 shell 命令 | linux 命令 | `uname -a`、`ps aux`、`systemctl status nginx` |
| **Arthas Console** | 线上 JVM 诊断 | Arthas 命令 | `thread`、`jad com.foo.Bar`、`watch`、`dashboard` |

## 触发场景

- 用户要在 JumpServer 堡垒机 Web 终端里跑命令并拿结果
- 用户要在 Arthas Console 里做 JVM 诊断（查线程、反编译、watch 方法、看 dashboard）
- 需要远程诊断/巡检后端机器
- 自动化运维：批量在资产上执行命令

## 两种终端的关键差异（重要）

| 维度 | JumpServer (koko) | Arthas Console |
|------|-------------------|----------------|
| 页面形态 | koko connect **iframe**（嵌在 luna 父页里） | **顶层文档**（无 iframe） |
| WebSocket URL | `wss://.../koko/ws/...` | `wss://.../ws?method=connectArthas...` |
| WS 帧格式 | **二进制帧 opcode=2**，payload 是 base64，解码后是 SSH PTY 明文 | **文本帧 opcode=1**，payload 直接是明文 ANSI |
| prompt 样式 | 红帽系 `[root@host /dir]#`；Ubuntu 资产 `user@host:~/path$`（无方括号） | Arthas 风格 `arthas@pid>` 或 `[arthas@...]` |
| prompt 锚点 | 强匹配 `]\s*[#$]\s*$`；无方括号 prompt 走弱兜底（行尾 `$`/`#` + `user@host:` 特征，350ms 静默确认） | `arthas@\S+>\s*$` |
| sudo 检测 | 需要（cat/df 等可能被 alias 成 sudo） | 不适用（Java 诊断工具无 sudo 概念） |

**桥接层已自动处理这些差异**：content script 按是否有 `.xterm` 元素识别终端 frame（不依赖 URL），proxy 按 opcode 自动决定是否 base64 解码，prompt 锚点同时匹配两种风格。Agent 侧调用方式完全一致——都是发 `run` 帧、收 `result` 帧。

## 前置检查（每次用前确认）

```bash
# 1. 代理在跑？端口 8787 应该在 LISTEN
lsof -i:8787 | grep LISTEN

# 2. 没跑就启动（也可从插件 popup 的"启动代理"按钮启动）
cd ~/.terminal-bridge/proxy && node server.js &
```

浏览器侧（任选其一或都开）：
- **JumpServer**：Terminal Bridge 插件已加载 + JumpServer 终端页面已打开 + 已连上一个资产（终端可见、能敲字）
- **Arthas**：Terminal Bridge 插件已加载 + Arthas Console 页面已打开 + 已 Connect 上目标 JVM

多终端场景：如果同时开了 JumpServer 和 Arthas 两个 tab，代理命令只会发给 popup 里"当前选中"的那个 tab。切换用 popup 的 tab 选择器，或让用户在 popup 点选。

如果用户说"命令没反应"或"inject-failed"：
1. `chrome://extensions/` 刷新 Terminal Bridge 插件 ↻
2. 让用户在终端页面按 F5 刷新（让 content script 重新识别 xterm）
3. 让用户在 popup 点"捕捉 xterm"按钮（手动扫描，免刷新）
4. 确认终端 tab 顶部有黄色调试条（说明 CDP 已 attach）

## 调用方式

**核心 API**：连 `ws://127.0.0.1:8787/ssh`，发 `run` 帧，等 `result` 帧。两种终端用法完全一致。

最简方式（用示例客户端）：

```bash
cd ~/.terminal-bridge/proxy

# JumpServer 场景
node client-example.mjs "uname -a"
node client-example.mjs "df -h" 15000              # 第二参数是超时 ms
node client-example.mjs "ps aux | grep java" 20000

# 多层引号场景（kubectl exec / 嵌套引号）：加 --b64 走 base64 通道，
# 命令经 base64 编码下发（echo <b64> | base64 -d | sh），任何一层都不会剥离引号
node client-example.mjs --b64 "kubectl exec -n ns pod -- sh -c 'ps aux | grep java'"

# Arthas 场景
node client-example.mjs "help"
node client-example.mjs "thread"                    # 查看线程概况
node client-example.mjs "jad com.foo.BarService"    # 反编译类
node client-example.mjs "dashboard" 8000            # dashboard 是持续的，给够超时
```

在 Agent 代码里直接调（复制 `proxy/client-example.mjs` 里的 `run()` 函数）：

```js
const result = await run("systemctl status nginx", 15000);
// result = { ok: true, output: "● nginx.service - ...", elapsedMs: 234 }
// 失败时 result.ok === false，result.error 有原因，result.output 可能含部分输出
```

### Arthas 常用命令速查

| 命令 | 用途 | 备注 |
|------|------|------|
| `help` | 列出所有命令 | |
| `dashboard` | JVM 概览（线程/内存/GC/tomcat） | 持续刷新，给够超时（≥8s）或用 `q` 退出 |
| `thread` | 线程列表 | `thread <id>` 看具体线程栈，`thread -b` 找死锁 |
| `jad <类全限定名>` | 反编译类 | 如 `jad com.foo.BarService` |
| `watch <类> <方法> '{params, returnObj}'` | 观察方法入参/返回值 | 方法被调用时才触发 |
| `stack <类> <方法>` | 看方法调用栈 | |
| `trace <类> <方法>` | 方法调用链耗时 | |
| `sc -d <类名>` | 查类加载信息 | |
| `vmoption` | 看 JVM 诊断参数（只读） | 带 `=value` 的写用法禁止，详见「写操作绝对禁令」 |
| `version` | Arthas 版本 | |

**注意**：Arthas 的 `dashboard`、`monitor`、`watch`、`trace` 等命令是**持续运行**的（会一直刷新输出直到按 q 或 Ctrl+C）。这类命令用桥接跑时，要么给够大的超时让它自然输出一段时间后被超时截断（代理会发 Ctrl+C 退出），要么避免使用。一次性命令（`thread`、`jad`、`version`、`vmtool` 等）最稳。

## sudo 自动重试（仅 JumpServer 场景）

部分 JumpServer 后端机器把 `cat`/`df`/`ls` 等命令 alias 成 sudo 版本，普通用户执行时会触发 `[sudo] password for xxx:` 密码提示。代理会**实时检测**这个提示（不等超时），立即返回特殊错误：

```json
{ "ok": false, "error": "sudo-required", "suggest": "sudo su root", "message": "命令触发了 sudo 密码提示...是否切换到 root 后重试？" }
```

**Agent 收到 `error: "sudo-required"` 时，必须按以下流程处理**（不要直接报错给用户）：

1. 用 AskUserQuestion 问用户：`检测到命令需要 sudo 权限（机器上 cat/df 等被 alias 成 sudo 版本）。是否切换到 root 后重试？`
2. 用户**同意** → 先执行 `run("sudo su root")` 切 root（多数 JumpServer 配置 sudo 免密），再**重新执行原命令**
3. 用户**拒绝** → 告知用户"命令需要 root 权限，已跳过"，不要反复尝试

参考实现见 `proxy/client-example.mjs` 的 `runWithSudoRetry()` 函数。Agent 用 Bash 跑 `node client-example.mjs "cmd"` 时自带这个流程（控制台 readline 提问）；Agent 自己发 ws 请求时要自行实现等价逻辑。

注意：切 root 后整个 SSH 会话都变成 root，后续命令也在 root 下执行。如果用户不想长期 root，需要重新连接终端。

（Arthas 场景不会触发 sudo 检测——Java 诊断工具无 sudo 概念。）

## Arthas 安全基线（重要，保护线上 JVM）

Arthas 直接挂在线上 JVM 上，命令不当会拖垮服务。代理内置了安全基线（`proxy/arthas-guard.js`），按风险分级自动拦截 Arthas 命令。**Agent 必须理解三级风险和对应的处理流程。**

### 风险分级

| 等级 | 命令 | 风险点 | 代理行为 |
|------|------|--------|---------|
| 🟢 安全 | `help` `version` `pwd` `session` `sysenv` `sysprop` `jvm` `memory` `mbean` `dashboard` `options` `history` `perfcounter` | 只读，无字节码增强 | 放行 |
| 🟡 低风险 | `thread` `sc` `sm` `jad` `getstatic` `classloader` `cat` `echo` `grep` `tee` `base64` | 一次性查询，增强完即释放 | 放行 |
| 🟠 中风险 | `watch` `trace` `stack` `monitor` `vmtool` `tt` `vmoption` `logger` `ognl` | **字节码增强 / 或语法同时支持读写**，误用会改状态或持续产生开销 | `watch/trace/stack/monitor` 未带 `-n`/`#cost` → 自动补 `-n 1`；`vmtool/tt/vmoption/logger/ognl` 的写子命令或写表达式**禁止执行**（见「写操作绝对禁令」），只读形态可用 |
| 🔴 高风险 | `retransform` `profiler` `stop` `reset` | 改字节码可能不可逆 / 长期采样吃资源 / 关闭服务 | **无条件禁用**，让用户去浏览器手动执行 |

### Agent 处理流程（收到 Arthas 相关 error 时）

#### 收到 `error: "arthas-forbidden"`（高风险命令被禁用）

**这类命令通过桥接一律禁用，不要尝试绕过。** 处理方式：

1. 把 `message` 字段的内容告知用户，说明为什么禁用
2. 把 `suggest` 字段作为替代方案告诉用户——通常替代方案是"去浏览器 Arthas 终端手动执行"
3. **不要重试，不要尝试加参数绕过**——代理层无条件拒绝

高风险命令禁用清单及替代方案：
- `retransform`（改字节码）→ 用 `jad` 只读查看；确需改字节码去浏览器手动执行
- `profiler`（火焰图采样）→ 用 `thread`/`memory`/`jvm` 查概况；确需火焰图去浏览器手动执行（带 `-d` 限时）
- `stop`（关闭 arthas）→ 关闭浏览器页面即可断开，不需要 stop
- `reset`（重置增强）→ 去浏览器手动执行（建议只 reset 特定类）

#### 收到 `error: "arthas-needs-limit"`（严格模式下中风险命令缺限制）

默认模式（`ARTHAS_AUTO_PATCH=1`）下不会出现这个错误——代理会自动补 `-n 1`。只在严格模式（`ARTHAS_AUTO_PATCH=0`）下出现。处理：按 `suggest` 字段补参数后重发。

#### 收到 `error: "arthas-quota-exceeded"`（中风险命令会话超限）

中风险命令有会话级计数（默认 20 次/代理进程）。超限后拒绝，告知用户"为保护线上服务，中风险命令已达上限，如需继续请重启代理"。**不要反复重试。**

### Arthas 命令使用最佳实践（即使代理放行，Agent 也应遵守）

1. **中风险命令务必带频率限制**：`trace`/`watch`/`stack`/`monitor` 加 `-n 1`（只采样一次）或 `'#cost>100'`（只看慢调用）。代理会自动补 `-n 1`，但 Agent 自己构造命令时最好显式带上。
2. **避免高频方法上裸跑 trace**：QPS 上千的接口，即使 `-n 1` 也会拦截每一次调用直到命中。优先用 `#cost` 过滤。
3. **profiler / retransform 已禁用**：这两个命令通过桥接一律拒绝。需要火焰图或热更新字节码时，让用户去浏览器 Arthas 终端手动执行（profiler 务必带 `-d` 限时，retransform 前先 `jad` 确认）。
4. **retransform 前先 jad 确认**：（在浏览器手动执行时）retransform 不可逆，先 `jad <类>` 看当前字节码，本地改好编译确认后再 retransform。
5. **避免 dashboard/monitor 做"持续监控"**：它们持续刷新，桥接模式下会一直等到超时被 Ctrl+C 截断。要监控指标用 `thread`、`memory`、`jvm` 这类一次性命令替代。

### 环境变量调参（代理启动时）

| 变量 | 默认 | 说明 |
|------|------|------|
| `ARTHAS_MAX_MEDIUM` | 20 | 中风险命令会话内最大次数 |
| `ARTHAS_AUTO_PATCH` | 1 | 中风险命令缺限制时：1=自动补 `-n 1`，0=拒绝让 Agent 显式补 |

## 消息格式

Agent → 代理：
```json
{ "type": "run", "reqId": "<任意唯一 id>", "cmd": "<命令>", "timeoutMs": 10000 }
```
（reqId 可省略，代理会生成）

代理 → Agent：
```json
{ "type": "result", "reqId": "...", "ok": true, "output": "纯文本输出（ANSI 已清理）", "elapsedMs": 234 }
```

详见 `references/protocol.md`。

## 关键约定与陷阱

1. **命令是发到真实会话**——有副作用。**严禁执行任何对线上有写影响的命令**，详见文首「🚫 写操作绝对禁令」。JumpServer 的 `rm -rf`、`reboot`、`sed -i`、`systemctl restart`；Arthas 的 `retransform`、`stop`、`ognl`（写表达式）、`tt --replay` 等一律禁止通过桥接执行，只能引导用户在浏览器终端手动操作。只读诊断是桥接的唯一用途。
2. **默认超时 10s**。长命令（`find /`、`yum update`、Arthas 的 `dashboard`）必须显式调大 `timeoutMs`，否则会被截断成 `ok:false error:timeout`。
3. **串行执行**：代理做了队列，同一时刻只跑一条命令。连发多条会排队，不会交错污染输出。
4. **输出已做清理**：ANSI 颜色/光标序列、prompt 行、命令回显行都已去掉，`\r\n` 转成 `\n`。可能残留少量 kitty 终端逐字符输入的重绘碎片（不影响理解输出）。
5. **完成判定靠 prompt 锚点**：代理发 cmd 后，在 WebSocket 返回流里等 prompt 再次出现即视为完成。JumpServer 等的是 shell prompt（`[user@host /cwd]#`），Arthas 等的是 `>` 结尾的 prompt。
6. **交互式命令不适用**：vim、less、top、Arthas 的持续刷新命令（dashboard/monitor）、`sudo`（需密码时）会卡住终端等待输入，prompt 永远不出现 → 超时。**超时时代理会自动发 Ctrl+C 复位终端**，避免下一条命令被当成输入。
7. **多终端切换**：同时开 JumpServer 和 Arthas 时，命令只发给 popup 选中的 tab。让用户在 popup 点选目标 tab。
8. **sudo 别名劫持（仅 JumpServer，自动处理）**：部分机器把 `cat`/`df`/`ls` 等 alias 成 sudo 版本，会触发密码提示。代理会自动检测并返回 `sudo-required` 错误，Agent 应按"sudo 自动重试"流程问用户是否切 root。

## 排错速查

| 现象 | 原因 | 处理 |
|------|------|------|
| `error: extension not connected` | 代理没收到插件 hello | 检查插件是否启用、service worker 日志、代理是否在跑 |
| `error: sudo-required` | 命令触发 sudo 密码提示（alias 劫持，仅 JumpServer） | 按"sudo 自动重试"流程问用户是否切 root，确认后切 root 重发原命令 |
| `error: arthas-forbidden` | Arthas 高风险命令（retransform/profiler/stop/reset）被禁用 | 告知用户去浏览器 Arthas 终端手动执行，不要重试或绕过 |
| `error: arthas-needs-limit` | 中风险命令（trace/watch/stack/monitor）缺 -n/#cost（严格模式） | 按 suggest 补参数重发，或加 `-n 1` |
| `error: arthas-quota-exceeded` | 中风险命令会话内超限（默认 20 次） | 告知用户已达上限，不要重试；如需继续重启代理 |
| `error: unterminated-quote` | 命令含未闭合引号，远端 shell 卡在 PS2 续行（已自动 Ctrl+C 退出） | 检查引号配对；多层引号场景改用 `--b64` 通道重发 |
| 输出末尾带 `[warning] output filtered to empty...` | 清理器把输出过滤为空，兜底返回了原始内容（截断） | 输出可用但含终端噪音；原命令输出被判定为 prompt 噪音时可调整命令（如拆行） |
| `error: timeout` + output 含 `[sudo] password` | 旧版代理未实现 sudo 检测 | 升级 proxy/server.js；临时用绝对路径 `/bin/cat` 绕过 |
| `error: timeout` + output 为空 | 命令是交互式/持续刷新（vim/dashboard/monitor） | 改用非交互等价命令，或 Arthas 用一次性命令（thread/jad） |
| 命令发出去但 Arthas/JumpServer 没反应 | content script 没识别到 xterm | 让用户 F5 刷新终端页，或在 popup 点"捕捉 xterm" |
| 输出含少量碎片行 | kitty 终端重绘残留（JumpServer） | 不影响 Agent 理解，可忽略 |
| 一直 `extension not connected` | 端口被占（dailytest 也用 8787） | `lsof -i:8787` 查冲突，停掉另一个 |

## 实测协议结论

经探针验证：

- **koko（JumpServer）**：WebSocket 走**二进制帧（opcode=2）**，CDP 返回的 payloadData 是 **base64 编码**，解码后是明文终端流（含 ANSI、SSH PTY 文本）。代理已自动 base64 解码。
- **Arthas Console**：WebSocket 走**文本帧（opcode=1）**，payloadData 直接是明文 ANSI，无需解码。

代理按 opcode 自动决定是否解码（opcode=2 解 base64，opcode=1 直接用），两种终端透明兼容。详见 `references/protocol.md`。
