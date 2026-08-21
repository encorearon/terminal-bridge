// Terminal Bridge - Yearning MAIN world 桥接
//
// CodeMirror（el.CodeMirror）/ monaco（window.monaco）等编辑器的 JS API
// 挂在页面 JS 上下文上，ISOLATED world 的 content script 访问不到。
// 本脚本运行在 MAIN world，通过 window.postMessage 与 ISOLATED 侧通信。
//
// 协议（source 字段区分方向）：
//   ISOLATED → MAIN: {source:"tb-yr-iso", id, kind:"detect"|"set-sql", sql}
//   MAIN → ISOLATED: {source:"tb-yr-main", id, ok, via, info}

(function () {
  if (window.__terminalBridgeYearningMain) return;
  window.__terminalBridgeYearningMain = true;

  function detect() {
    const editors = [];
    // CodeMirror：DOM 元素上挂 .CodeMirror 属性（v5）
    document.querySelectorAll(".CodeMirror").forEach((el) => {
      if (el.CodeMirror) editors.push({ type: "codemirror" });
    });
    // monaco
    if (window.monaco && window.monaco.editor && typeof window.monaco.editor.getEditors === "function") {
      window.monaco.editor.getEditors().forEach(() => editors.push({ type: "monaco" }));
    }
    return { editors };
  }

  function setSql(sql) {
    const cmEl = document.querySelector(".CodeMirror");
    if (cmEl && cmEl.CodeMirror) {
      cmEl.CodeMirror.setValue(sql);
      return { ok: true, via: "codemirror" };
    }
    if (window.monaco && window.monaco.editor && typeof window.monaco.editor.getEditors === "function") {
      const eds = window.monaco.editor.getEditors();
      if (eds.length > 0) {
        eds[0].setValue(sql);
        return { ok: true, via: "monaco" };
      }
    }
    return { ok: false, error: "no cm/monaco editor in MAIN world" };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "tb-yr-iso") return;
    let reply;
    if (msg.kind === "detect") reply = detect();
    else if (msg.kind === "set-sql") reply = setSql(msg.sql || "");
    else return;
    window.postMessage({ source: "tb-yr-main", id: msg.id, ...reply }, "*");
  });

  console.log("[terminal-yr-main] MAIN world bridge ready");
})();
