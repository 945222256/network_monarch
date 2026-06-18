import React, { useEffect, useState } from 'react';
import type { NodeInfo } from '../ecs/NodeManager';

/**
 * InfoPanel 组件的 Props 接口
 * 
 * @property node - 当前选中/悬停的节点元数据，为 null 表示无选中节点
 * @property position - 面板应渲染到的屏幕坐标 (px)，为 null 时不渲染
 */
interface InfoPanelProps {
    node: NodeInfo | null;
    position: { x: number; y: number } | null;
}

/**
 * 将字节数格式化为人类可读的流量单位
 * 
 * 采用 1024 进制（KiB/MiB/GiB），因为网络诊断工具
 * 通常使用二进制前缀来避免与硬盘厂商的十进制混淆。
 * 
 * @param bytes - 原始字节数
 * @returns 格式化后的字符串，如 "1.23 MB"
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    } else {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
}

/**
 * 计算面板的安全渲染位置，防止面板超出视口边界
 * 
 * @param x - 原始屏幕 X 坐标
 * @param y - 原始屏幕 Y 坐标
 * @param panelWidth - 面板预估宽度（像素）
 * @param panelHeight - 面板预估高度（像素）
 * @returns 修正后的安全坐标
 */
function clampToViewport(
    x: number,
    y: number,
    panelWidth: number,
    panelHeight: number
): { x: number; y: number } {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    /** 面板与视口边缘的最小间距（像素） */
    const margin = 12;

    let safeX = x + 16; // 默认在鼠标指针右侧 16px 处渲染
    let safeY = y + 16; // 默认在鼠标指针下方 16px 处渲染

    // 右边缘溢出检测：将面板移到指针左侧
    if (safeX + panelWidth + margin > viewportW) {
        safeX = x - panelWidth - 16;
    }
    // 底部溢出检测：将面板移到指针上方
    if (safeY + panelHeight + margin > viewportH) {
        safeY = y - panelHeight - 16;
    }
    // 左边缘兜底：确保不会出现负坐标
    if (safeX < margin) {
        safeX = margin;
    }
    // 顶部兜底
    if (safeY < margin) {
        safeY = margin;
    }

    return { x: safeX, y: safeY };
}

/**
 * InfoPanel - 网络节点详情悬浮面板
 * 
 * 当用户将鼠标悬停在 3D 场景中的节点球体上时，
 * 此面板会在鼠标附近浮现，展示该节点的 IP、地理位置、
 * 关联进程、累计流量和空间坐标等信息。
 * 
 * 设计特征：
 * - 半透明深色毛玻璃背景，与 Network Monarch 整体暗色调一致
 * - 发光青色边框，呼应项目的科技蓝主题色 (#4db8ff)
 * - 淡入动画，避免面板突兀出现
 * - 自动边缘避让，确保面板始终在可视区域内
 */
export const InfoPanel: React.FC<InfoPanelProps> = ({ node, position }) => {
    // 控制淡入动画的透明度状态
    const [opacity, setOpacity] = useState(0);

    // 当 node 数据变化时触发淡入效果
    useEffect(() => {
        if (node) {
            // 使用 requestAnimationFrame 确保在下一帧才设置透明度为 1，
            // 这样浏览器能正确触发 CSS transition 过渡动画
            const rafId = requestAnimationFrame(() => {
                setOpacity(1);
            });
            return () => cancelAnimationFrame(rafId);
        } else {
            // 节点消失时立即重置透明度为 0
            setOpacity(0);
        }
    }, [node]);

    // 无节点数据或无定位坐标时，不渲染任何 DOM
    if (!node || !position) {
        return null;
    }

    /** 面板预估宽度（像素），用于边缘避让计算 */
    const PANEL_WIDTH = 300;
    /** 面板预估高度（像素） */
    const PANEL_HEIGHT = 200;

    // 计算面板安全渲染坐标
    const safePos = clampToViewport(position.x, position.y, PANEL_WIDTH, PANEL_HEIGHT);

    // ---- 面板容器样式 ----
    const panelStyle: React.CSSProperties = {
        position: 'fixed',
        left: `${safePos.x}px`,
        top: `${safePos.y}px`,
        zIndex: 100, // 确保悬浮于所有 UI 元素之上
        backgroundColor: 'rgba(10, 15, 25, 0.92)',
        border: '1px solid rgba(77, 184, 255, 0.4)',
        borderRadius: '10px',
        padding: '14px 18px',
        color: '#e0e0e0',
        fontFamily: 'Consolas, "Courier New", monospace',
        minWidth: `${PANEL_WIDTH}px`,
        maxWidth: '360px',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)', // Safari 兼容
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.5), 0 0 12px rgba(77, 184, 255, 0.15)',
        pointerEvents: 'none', // 面板不拦截鼠标事件，让 Raycaster 持续工作
        opacity: opacity,
        transition: 'opacity 0.2s ease-in-out', // 淡入淡出过渡动画
        userSelect: 'none', // 防止用户意外选中面板文字
    };

    // ---- IP 标题样式 ----
    const titleStyle: React.CSSProperties = {
        margin: '0 0 10px 0',
        fontSize: '16px',
        fontWeight: 'bold',
        color: '#4db8ff', // 亮青色，项目主题色
        letterSpacing: '0.5px',
        borderBottom: '1px solid rgba(77, 184, 255, 0.2)',
        paddingBottom: '8px',
    };

    // ---- 信息行通用样式 ----
    const rowStyle: React.CSSProperties = {
        fontSize: '13px',
        lineHeight: '1.8',
        color: '#c8d6e5',
    };

    // ---- 标签高亮样式 ----
    const labelStyle: React.CSSProperties = {
        color: '#8c9bac',
        marginRight: '4px',
    };

    // ---- 数值高亮样式 ----
    const valueStyle: React.CSSProperties = {
        color: '#4ade80', // 科技绿，与 App.tsx 中的统计数值保持一致
        fontWeight: 'bold',
    };

    return (
        <div style={panelStyle}>
            {/* 标题行：IP 地址 */}
            <h3 style={titleStyle}>
                🖥️ {node.ip}
            </h3>

            {/* 信息行1：地理位置与 ISP */}
            <div style={rowStyle}>
                <span>🌍 </span>
                <span style={labelStyle}>国家:</span>
                <span style={valueStyle}>{node.country}</span>
                <span style={{ color: '#555', margin: '0 8px' }}>|</span>
                <span style={labelStyle}>ISP:</span>
                <span style={valueStyle}>{node.isp}</span>
            </div>

            {/* 信息行2：关联进程 */}
            <div style={rowStyle}>
                <span>📡 </span>
                <span style={labelStyle}>进程:</span>
                <span style={valueStyle}>{node.processName}</span>
            </div>

            {/* 信息行3：累计流量（自动格式化单位） */}
            <div style={rowStyle}>
                <span>📊 </span>
                <span style={labelStyle}>累计流量:</span>
                <span style={valueStyle}>{formatBytes(node.totalBytes)}</span>
            </div>

            {/* 信息行4：3D 空间坐标，保留两位小数 */}
            <div style={rowStyle}>
                <span>📍 </span>
                <span style={labelStyle}>坐标:</span>
                <span style={valueStyle}>
                    ({node.x.toFixed(2)}, {node.y.toFixed(2)}, {node.z.toFixed(2)})
                </span>
            </div>
        </div>
    );
};
