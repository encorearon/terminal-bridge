// JumpServer 终端桥接 - background service worker
//
// 职责：桥接本地代理和 JumpServer 页面的 xterm 终端。
//   - 代理下发命令 → 转发给 activeTabId 的 content script 注入 xterm
//   - CDP 抓到 activeTabId 的 WS recv 帧 → 回传给代理做请求-响应配对
//   - native messaging：让 popup 能启动/停止本地代理
//
// 代理连接：ws://127.0.0.1:8787/ssh（断线 2s 重连）
// content script：在 koko connect iframe 里运行（见 manifest content_scripts）

// ================= 状态 =================
const attached = {};  // 标记哪些 tab 当前已 attach debugger
const BRIDGE_WS = "ws://127.0.0.1:8787/ssh";
let bridgeWs = null;
let bridgeConnected = false;
const termReadyTabs = new Set();  // 哪些 tab 的 content script 上报了 term-ready
const termReadyFrames = new Map(); // tabId -> frameId（终端所在的 frame，注入时直接用）
let activeTabId = null;           // 当前激活的终端 tab（命令只发它，WS 帧只收它的）

// ============== 消息处理（来自 popup / content script）==============
// 注意：listener 不能是 async——async 函数返回 Promise 而非 true，
// Chrome 会在 listener 返回后立即关闭消息通道，导致异步 sendResponse 失效。
// 需要异步处理的分支必须 return true（同步），在内部 then/catch 里调 sendResponse。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // --- 来自 content script 的上报 ---
  if (msg.type === "term-ready") {
    // term-ready 不需要异步，直接同步处理
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      termReadyTabs.add(tabId);
      // 记下终端所在的 frameId，injectToXterm 直接用它（不用再按 URL 找）
      const frameId = sender.frameId;
      if (frameId != null) termReadyFrames.set(tabId, frameId);
      console.log("[bg] term-ready from tab", tabId, "frame", frameId, msg.payload && msg.payload.href);
      attachDebugger(tabId);
      if (activeTabId === null) {
        activeTabId = tabId;
        console.log("[bg] 自动设置 activeTabId =", tabId);
      }
    }
    sendResponse({ ok: true });
    return false;  // 同步，不需要保持通道
  }

  // --- 来自 popup 的代理控制（native messaging）---
  if (msg.type === "PROXY_START" || msg.type === "PROXY_STOP" || msg.type === "PROXY_STATUS") {
    const cmd = msg.type === "PROXY_START" ? "start" :
                msg.type === "PROXY_STOP" ? "stop" : "status";
    sendNative({ cmd }).then(sendResponse);
    return true;  // 保持通道直到 sendResponse 被调用
  }

  // --- 来自 popup 的 xterm 状态查询（需要异步查 tab 标题）---
  if (msg.type === "XTERM_STATUS") {
    buildXtermStatus().then(sendResponse);
    return true;
  }

  // --- 来自 popup 的切换激活 tab ---
  if (msg.type === "XTERM_SELECT") {
    const tabId = msg.tabId;
    if (termReadyTabs.has(tabId)) {
      activeTabId = tabId;
      console.log("[bg] 切换 activeTabId =", tabId);
      sendResponse({ ok: true, activeTabId: tabId });
    } else {
      sendResponse({ ok: false, msg: "该 tab 未捕获 xterm" });
    }
    return false;
  }

  // --- 来自 popup 的手动扫描 xterm ---
  if (msg.type === "XTERM_SCAN") {
    scanAllTabsForXterm().then((res) => {
      if (activeTabId === null && res.found > 0) {
        activeTabId = res.tabs[0].tabId;
        console.log("[bg] 扫描后自动设置 activeTabId =", activeTabId);
      }
      sendResponse(res);
    });
    return true;
  }

  return false;
});

// 构建 xterm 状态响应（异步，因为要查 tab 标题）
async function buildXtermStatus() {
  // 查当前浏览器激活的 tab（用户正在看的那个），用于在 popup 里标注"当前窗口"
  let currentTabId = null;
  try {
    const [ct] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (ct) currentTabId = ct.id;
  } catch {}

  const tabsInfo = [];
  for (const tabId of termReadyTabs) {
    let title = String(tabId);
    let url = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      title = tab.title || tab.url || String(tabId);
      url = tab.url || "";
    } catch {}
    tabsInfo.push({
      tabId,
      title: title.slice(0, 40),
      host: hostFromUrl(url),
      active: tabId === activeTabId,           // 桥接选中的 tab（命令发到这个）
      isCurrent: tabId === currentTabId,       // 用户当前正在看的浏览器 tab
    });
  }
  return {
    ok: true,
    ready: termReadyTabs.size > 0,
    tabCount: termReadyTabs.size,
    activeTabId,
    attachedCount: Object.keys(attached).filter(k => attached[k]).length,
    tabs: tabsInfo
  };
}

// 从 URL 提取 host（用于 tab 列表区分同名终端）
function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return "";
  }
}

// ============== Native Messaging（启动/停止代理）==============
const NATIVE_HOST = "com.wssniffer.host";

// 通过 native messaging 发消息给 host，返回 host 的响应
function sendNative(msg) {
  return new Promise((resolve) => {
    console.log("[bg] sendNative:", JSON.stringify(msg), "→ host:", NATIVE_HOST);
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
      console.log("[bg] connectNative 成功");
    } catch (err) {
      console.error("[bg] connectNative 抛异常:", err.message || err);
      resolve({ ok: false, msg: "无法连接 native host: " + (err.message || err) +
        "。请运行 native/install.sh 安装。" });
      return;
    }

    let resolved = false;
    const done = (res) => {
      if (resolved) return;
      resolved = true;
      console.log("[bg] native 响应:", JSON.stringify(res));
      try { port.disconnect(); } catch {}
      resolve(res);
    };

    port.onMessage.addListener((response) => {
      done(response);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (!resolved) {
        console.error("[bg] native 断开, lastError:", err);
        done({ ok: false, msg: err ? err.message : "native host 连接失败（可能未安装或权限不足）" });
      }
    });
    setTimeout(() => done({ ok: false, msg: "native host 响应超时" }), 8000);

    try {
      port.postMessage(msg);
      console.log("[bg] postMessage 已发送");
    } catch (err) {
      console.error("[bg] postMessage 失败:", err.message);
      done({ ok: false, msg: "postMessage 失败: " + err.message });
    }
  });
}


// ============== Debugger attach / detach（原有）==============
function attachDebugger(tabId) {
  if (attached[tabId]) return;
  chrome.debugger.attach({ tabId }, '1.3', () => {
    if (chrome.runtime.lastError) {
      console.error('[WS] attach 失败:', chrome.runtime.lastError.message);
      return;
    }
    attached[tabId] = true;
    chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, () => {
      console.log('[WS] 已 attach tab', tabId, '并开启 Network');
    });
  });
}

// ============== CDP 事件监听 ==============
// 抓 activeTabId 的 WebSocket 帧，发给代理做请求-响应配对。
// 这是 bridge 的核心数据来源——代理靠这些帧判断命令何时完成。
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  const isActive = tabId === activeTabId;

  if (method === 'Network.webSocketCreated') {
    if (isActive) {
      console.log('[WS] 新连接:', params.url, '(active tab', tabId, ')');
      sendToBridge({ type: 'ws-open', payload: { url: params.url, requestId: params.requestId } });
    }
  }
  else if (method === 'Network.webSocketFrameReceived') {
    // recv 帧是命令输出，只有 activeTabId 的才上送给代理配对
    if (isActive) {
      sendToBridge({
        type: 'ws-recv',
        payload: {
          data: extractPayloadData(params.response),
          opcode: params.response && params.response.opcode,
          t: Date.now()
        }
      });
    }
  }
  else if (method === 'Network.webSocketFrameSent') {
    if (isActive) {
      sendToBridge({
        type: 'ws-send',
        payload: {
          data: extractPayloadData(params.response),
          opcode: params.response && params.response.opcode,
          t: Date.now()
        }
      });
    }
  }
  else if (method === 'Network.webSocketClosed') {
    if (isActive) sendToBridge({ type: 'ws-close', payload: { requestId: params.requestId } });
  }
  else if (method === 'Network.webSocketFrameError') {
    console.error('[WS] 帧错误:', params.errorMessage);
  }
});

// 提取 CDP frame 的 payloadData
// 文本帧(opcode=1)是 string；二进制帧(opcode=2)是 base64 string。代理按 opcode 解析。
function extractPayloadData(response) {
  if (!response) return "";
  return response.payloadData || "";
}

// ============== 本地代理连接 ==============
function connectBridge() {
  if (bridgeWs && (bridgeWs.readyState === WebSocket.OPEN ||
                   bridgeWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    bridgeWs = new WebSocket(BRIDGE_WS);
  } catch (err) {
    console.warn("[bg] 无法连接代理:", err.message);
    setTimeout(connectBridge, 2000);
    return;
  }

  bridgeWs.addEventListener("open", () => {
    bridgeConnected = true;
    console.log("[bg] 已连上本地代理", BRIDGE_WS);
    sendToBridge({ type: "hello", payload: { role: "extension" } });
  });

  bridgeWs.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (!frame) return;
    handleBridgeCommand(frame);
  });

  bridgeWs.addEventListener("close", () => {
    bridgeConnected = false;
    bridgeWs = null;
    console.log("[bg] 代理连接断开，2s 后重连");
    setTimeout(connectBridge, 2000);
  });

  bridgeWs.addEventListener("error", () => {});
}

// ============== 手动扫描 xterm（popup 触发）==============
// 遍历所有 tab 的所有 frame，发 term-ping 探测有没有 xterm。
// 关键：reload 插件后已打开的页面里没有 content script，ping 无人响应。
// 所以 ping 失败时用 chrome.scripting 主动注入 content.js，再 ping 一次。
// 这样用户 reload 插件后不用刷新页面，点「捕捉终端」就能自动恢复。
async function scanAllTabsForXterm() {
  const tabs = await chrome.tabs.query({});
  let found = 0;
  const foundTabs = [];

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    // 跳过 chrome:// 等内部页面
    if (!/^https?:/.test(tab.url)) continue;

    // 列出该 tab 所有 frame
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    } catch { continue; }
    if (!frames) continue;

    for (const frame of frames) {
      // 第一次 ping（content script 可能已经在跑）
      let res = await pingFrame(tab.id, frame.frameId);

      // ping 失败：content script 没注入（reload 插件后常见）→ 主动注入再 ping
      if (!res) {
        console.log("[bg] ping 失败，尝试注入 content.js 到 tab", tab.id, "frame", frame.frameId);
        await injectContentScript(tab.id, frame.frameId);
        // 注入后等一下让 IIFE 执行 + term-ping 监听器注册
        await new Promise(r => setTimeout(r, 200));
        res = await pingFrame(tab.id, frame.frameId);
      }

      if (res && res.ready) {
        found++;
        termReadyTabs.add(tab.id);
        termReadyFrames.set(tab.id, frame.frameId);
        foundTabs.push({ tabId: tab.id, href: res.href });
        console.log("[bg] 扫描发现 xterm: tab", tab.id, "frame", frame.frameId, res.href);
        attachDebugger(tab.id);
        break;  // 一个 tab 找到一个就够
      }
    }
  }

  return {
    ok: true,
    found,
    tabs: foundTabs,
    ready: termReadyTabs.size > 0,
    tabCount: termReadyTabs.size
  };
}

// 向指定 frame 发 term-ping
function pingFrame(tabId, frameId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: "term-ping" },
        { frameId },
        (r) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        }
      );
    } catch { resolve(null); }
  });
}

// 用 chrome.scripting 主动注入 content.js 到指定 frame
// 解决 reload 插件后已打开页面没有 content script 的问题
async function injectContentScript(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["content.js"],
    });
    return true;
  } catch (err) {
    // 有些 frame（如 about:blank）注入会失败，忽略
    console.log("[bg] 注入 content.js 失败 tab", tabId, "frame", frameId, ":", err.message);
    return false;
  }
}

function sendToBridge(obj) {
  if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
    try { bridgeWs.send(JSON.stringify(obj)); } catch {}
  }
}

// 处理代理下发的命令
function handleBridgeCommand(frame) {
  // { type: "run-cmd", text, reqId }
  // 代理已经把命令包成 `cmd; printf 哨兵\r`，我们只需把 text 注入 xterm
  if (frame.type === "run-cmd") {
    injectToXterm(frame.text, frame.reqId);
    return;
  }

  // { type: "ping" }
  if (frame.type === "ping") {
    sendToBridge({ type: "pong", payload: { readyTabs: [...termReadyTabs] } });
    return;
  }
}

// 把命令注入到 activeTabId 的终端 frame。
// 多终端场景下只注入用户选中的 tab，避免串扰。
//
// frame 定位策略（从快到慢）：
//   1. 优先用 termReadyFrames 里记下的 frameId（term-ready 上报时存的，最准）
//   2. 降级：逐 frame 发 term-ping 探测哪个有 xterm（覆盖 term-ready 没存上的情况，
//      比如 Arthas 页面是顶层文档不是 iframe，frameId=0）
async function injectToXterm(text, reqId) {
  const tabId = activeTabId;

  if (tabId === null) {
    sendToBridge({
      type: "inject-failed",
      payload: { reqId, error: "no active tab selected; use '捕捉 xterm' in popup" }
    });
    return;
  }

  // 策略 1：用记下的 frameId
  let targetFrameId = termReadyFrames.get(tabId);
  let ok = false;

  if (targetFrameId != null) {
    ok = await sendToFrame(tabId, targetFrameId, text, reqId);
  }

  // 策略 2：降级探测。targetFrameId 没存上，或投递失败（frame 可能已刷新），
  // 就遍历所有 frame 找有 xterm 的那个。
  if (!ok) {
    const frames = await getAllFramesSafe(tabId);
    if (!frames) {
      sendToBridge({
        type: "inject-failed",
        payload: { reqId, error: `cannot list frames for tab ${tabId}` }
      });
      return;
    }

    // 第一轮：ping 现有 content script
    for (const frame of frames) {
      const r = await sendToFrame(tabId, frame.frameId, text, reqId, true /*pingOnly*/);
      if (r) {
        targetFrameId = frame.frameId;
        termReadyFrames.set(tabId, targetFrameId);
        ok = await sendToFrame(tabId, targetFrameId, text, reqId);
        break;
      }
    }

    // 第二轮：第一轮全失败说明 content script 没注入（reload 插件后常见）
    // 主动注入 content.js 到每个 frame，再 ping + 注入
    if (!ok) {
      console.log("[bg] 降级探测全失败，尝试主动注入 content.js");
      for (const frame of frames) {
        await injectContentScript(tabId, frame.frameId);
      }
      await new Promise(r => setTimeout(r, 200));  // 等 IIFE 执行
      for (const frame of frames) {
        const r = await sendToFrame(tabId, frame.frameId, text, reqId, true /*pingOnly*/);
        if (r) {
          targetFrameId = frame.frameId;
          termReadyFrames.set(tabId, targetFrameId);
          ok = await sendToFrame(tabId, targetFrameId, text, reqId);
          break;
        }
      }
    }
  }

  if (ok) {
    console.log("[bg] 注入成功 tab", tabId, "frame", targetFrameId, "reqId", reqId);
  } else {
    sendToBridge({
      type: "inject-failed",
      payload: { reqId, error: "no terminal frame with xterm in active tab" }
    });
  }
}

// 向指定 frame 发消息。pingOnly=true 时只探测不注入（用 term-ping 问有没有 xterm）。
// 返回：pingOnly 时返回 boolean（是否 ready）；注入时返回 boolean（是否成功）。
function sendToFrame(tabId, frameId, text, reqId, pingOnly = false) {
  const payload = pingOnly
    ? { type: "term-ping" }
    : { type: "term-write", text, reqId };
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, payload, { frameId }, (res) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        if (pingOnly) resolve(!!(res && res.ready));
        else resolve(!!(res && res.ok));
      });
    } catch {
      resolve(false);
    }
  });
}

// 包装 chrome.webNavigation.getAllFrames 成 Promise，失败/无权限返回 null
function getAllFramesSafe(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(frames || []);
      });
    } catch {
      resolve(null);
    }
  });
}

// ============== 页面刷新/关闭处理 ==============
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // 刷新后 content script 重新加载，清掉旧的 ready 标记，等它重新上报
  if (change.status === 'loading') {
    termReadyTabs.delete(tabId);
    termReadyFrames.delete(tabId);
    // 刷新的是 activeTabId 就清空（重新上报后会自动重新选）
    if (activeTabId === tabId) activeTabId = null;
  }
  // 页面刷新完成后，如果之前 attach 过这个 tab，重新 attach
  // （CDP attach 在页面刷新后会失效）
  if (change.status === 'complete' && attached[tabId]) {
    delete attached[tabId];
    setTimeout(() => attachDebugger(tabId), 500);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete attached[tabId];
  termReadyTabs.delete(tabId);
  termReadyFrames.delete(tabId);
  // 关闭的是 activeTabId 就清空，让下次自动选或用户重选
  if (activeTabId === tabId) {
    activeTabId = null;
    // 如果还有其他终端 tab，自动选一个
    if (termReadyTabs.size > 0) {
      activeTabId = [...termReadyTabs][0];
      console.log("[bg] activeTabId 关闭，自动切换到", activeTabId);
    }
  }
});

// ============== Service Worker 保活（新增）==============
// MV3 SW 会被 Chrome 休眠。代理连接和 CDP 事件会唤醒它，但保险起见
// 用 alarms 周期性检查连接。
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!bridgeWs || bridgeWs.readyState === WebSocket.CLOSED) {
    connectBridge();
  }
});

// ============== 启动 ==============
connectBridge();
console.log('[Terminal Bridge] background 已启动');
