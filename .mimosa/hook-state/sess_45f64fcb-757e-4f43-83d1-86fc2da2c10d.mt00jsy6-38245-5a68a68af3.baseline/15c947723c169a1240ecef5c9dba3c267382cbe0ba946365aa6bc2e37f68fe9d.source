// Terminal Bridge - content script (ISOLATED world).
//
// 注：manifest 用 matches: <all_urls> + all_frames:true + run_at:document_start
// 注入，是为了确保能进终端 frame（koko connect iframe / Arthas console 顶层文档等）。
//
// 时序问题：脚本在 document_start 运行，此时 .xterm 元素还没渲染出来
// （koko 的 xterm 在 iframe 加载后渲染，Arthas 的 xterm 要等 Vue 应用挂载）。
// 所以不能在 document_start 立即判断"是不是终端 frame"然后 return——
// 那样所有终端 frame 都会被错过。
//
// 正确做法：所有 frame 都注册一个轻量 MutationObserver 等 .xterm 出现；
// 出现了才真正激活（上报 ready + 注册消息监听）。.xterm 永远不出现的 frame，
// observer 只监听 documentElement 的 childList，开销可忽略。

(function () {
  const TAG = "[terminal-bridge-cs]";

  if (window.__terminalBridgeContentLoaded) return;
  window.__terminalBridgeContentLoaded = true;

  // ---------- xterm 定位 ----------
  function findXtermTextarea() {
    const xtermEl = document.querySelector(".xterm");
    if (!xtermEl) return null;
    return xtermEl.querySelector("textarea") || null;
  }

  // 终端就绪后只上报一次，让 background 知道这个 frame 可以接命令了
  let readyReported = false;
  function reportReady() {
    if (readyReported) return;
    readyReported = true;
    try {
      chrome.runtime.sendMessage({
        type: "term-ready",
        payload: { href: location.href, frame: "terminal" }
      });
    } catch {}
    console.log(TAG, "terminal ready at", location.href);
  }

  // ---------- 等待 .xterm 出现，出现后才激活 ----------
  // 激活前：只挂这个 observer，不注册 onMessage（避免非终端 frame 白跑监听）。
  // 激活后：注销 observer，注册 onMessage，上报 ready。
  let activated = false;
  function tryActivate() {
    if (activated) return;
    if (!findXtermTextarea()) return;  // .xterm 还没出现，或出现了但 textarea 还没有
    activated = true;
    if (mo) mo.disconnect();
    console.log(TAG, "terminal frame 激活 at", location.href);
    activateTerminal();
    reportReady();
  }

  const mo = new MutationObserver(tryActivate);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // 立即检查一次（万一 .xterm 已经在 DOM 里了——比如脚本注入晚了）
  tryActivate();

  // ---------- term-ping 探测（始终响应，激活前也要能被 ping 到）----------
  // background 的 scanAllTabs 和 injectToXterm 降级路径都靠 term-ping 找终端 frame。
  // 所以这个监听器必须在脚本一加载就注册，不能等 .xterm 出现。
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "term-ping") return;
    sendResponse({
      ok: true,
      ready: !!findXtermTextarea(),
      href: location.href
    });
    return true;
  });

  // ---------- 终端激活后才注册的逻辑 ----------
  function activateTerminal() {
  // 性能优化：批量注入而非逐字符。
  // 之前逐字符 dispatch（每个字符一次 InputEvent），命令文本越长越慢。
  // 现在：把整段文本一次性塞进 textarea.value，只派发一次 input 事件，
  // xterm 会一次性处理整段文本（类似快速输入），大幅减少往返次数。
  // 末尾的 \r 单独用 Enter keydown 触发执行。
  function dispatchInput(text) {
    const ta = findXtermTextarea();
    if (!ta) return false;
    ta.focus();

    // 分离末尾的回车（\r 或 \n），单独处理
    let body = text;
    let trailingCr = "";
    if (text.endsWith("\r")) { body = text.slice(0, -1); trailingCr = "\r"; }
    else if (text.endsWith("\n")) { body = text.slice(0, -1); trailingCr = "\n"; }

    // 批量注入命令文本（一次性）
    if (body.length > 0) {
      ta.value = body;
      ta.dispatchEvent(new InputEvent("input", {
        inputType: "insertText",
        data: body,
        bubbles: true,
        cancelable: true
      }));
    }

    // 末尾回车单独派发，触发命令执行
    if (trailingCr) {
      ta.value = "";
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        charCode: 0,
        bubbles: true,
        cancelable: true
      }));
    }
    return true;
  }

  // ---------- 接收 background 的注入命令 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "term-write") return;
    // background 转发来的注入请求：{ type, text, reqId }
    // 如果这个 frame 没有 xterm（比如终端还没加载好），明确返回 no-xterm
    const ta = findXtermTextarea();
    if (!ta) {
      sendResponse({ ok: false, reason: "no-xterm", reqId: msg.reqId });
      return true;
    }
    const ok = dispatchInput(msg.text || "");
    sendResponse({ ok, reqId: msg.reqId });
    return true;
  });
  }  // end activateTerminal
})();
