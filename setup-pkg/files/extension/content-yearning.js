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
//   yr-source-switch {target} 点「切换数据源」按钮并在弹层中选中目标数据源，
//                  以 URL hash 变化做成功验证（切源会切页面路由）
//   yr-db-select   {database} 打开库选择器的 antd Select 下拉，点选目标 schema，
//                  以重读 meta 的 database 值做成功验证

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

    // 3. 兜底：form 启发式（排除与 dataSource 重叠/相似的值，防止把
    //    数据源名误认成数据库名——文件名第二段曾因此错成 dk_shard）
    if (!database || !dataSource) {
      const form = document.querySelector("form") || xpathNode(FORM_XPATH);
      if (form) {
        const values = [];
        form.querySelectorAll("input, select").forEach(el => {
          if (el.offsetParent === null) return;
          const value = el.tagName === "SELECT" ? el.options[el.selectedIndex]?.textContent : el.value;
          if (value?.trim()) values.push(value.trim());
        });
        const unique = [...new Set(values)].filter(v =>
          !/^(查询|执行|取消|确定|SQL)$/i.test(v) &&
          v !== dataSource && !dataSource.includes(v) && !v.includes("shard"));
        if (!dataSource) dataSource = unique.find(v => /source|实例|数据源|tdsql|mysql|prod|test/i.test(v)) || "";
        if (!database) database = unique.find(v => /database|schema|^\w+_dk\b/i.test(v)) || "";
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
  // 多 SQL tab 并存时 DOM 里有多个 monaco 实例，inactive tab 的编辑器不渲染
  // view-lines——必须优先取"可见"的那个，否则注入/读回都落在旧隐藏 tab 上
  function activeMonaco() {
    return [...document.querySelectorAll(".monaco-editor")]
      .find(m => m.offsetParent !== null)
      || document.querySelector(".monaco-editor");
  }

  function readMonacoText() {
    const m = activeMonaco();
    if (!m) return "";
    const lines = [...m.querySelectorAll(".view-lines .view-line")]
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

  // ---------- 归一化文本 / 等待 ----------
function normText(el) {
  return (el.textContent || "").replace(/\s+/g, "").trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pressEscape() {
  // antd Modal/Select 对 keydown Escape 响应关闭弹层（含 keyCode 兼容旧版本）
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true
  }));
}

// ---------- 切换数据源（点「切换数据源」→ 弹层选目标 → hash 变化验证）----------
async function switchDataSource(targetName) {
  const wanted = String(targetName || "").trim();
  if (!wanted) return { ok: false, error: "missing target source name" };
  const wantNorm = wanted.replace(/\s+/g, "");

  const btns = [...document.querySelectorAll("button")]
    .filter(b => b.offsetParent !== null && !b.disabled);
  const entry = btns.find(b => normText(b).includes("切换数据源"));
  if (!entry) {
    return {
      ok: false,
      error: "「切换数据源」入口按钮未找到",
      buttons: btns.map(b => normText(b)).filter(t => t && t.length <= 12).slice(0, 25),
    };
  }

  const hashBefore = location.hash;
  entry.click();

  // 弹层形态未知，宽扫所有常见 antd overlay 容器里的可点击元素。
  // 只保留"叶子"命中（内部不含其他命中元素），避免点到整个外层容器导致误击。
  const grabMatches = () => {
    const scopes = [...document.querySelectorAll(
      ".ant-modal,.ant-drawer,.ant-dropdown,.ant-popover,[class*=drawer],[class*=modal]"
    )].filter(el => el.offsetParent !== null);
    const hits = [];
    for (const sc of scopes) {
      sc.querySelectorAll("li,[role=menuitem],[role=option],[class*=item],a,button,td").forEach(el => {
        if (el.offsetParent === null) return;
        const t = normText(el);
        if (!t || t.length > 48 || !t.includes(wantNorm)) return;
        hits.push({ el, t });
      });
    }
    return hits.filter(h => !hits.some(o => o !== h && h.el.contains(o.el)));
  };

  const deadlineHit = Date.now() + 3000;
  let leaves = [];
  while (Date.now() < deadlineHit) {
    leaves = grabMatches();
    if (leaves.length > 0) break;
    await sleep(150);
  }
  if (leaves.length === 0) {
    pressEscape();
    return { ok: false, error: "弹层中未找到目标数据源项", searched: wanted };
  }
  if (leaves.length > 1) {
    const exact = leaves.find(l => l.t === wantNorm);
    if (exact) leaves = [exact];
  }
  if (leaves.length > 1) {
    pressEscape();
    return { ok: false, error: "目标数据源命中多个候选", candidates: leaves.map(l => l.t).slice(0, 10) };
  }
  leaves[0].el.click();

  // 验证：切源会切换页面路由，等 URL hash 变化（~6s）
  const deadlineVer = Date.now() + 6000;
  while (Date.now() < deadlineVer) {
    await sleep(250);
    if (location.hash !== hashBefore) {
      return { ok: true, via: "source-switch", hash: location.hash };
    }
  }
  return {
    ok: false,
    error: "已点击候选但路由未变化（hash 不变），切源可能失败",
    clickedText: leaves[0].t,
    hash: location.hash,
  };
}

// ---------- 选数据库 schema（antd Select 下拉点选 → 重读 meta 验证）----------
function closestAntdSelect(node) {
  let cur = node;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.classList && cur.classList.contains("ant-select")) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function selectDumpLite(el) {
  const r = el.getBoundingClientRect();
  return {
    cls: String(el.className || "").slice(0, 80),
    inForm: !!el.closest("form"),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    hasInput: !!el.querySelector("input"),
    visible: el.offsetParent !== null && r.width > 0 && r.height > 0,
  };
}

function findDbTrigger() {
  // 枚举所有 .ant-select，优先"可见 + 在 form 内 + 带 input"（可搜索 combobox）；
  // 新建 tab 后旧 select 会被隐藏（rect 全 0），必须过滤，否则点在 (0,0) 上
  const all = [...document.querySelectorAll(".ant-select")];
  const visible = all.filter(s => {
    const r = s.getBoundingClientRect();
    return s.offsetParent !== null && r.width > 0 && r.height > 0;
  });
  const score = (s) => (s.closest("form") ? 2 : 0) + (s.querySelector("input") ? 1 : 0);
  const byScore = [...visible].sort((a, b) => score(b) - score(a));
  // 主路径：DATABASE_XPATH 锚点（仍要求可见，防隐藏残留）
  const anchor = xpathNode(DATABASE_XPATH);
  const anchored = anchor ? closestAntdSelect(anchor) : null;
  if (anchored && visible.includes(anchored)) return anchored;
  return byScore[0] || null;
}

function visibleDbDropdown() {
  // 页面会残留多个 dropdown portal（旧 select 隐藏后 portal 仍在 DOM）。
  // antd 新 portal 渲染在 body 末尾、层级最高——取"最后一个可见"的才是
  // 刚打开的那个；取第一个会拿到坐标错位的旧 portal（实测点 dk_shard
  // 落到 information_schema 上）。
  const visible = [...document.querySelectorAll(".ant-select-dropdown")]
    .filter(d => d.offsetParent !== null && !/dropdown-hidden/.test(d.className));
  return visible[visible.length - 1] || null;
}

async function selectDatabase(targetName) {
  const wanted = String(targetName || "").trim();
  if (!wanted) return { ok: false, error: "missing database name" };
  const wantNorm = wanted.replace(/\s+/g, "");
  const trigger = findDbTrigger();
  if (!trigger) return { ok: false, error: "库选择器未找到（antd Select）" };

  // rc-select 打开依赖 mousedown；click 序列作为部分版本的兜底重试
  const openSeqs = [
    () => trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })),
    () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      trigger.click();
    },
  ];
  const readOptions = () => {
    const dd = visibleDbDropdown();
    if (!dd) return null;
    const nodes = [...dd.querySelectorAll(".ant-select-item-option, [role=option]")];
    if (nodes.length === 0) return null;
    return nodes.map(o => {
      const text = o.getAttribute("title") || o.textContent || "";
      return { el: o, text, norm: text.replace(/\s+/g, ""), disabled: /disabled/.test(o.className) };
    }).filter(o => o.norm);
  };

  let opts = null;
  for (const open of openSeqs) {
    open();
    const ddl = Date.now() + 1200;
    while (Date.now() < ddl) {
      await sleep(120);
      opts = readOptions();
      if (opts) break;
    }
    if (opts) break;
  }
  if (!opts) return { ok: false, error: "下拉未能展开（mousedown/click 后均无选项出现）" };

  const hit = opts.find(o => o.norm === wantNorm) || opts.find(o => o.norm.includes(wantNorm));
  if (!hit) {
    pressEscape();
    return { ok: false, error: "下拉中无匹配的库", expect: wanted, options: opts.map(o => o.text.trim()).slice(0, 30) };
  }
  if (hit.disabled) {
    pressEscape();
    return { ok: false, error: "目标库存在但为禁用状态（无权限）", target: wanted };
  }
  // antd option 以 mouseup/click 完成选中
  hit.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  hit.el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  hit.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  // 验证：重读 meta，确认 form 上实际显示的库名已变为目标
  const vdl = Date.now() + 2000;
  while (Date.now() < vdl) {
    await sleep(200);
    const meta = readYearningMeta();
    if (meta.database && meta.database.replace(/\s+/g, "") === wantNorm) {
      return { ok: true, via: "antd-select", database: meta.database };
    }
  }
  const finalMeta = readYearningMeta();
  return {
    ok: false,
    error: "已点击选项但验证失败：form 实际显示库名与目标不符",
    expect: wanted,
    actual: finalMeta.database,
    options: opts.map(o => o.text.trim()).slice(0, 30),
  };
}

// ---------- 只读定位/枚举（供 background 用 CDP 真实鼠标事件编排）----------
// 经验教训：antd Select 对合成 mousedown 不响应，必须 CDP Input.dispatchMouseEvent
// 在坐标上产生受信任点击；本脚本只负责"把元素找到并给出中心坐标"、"枚举下拉/弹层项"。
function rectCenterOf(el) {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function locateTarget(kind, arg) {
  if (kind === "db-trigger") {
    const el = findDbTrigger();
    return el ? rectCenterOf(el) : null;
  }
  if (kind === "entry-button") {
    // arg=按钮归一化文本片段，取文本最短的可命中项（通常是真正的入口小按钮）
    const btn = [...document.querySelectorAll("button")]
      .filter(b => b.offsetParent !== null && !b.disabled && normText(b).includes(String(arg || "")))
      .sort((a, b) => normText(a).length - normText(b).length)[0];
    return btn ? rectCenterOf(btn) : null;
  }
  return null;
}

// 容器内可点元素取叶子节点（内部不含其他命中元素），避免坐标落在整块外层容器上误击
function collectLeafItems(scopes, maxItems) {
  const hits = [];
  for (const sc of scopes) {
    sc.querySelectorAll("li,[role=menuitem],[role=option],[class*=item],a,button,td").forEach(el => {
      if (el.offsetParent === null) return;
      const t = normText(el);
      if (!t || t.length > 48) return;
      hits.push({ el, t });
    });
  }
  return hits
    .filter(h => !hits.some(o => o !== h && h.el.contains(o.el)))
    .slice(0, maxItems || 40)
    .map(h => ({ text: h.t, rect: rectCenterOf(h.el) }));
}

function listDropdownOptionsWithRects() {
  const dd = visibleDbDropdown();
  if (!dd) {
    // 诊断随行：下拉未出现时带回焦点元素与 listbox 节点是否存在于 DOM
    const ae = document.activeElement;
    return {
      ready: false,
      activeEl: ae ? { cls: String(ae.className || "").slice(0, 80), id: ae.id || "", tag: ae.tagName } : null,
      listboxInDom: !!document.querySelector("[role=listbox]"),
      listboxOptions: document.querySelectorAll("[role=listbox] .ant-select-item-option").length,
    };
  }
  const nodes = [...dd.querySelectorAll(".ant-select-item-option, [role=option]")];
  if (nodes.length === 0) return { ready: false };
  // rc-virtual-list 会为每个选项渲染一份隐藏"测量行"（零尺寸），
  // 其坐标漂移会导致点错行——过滤零尺寸后按文本去重，只留真实可见行
  const real = nodes
    .map(o => {
      const r = o.getBoundingClientRect();
      const text = o.getAttribute("title") || o.textContent || "";
      return {
        text: text.trim(),
        disabled: /disabled/.test(o.className),
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      };
    })
    .filter(o => o.text && o.w > 0 && o.h > 0);
  const byText = new Map();
  for (const o of real) if (!byText.has(o.text)) byText.set(o.text, o);
  const options = [...byText.values()].map(o => ({
    text: o.text, disabled: o.disabled,
    rect: { x: Math.round(o.x + o.w / 2), y: Math.round(o.y + o.h / 2) },
  }));
  return { ready: options.length > 0, options };
}

function listOverlayItems() {
  const scopes = [...document.querySelectorAll(
    ".ant-modal,.ant-drawer,.ant-dropdown,.ant-popover,[class*=drawer],[class*=modal]"
  )].filter(el => el.offsetParent !== null);
  return { items: collectLeafItems(scopes, 40) };
}

// ---------- 切源弹层（元素级枚举/点击，不依赖坐标）----------
// modal/portal 场景 offsetParent 判可见不可靠（fixed 祖先/动画态返回 null），
// 用 getClientRects() 判"已布局"；点击直接在元素上派发事件（React 合成事件可达）
function laidOut(el) {
  try {
    const r = el.getBoundingClientRect();
    return el.getClientRects().length > 0 && r.width > 1 && r.height > 1;
  } catch { return false; }
}

function overlayScopes() {
  return [...document.querySelectorAll(
    ".ant-modal,.ant-drawer,.ant-dropdown,.ant-popover,[class*=drawer],[class*=modal]"
  )].filter(laidOut);
}

function overlayLeafElements() {
  // scope 互相嵌套（mask⊃wrap⊃modal），同一元素会被重复收集；
  // 且 el.contains(自身)===true，重复对象会在叶子过滤时互相"包含"而全军覆没
  // （实测 rawCount=255 全有效、叶子过滤后=0 的根因）——先按元素去重再过滤
  const seen = new Set();
  const hits = [];
  for (const sc of overlayScopes()) {
    sc.querySelectorAll("li,[role=menuitem],[role=option],[class*=item],a,button,td").forEach(el => {
      if (seen.has(el) || !laidOut(el)) return;
      seen.add(el);
      const t = normText(el);
      if (!t || t.length > 48) return;
      hits.push({ el, t });
    });
  }
  return hits.filter(h => !hits.some(o => o.el !== h.el && h.el.contains(o.el)));
}

function listSourceModalItems() {
  // 自诊断版：带回每一级过滤的计数与原始命中，定位"哪一步滤没了"
  const scopes = overlayScopes();
  let raw = [];
  for (const sc of scopes) {
    sc.querySelectorAll("li,[role=menuitem],[role=option],[class*=item],a,button,td").forEach(el => {
      raw.push({ el, laidOut: laidOut(el), t: normText(el) });
    });
  }
  const leaves = overlayLeafElements();
  return {
    items: leaves.map(h => h.t).slice(0, 40),
    debug: {
      scopeCount: scopes.length,
      scopeCls: scopes.slice(0, 3).map(s => String(s.className).slice(0, 80)),
      rawCount: raw.length,
      rawLaidOut: raw.filter(r => r.laidOut).length,
      rawTextOk: raw.filter(r => r.laidOut && r.t && r.t.length <= 48).length,
      sample: raw.filter(r => r.laidOut && r.t).slice(0, 12).map(r => r.t.slice(0, 30)),
    },
  };
}

function clickSourceItem(target) {
  const wanted = String(target || "").replace(/\s+/g, "");
  const leaves = overlayLeafElements();
  if (leaves.length === 0) return { ok: false, error: "弹层未打开或无可选项" };
  const matches = leaves.filter(h => h.t.includes(wanted));
  if (matches.length === 0) {
    return { ok: false, error: "弹层中无匹配的数据源", candidates: leaves.map(h => h.t).slice(0, 30) };
  }
  if (matches.length > 1) {
    const exact = matches.find(h => h.t === wanted);
    if (!exact) {
      return { ok: false, error: "目标命中多个候选，需精确名称", candidates: matches.map(h => h.t) };
    }
    matches.length = 0;
    matches.push(exact);
  }
  ["mousedown", "mouseup", "click"].forEach(t =>
    matches[0].el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  return { ok: true, clicked: matches[0].t };
}
// ---------- 点选下拉中的目标选项（在元素上直接派发事件，无坐标漂移）----------
function clickDropdownOption(target) {
  const dd = visibleDbDropdown();
  if (!dd) return { ok: false, error: "dropdown not open" };
  const nodes = [...dd.querySelectorAll(".ant-select-item-option, [role=option]")]
    .filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const norm = s => (s || "").replace(/\s+/g, "");
  const textOf = o => (o.getAttribute("title") || o.textContent || "").trim();
  const hit = nodes.find(o => norm(textOf(o)) === norm(target))
           || nodes.find(o => norm(textOf(o)).includes(norm(target)));
  if (!hit) {
    return { ok: false, error: "option not found", options: nodes.map(textOf).slice(0, 30) };
  }
  if (/disabled/.test(hit.className)) return { ok: false, error: "目标库为禁用状态（无权限）", target };
  ["mousedown", "mouseup", "click"].forEach(t =>
    hit.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  return { ok: true, clicked: textOf(hit) };
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
        // 切源入口 / Select 状态 / 当前路由，辅助诊断切库链路
        const hasSourceEntry = [...document.querySelectorAll("button")]
          .some(b => b.offsetParent !== null && normText(b).includes("切换数据源"));
        const selects = [...document.querySelectorAll(".ant-select")]
          .filter(s => s.offsetParent !== null).slice(0, 6)
          .map(s => {
            const valueEl = s.querySelector(".ant-select-selection-item");
            const phEl = s.querySelector(".ant-select-selection-placeholder");
            return {
              value: valueEl ? (valueEl.getAttribute("title") || valueEl.textContent || "").trim() : "",
              placeholder: phEl ? (phEl.textContent || "").trim() : "",
              disabled: /disabled/.test(s.className),
            };
          });
        sendResponse({
          ok: true,
          editor,
          buttons: findQueryButtons().slice(0, 20),
          sourceEntry: hasSourceEntry,
          selects,
          hash: location.hash,
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
    if (msg.type === "yr-source-switch") {
      switchDataSource(msg.target).then(sendResponse);
      return true;
    }
    if (msg.type === "yr-db-select") {
      selectDatabase(msg.database).then(sendResponse);
      return true;
    }
    if (msg.type === "yr-focus-db") {
      // 程序化聚焦库选择器的搜索输入框（focus 无需受信任事件，随后键盘事件才有效）
      const trigger = findDbTrigger();
      const input = trigger?.querySelector("input");
      if (!input) {
        sendResponse({
          ok: false,
          error: "库选择器内未找到 input",
          triggerCls: trigger ? String(trigger.className).slice(0, 100) : null,
          selects: [...document.querySelectorAll(".ant-select")].map(selectDumpLite).slice(0, 10),
        });
        return true;
      }
      input.focus();
      const ae = document.activeElement;
      sendResponse({
        ok: ae === input || (ae && input.contains(ae)) || ae === trigger,
        focused: ae === input,
        activeCls: String(ae?.className || "").slice(0, 80),
        activeTag: ae?.tagName,
      });
      return true;
    }
    if (msg.type === "yr-db-click-option") {
      sendResponse(clickDropdownOption(msg.database));
      return true;
    }
    if (msg.type === "yr-source-items") {
      sendResponse(listSourceModalItems());
      return true;
    }
    if (msg.type === "yr-source-click") {
      sendResponse(clickSourceItem(msg.target));
      return true;
    }
    if (msg.type === "yr-locate") {
      const rect = locateTarget(msg.kind, msg.arg);
      if (rect) { sendResponse({ ok: true, rect }); return true; }
      // 定位失败带回全量 select 候选（含可见性与尺寸），便于判读页面结构
      sendResponse({
        ok: false,
        error: "target not found: " + (msg.kind || ""),
        selects: [...document.querySelectorAll(".ant-select")].map(selectDumpLite).slice(0, 10),
      });
      return true;
    }
    if (msg.type === "yr-options") {
      sendResponse(listDropdownOptionsWithRects());
      return true;
    }
    if (msg.type === "yr-overlay-items") {
      sendResponse(listOverlayItems());
      return true;
    }
    if (msg.type === "yr-hash") {
      sendResponse({ ok: true, hash: location.hash });
      return true;
    }
    if (msg.type === "yr-active-element") {
      const el = document.activeElement;
      sendResponse(el ? { ok: true, cls: String(el.className || "").slice(0, 100), id: el.id || "", tag: el.tagName } : { ok: false });
      return true;
    }
    if (msg.type === "yr-dom-probe") {
      // 只读探测：抓 Select / 下拉层 / 弹窗的真实类名与文本，用于诊断未知 UI 结构
      const dump = (el) => ({
        cls: String(el.className || "").slice(0, 120),
        text: normText(el).slice(0, 60),
        visible: el.offsetParent !== null,
      });
      try {
        const rectOf = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const selectDump = (el) => ({
          cls: String(el.className || "").slice(0, 120),
          text: normText(el).slice(0, 60),
          visible: el.offsetParent !== null,
          rect: rectOf(el),
          inForm: !!el.closest("form"),
          html: el.outerHTML.replace(/\s+/g, " ").slice(0, 500),
        });
        // 用与编排一致的定位逻辑回看"到底选中了哪个节点"
        const trigEl = findDbTrigger();
        sendResponse({
          ok: true,
          hash: location.hash,
          selects: [...document.querySelectorAll(".ant-select")].map(selectDump),
          triggerLocated: trigEl ? selectDump(trigEl) : null,
          metaNow: readYearningMeta(),
          dropdownsAny: [...document.querySelectorAll("[class*=dropdown]")]
            .slice(0, 8)
            .map(el => ({ cls: String(el.className || "").slice(0, 100), visible: el.offsetParent !== null, text: normText(el).slice(0, 60) })),
          optionCount: document.querySelectorAll(".ant-select-item-option").length,
          overlays: [...document.querySelectorAll(".ant-modal,.ant-drawer,.ant-popover")]
            .filter(el => el.offsetParent !== null)
            .map(el => ({
              cls: String(el.className || "").slice(0, 100),
              text: normText(el).slice(0, 100),
              btns: [...el.querySelectorAll("button,li,[role=menuitem],[role=option]")]
                .map(b => normText(b)).filter(t => t && t.length <= 30).slice(0, 15),
            })),
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
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
      // CDP 注入前置：聚焦当前可见 tab 的 monaco inputarea（Input.insertText 作用于焦点元素）
      const ta = activeMonaco()?.querySelector("textarea.inputarea")
        || document.querySelector("textarea");
      if (!ta) { sendResponse({ ok: false, error: "no inputarea" }); return true; }
      ta.focus();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "yr-sql-get") {
      // 读当前编辑器完整 SQL（手动查询结果帧到达时，编辑器里就是刚执行的 SQL）
      sendResponse({ ok: true, sql: readMonacoText() });
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

  console.log(TAG, "Yearning content script v" + chrome.runtime.getManifest().version + " loaded at", location.href);
})();
