// Terminal Bridge - Yearning SQL 平台自动化 content script (ISOLATED world)
//
// 只在 Yearning（sql.meiyunji.net）页面工作。配合 background 的 tap 模式：
//   Agent → 代理 → background → 本脚本：注入 SQL 到编辑器、点「查询」按钮
//   查询结果通过 tap 通道（WS 帧）回到 Agent
//
// 消息（均由 background 转发，frameId=0 顶层文档）：
//   yr-ping        探测编辑器类型和查询按钮，返回结构化信息
//   yr-sql-set     {sql} 注入 SQL（按探测到的编辑器类型选策略）
//   yr-query-click 找「查询」按钮并点击

(function () {
  const TAG = "[terminal-bridge-yr]";
  if (window.__terminalBridgeYearning) return;
  window.__terminalBridgeYearning = true;

  // ---------- MAIN world 桥（CodeMirror/monaco API 只在页面上下文可达）----------
  let mainMsgId = 0;
  const mainWaiters = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "tb-yr-main") return;
    const waiter = mainWaiters.get(msg.id);
    if (waiter) {
      mainWaiters.delete(msg.id);
      waiter(msg);
    }
  });

  function callMain(kind, payload, timeoutMs = 300) {
    return new Promise((resolve) => {
      const id = ++mainMsgId;
      const timer = setTimeout(() => {
        mainWaiters.delete(id);
        resolve(null);  // 超时 = MAIN world 没装或没处理
      }, timeoutMs);
      mainWaiters.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      window.postMessage({ source: "tb-yr-iso", id, kind, ...payload }, "*");
    });
  }

  // ---------- 编辑器探测 ----------
  async function detectEditor() {
    const info = {
      url: location.href,
      codeMirrorDom: !!document.querySelector(".CodeMirror"),
      monacoDom: !!document.querySelector(".monaco-editor"),
      mainWorld: null,
      textareas: [],
      contentEditables: [],
    };
    const main = await callMain("detect", {}, 200);
    info.mainWorld = main ? main.editors : "unreachable";
    document.querySelectorAll("textarea").forEach((ta, i) => {
      if (i < 5) info.textareas.push({
        cls: (ta.className || "").slice(0, 60),
        placeholder: (ta.placeholder || "").slice(0, 40),
        visible: ta.offsetParent !== null,
      });
    });
    document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
      if (i < 5) info.contentEditables.push({
        tag: el.tagName,
        cls: (el.className || "").slice(0, 60),
        visible: el.offsetParent !== null,
      });
    });
    return info;
  }

  // ---------- 数据库/数据源元信息 ----------
  // 三层读取策略：
  //   1. 数据库（所选库）：精确 XPath（form 下 div[2]/div[2] 的选择器文本）——
  //      未选库时查询会报错，必须准确知道
  //   2. 数据源：URL hash 的 source/idc 参数（#/apply/query?source=xxx&idc=xxx）
  //   3. 兜底：整个 form 的 input/select 值启发式
  const FORM_XPATH = "/html/body/div[1]/div/section/section/div[2]/main/div/div/div[2]/div[2]/div/div/div/div/div[2]/div/div[1]/div/div[2]/div/div/div/form";
  const DATABASE_XPATH = FORM_XPATH + "/div[2]/div[2]/div/div/div";

  function xpathNode(path) {
    try { return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; }
  }

  function readYearningMeta() {
    let database = "";
    let dataSource = "";

    // 1. 所选数据库：精确 XPath 读取（antd Select 的显示文本）
    const dbNode = xpathNode(DATABASE_XPATH);
    if (dbNode) {
      const dbText = (dbNode.textContent || "").trim();
      // Select 未选择时 antd 显示 placeholder（"请选择..."），排除
      if (dbText && !/请选择|placeholder/i.test(dbText)) database = dbText;
    }

    // 2. 数据源：URL hash
    try {
      const h = location.hash.replace(/^#/, "");
      const q = new URLSearchParams(h.split("?")[1] || "");
      dataSource = q.get("source") || "";
      const idc = q.get("idc") || "";
      if (idc && idc !== dataSource) dataSource = dataSource ? `${dataSource} · ${idc}` : idc;
    } catch {}

    // 3. 兜底：form 启发式
    if (!database || !dataSource) {
      const form = document.querySelector("form") || xpathNode(FORM_XPATH);
      if (form) {
        const values = [];
        form.querySelectorAll("input, select").forEach(el => {
          if (el.offsetParent === null) return;
          const value = el.tagName === "SELECT" ? el.options[el.selectedIndex]?.textContent : el.value;
          if (value?.trim()) values.push(value.trim());
        });
        const unique = [...new Set(values)].filter(v => !/^(查询|执行|取消|确定|SQL)$/i.test(v));
        if (!dataSource) dataSource = unique.find(v => /source|实例|数据源|tdsql|mysql|prod|test/i.test(v)) || "";
        if (!database) database = unique.find(v => /database|db|库|schema/i.test(v)) || "";
      }
    }

    const label = [dataSource, database].filter(Boolean).join(" · ")
      || [database, dataSource].filter(Boolean).join(" · ")
      || document.title
      || "Yearning";
    return { ok: true, database, dataSource, label, formFound: !!(database || dataSource) };
  }

  // ---------- 查询按钮探测 ----------
  function findQueryButtons() {
    const buttons = [];
    document.querySelectorAll("button").forEach((b) => {
      const text = (b.textContent || "").trim();
      if (!text || text.length > 8) return;
      buttons.push({ text, visible: b.offsetParent !== null, disabled: b.disabled });
    });
    return buttons;
  }

  // ---------- monaco 编辑器内容读取（注入验证用，无 API 时从 DOM 读）----------
  function readMonacoText() {
    const lines = [...document.querySelectorAll(".monaco-editor .view-lines .view-line")]
      .map(l => l.textContent || "");
    return lines.join("\n");
  }

  // ---------- SQL 注入（先 MAIN world API，后 DOM 策略，注入后验证）----------
  async function setSql(sql) {
    // 策略 1：CodeMirror/monaco（MAIN world，官方 API 状态一定同步）
    const main = await callMain("set-sql", { sql });
    if (main && main.ok) return { ok: true, via: main.via };

    // 策略 2：monaco DOM 注入——合成 paste 事件（monaco 官方输入路径）。
    //   实测教训：execCommand("insertText") 在 inputarea 上静默失败（假阳性），
    //   而 ClipboardEvent("paste") + DataTransfer 是 monaco 粘贴处理器认的通道。
    const monacoTa = document.querySelector(".monaco-editor textarea.inputarea");
    if (monacoTa) {
      monacoTa.focus();
      // 全选旧内容（paste 会替换选区）
      monacoTa.dispatchEvent(new KeyboardEvent("keydown", {
        key: "a", code: "KeyA", keyCode: 65, which: 65,
        ctrlKey: true, bubbles: true, cancelable: true
      }));
      const dt = new DataTransfer();
      dt.setData("text/plain", sql);
      monacoTa.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt, bubbles: true, cancelable: true
      }));

      // 注入后验证：等 monaco 渲染，读回 view-lines 内容比对（杜绝假阳性）
      await new Promise(r => setTimeout(r, 250));
      const current = readMonacoText();
      const norm = s => s.replace(/\s+/g, "");
      if (norm(current).includes(norm(sql).slice(0, 40))) {
        return { ok: true, via: "monaco-paste" };
      }
      // paste 失败再试 execCommand（检查返回值）
      monacoTa.focus();
      const ok2 = document.execCommand("insertText", false, sql);
      await new Promise(r => setTimeout(r, 250));
      const current2 = readMonacoText();
      if (ok2 && norm(current2).includes(norm(sql).slice(0, 40))) {
        return { ok: true, via: "monaco-execcmd" };
      }
      return {
        ok: false,
        error: "monaco inject failed (paste+execCommand 均未生效)",
        editorText: current2.slice(0, 120),
      };
    }

    // 策略 3：普通可见 textarea（value + input 事件）
    const tas = [...document.querySelectorAll("textarea")].filter(ta => ta.offsetParent !== null);
    if (tas.length > 0) {
      const ta = tas[0];
      ta.focus();
      ta.value = sql;
      ta.dispatchEvent(new InputEvent("input", {
        inputType: "insertText", data: sql, bubbles: true, cancelable: true
      }));
      return { ok: true, via: "textarea" };
    }

    // 策略 4：contenteditable（focus + 全选 + 插入）
    const ces = [...document.querySelectorAll('[contenteditable="true"]')].filter(el => el.offsetParent !== null);
    if (ces.length > 0) {
      const el = ces[0];
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, sql);
      return { ok: true, via: "contenteditable" };
    }

    return { ok: false, error: "no editor found (main-world/monaco/textarea/contenteditable 均未命中)" };
  }

  // ---------- 点「查询」按钮 ----------
  function clickQuery() {
    // 文本匹配时去空白（实测按钮文案是「查 询」，中间带空格）
    const norm = (s) => (s || "").replace(/\s+/g, "").trim();
    const candidates = [...document.querySelectorAll("button")]
      .filter(b => b.offsetParent !== null && !b.disabled)
      .map(b => ({ b, text: (b.textContent || "").trim(), key: norm(b.textContent) }));
    const exact = candidates.find(c => c.key === "查询") ||
                  candidates.find(c => c.key === "执行") ||
                  candidates.find(c => /^查询|^执行|^运行/.test(c.key));
    if (!exact) {
      return { ok: false, error: "query button not found", buttons: candidates.slice(0, 15).map(c => c.text) };
    }
    exact.b.scrollIntoView({ block: "center" });
    exact.b.click();
    return { ok: true, via: exact.text };
  }

  // ---------- 消息处理 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "yr-meta") {
      sendResponse(readYearningMeta());
      return true;
    }
    if (msg.type === "yr-ping") {
      detectEditor().then(editor => {
        sendResponse({
          ok: true,
          editor,
          buttons: findQueryButtons().slice(0, 20),
        });
      });
      return true;  // 异步响应
    }
    if (msg.type === "yr-sql-set") {
      setSql(msg.sql || "").then(sendResponse);
      return true;
    }
    if (msg.type === "yr-query-click") {
      sendResponse(clickQuery());
      return true;
    }
    if (msg.type === "yr-new-sql") {
      // 新建 SQL 窗口：点工具栏新建按钮，等新编辑器渲染。
      // 避免把 SQL 注入用户正在看/正在用的已有编辑器。
      // 按钮定位：优先 XPath（用户给的路径），兜底找文本含"新建"的可见按钮。
      const btn = xpathNode("/html/body/div[1]/div/section/section/div[2]/main/div/div/div[2]/div[2]/div/div/div/div/div[2]/div/div[1]/div/div[1]/div[1]/div/button")
        || [...document.querySelectorAll("button")].find(b =>
            b.offsetParent !== null && /新建|new/i.test((b.textContent || "").trim()));
      if (!btn) { sendResponse({ ok: false, error: "新建按钮未找到" }); return true; }
      const before = document.querySelectorAll(".monaco-editor").length;
      btn.click();
      // 等新编辑器出现（最多 4s；tab 页签式 UI 时编辑器数不变，退化为等 800ms）
      const deadline = Date.now() + 4000;
      (function waitFor() {
        const now = document.querySelectorAll(".monaco-editor").length;
        if (now > before || Date.now() > deadline) {
          setTimeout(() => sendResponse({ ok: true, editors: now, via: "new-sql-btn" }), 800);
          return;
        }
        setTimeout(waitFor, 200);
      })();
      return true;
    }
    if (msg.type === "yr-focus-editor") {
      // CDP 注入前置：聚焦 monaco 的 inputarea（Input.insertText 作用于焦点元素）
      const ta = document.querySelector(".monaco-editor textarea.inputarea")
        || document.querySelector("textarea");
      if (!ta) { sendResponse({ ok: false, error: "no inputarea" }); return true; }
      ta.focus();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "yr-verify-sql") {
      // CDP 注入后验证：读回 monaco view-lines 内容比对
      const current = readMonacoText();
      const norm = s => s.replace(/\s+/g, "");
      const hit = norm(current).indexOf(norm(msg.sql || "").slice(0, 40)) !== -1;
      sendResponse({ ok: hit, editorText: current.slice(0, 120) });
      return true;
    }
  });

  console.log(TAG, "Yearning content script loaded at", location.href);
})();
