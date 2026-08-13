// JumpServer 终端桥接 — popup 交互
// 只管两件事：xterm 捕获/选择 + 代理启停

// ============== xterm 终端状态 ==============
const xtermDot = document.getElementById('xtermDot');
const xtermText = document.getElementById('xtermStatusText');
const xtermHint = document.getElementById('xtermHint');
const tabListEl = document.getElementById('tabList');

function refreshXterm() {
  chrome.runtime.sendMessage({ type: 'XTERM_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      xtermDot.className = 'dot off';
      xtermText.textContent = '状态未知';
      tabListEl.innerHTML = '';
      return;
    }
    if (res.ready) {
      xtermDot.className = 'dot on';
      xtermText.textContent = `xterm 已捕获 (${res.tabCount} 个终端)`;
      xtermHint.textContent = res.attachedCount > 0
        ? `✓ 已 attach，可执行命令`
        : `⚠ 等待 attach...`;
      // 渲染 tab 列表
      if (res.tabs && res.tabs.length > 0) {
        tabListEl.innerHTML = res.tabs.map(t => {
          const hostTag = t.host ? `<span class="tab-host" title="${t.host}">${t.host}</span>` : '';
          const currentTag = t.isCurrent ? '<span class="tab-current">● 当前</span>' : '';
          return `<div class="tab-item ${t.active ? 'active' : ''}" data-tabid="${t.tabId}">
             <span class="tab-check">${t.active ? '◉' : '○'}</span>
             <span class="tab-row">
               <span class="tab-title" title="${t.title}">${t.title}</span>
               ${hostTag}${currentTag}
             </span>
           </div>`;
        }).join('');
        tabListEl.querySelectorAll('.tab-item').forEach(el => {
          el.onclick = () => {
            const tabId = parseInt(el.dataset.tabid, 10);
            chrome.runtime.sendMessage({ type: 'XTERM_SELECT', tabId }, () => refreshXterm());
          };
        });
      } else {
        tabListEl.innerHTML = '';
      }
    } else {
      xtermDot.className = 'dot off';
      xtermText.textContent = '未检测到终端';
      xtermHint.textContent = '打开 JumpServer 终端 或 Arthas Console';
      tabListEl.innerHTML = '';
    }
  });
}

document.getElementById('btnXtermScan').onclick = () => {
  xtermDot.className = 'dot loading';
  xtermText.textContent = '扫描中...';
  xtermHint.textContent = '正在遍历所有 tab 查找 xterm';
  chrome.runtime.sendMessage({ type: 'XTERM_SCAN' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      xtermDot.className = 'dot off';
      xtermText.textContent = '扫描失败';
      return;
    }
    if (res.found > 0) {
      xtermDot.className = 'dot on';
      xtermText.textContent = `✓ 捕获到 ${res.found} 个终端`;
      xtermHint.textContent = '已自动 attach，可以执行命令';
      setTimeout(refreshXterm, 800);
    } else {
      xtermDot.className = 'dot off';
      xtermText.textContent = '未找到终端';
      xtermHint.textContent = '请确认终端页面已打开并完成连接';
    }
  });
};

// ============== 代理控制 ==============
const proxyDot = document.getElementById('proxyDot');
const proxyText = document.getElementById('proxyStatusText');
const btnProxyStart = document.getElementById('btnProxyStart');
const btnProxyStop = document.getElementById('btnProxyStop');

function setProxyUI(state, text) {
  proxyDot.className = 'dot ' + state;
  proxyText.textContent = text;
  if (state === 'on') {
    btnProxyStart.style.display = 'none';
    btnProxyStop.style.display = 'block';
  } else if (state === 'off') {
    btnProxyStart.style.display = 'block';
    btnProxyStop.style.display = 'none';
  }
}

function refreshProxy() {
  // 注意：不要在查询前置 loading，否则定时刷新每 3 秒会闪一次黄。
  // 保持上次的 UI 状态不动，拿到结果后才更新。
  chrome.runtime.sendMessage({ type: 'PROXY_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setProxyUI('off', '状态未知');
      return;
    }
    if (res.ok && res.status === 'running') {
      setProxyUI('on', `运行中 · 127.0.0.1:${res.port || 8787}`);
    } else if (res.ok) {
      setProxyUI('off', '代理未运行');
    } else {
      setProxyUI('off', res.msg || '代理未运行');
    }
  });
}

btnProxyStart.onclick = () => {
  setProxyUI('loading', '启动中...');
  chrome.runtime.sendMessage({ type: 'PROXY_START' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setProxyUI('off', '启动失败（无响应）');
      return;
    }
    if (res.ok && res.status === 'running') {
      setProxyUI('on', `✓ 运行中 · 127.0.0.1:${res.port || 8787}`);
    } else {
      setProxyUI('off', '✗ ' + (res.msg || '启动失败'));
    }
  });
};

btnProxyStop.onclick = () => {
  setProxyUI('loading', '停止中...');
  chrome.runtime.sendMessage({ type: 'PROXY_STOP' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setProxyUI('off', '已停止');
      return;
    }
    setProxyUI('off', res.msg || '代理已停止');
  });
};

// 定时刷新（popup 打开期间）
setInterval(() => { refreshXterm(); refreshProxy(); }, 3000);
refreshXterm();
refreshProxy();
