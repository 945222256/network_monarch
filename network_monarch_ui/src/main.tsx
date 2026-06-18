import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// 全局样式拦截，确保整个 Webview 表现得像一个原生 App (Tauri 2.0 最佳实践)
document.addEventListener('contextmenu', e => e.preventDefault());
document.body.style.margin = '0';
document.body.style.padding = '0';
document.body.style.overflow = 'hidden';

// 紧急插入：全屏错误捕捉器，帮助诊断“全黑”问题
window.onerror = (msg, url, lineNo, columnNo, error) => {
    const errDiv = document.createElement('div');
    errDiv.style.position = 'fixed';
    errDiv.style.top = '10px';
    errDiv.style.left = '10px';
    errDiv.style.color = 'red';
    errDiv.style.background = 'rgba(0,0,0,0.8)';
    errDiv.style.padding = '10px';
    errDiv.style.zIndex = '9999';
    errDiv.style.pointerEvents = 'none';
    errDiv.innerHTML = `<h3>JS Error</h3><p>${msg}</p><p>Line: ${lineNo}</p><pre>${error?.stack || ''}</pre>`;
    document.body.appendChild(errDiv);
    return false;
};

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled Rejection:', event.reason);
});

// 挂载 React 根节点
const rootElement = document.getElementById('root');
if (rootElement) {
    // 故意去除 React.StrictMode，避免开发模式下的双重渲染导致 WebSocket 二次连接和 Canvas 重复初始化问题。
    ReactDOM.createRoot(rootElement).render(<App />);
} else {
    console.error('[System] 启动失败，未在 DOM 中找到 id 为 root 的挂载点');
}
