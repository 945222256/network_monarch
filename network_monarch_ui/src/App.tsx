import React, { useEffect, useState } from 'react';
import { initBinaryStream, closeBinaryStream, NetworkStats } from './network/BinaryStream';
import { Renderer } from './render/Renderer';
import { InfoPanel } from './ui/InfoPanel';
import type { NodeInfo } from './ecs/NodeManager';

/**
 * App 根组件 - UI Shell 与网络层生命周期管理
 * 遵循严格的状态隔离。绝不将高频 ECS 或 Network 状态直接映射到 React 状态树中。
 */
export default function App() {
    // 全局网络统计数据（仅用于低频控制台展示）
    const [packets, setPackets] = useState(0);

    // 当前鼠标悬停的网络节点信息（null 表示未悬停任何节点）
    const [hoveredNode, setHoveredNode] = useState<NodeInfo | null>(null);
    // InfoPanel 在屏幕上的渲染坐标（跟随鼠标位置）
    const [panelPosition, setPanelPosition] = useState<{ x: number; y: number } | null>(null);

    /**
     * 节点悬停回调
     * 由 Renderer 组件的 Raycaster 系统触发，
     * 更新 React 状态以驱动 InfoPanel 的显示/隐藏。
     */
    const handleNodeHover = (node: NodeInfo | null, screenPos: { x: number; y: number } | null) => {
        setHoveredNode(node);
        setPanelPosition(screenPos);
    };

    useEffect(() => {
        // 1. 启动底层二进制数据流接收
        initBinaryStream();

        // 2. 数据监控节流策略 (Throttle)
        // 采用主动轮询全局可变对象的方式，每 500ms（一秒最多2次）同步一次 React 状态。
        // 这样即便底层每秒收到上万个网络包，React 组件的 DOM Diff 也只发生 2 次，保障渲染性能。
        const statsInterval = setInterval(() => {
            setPackets(NetworkStats.totalPacketsReceived);
        }, 500);

        // 【M10 修复】生命周期清理：组件卸载时关闭 WebSocket 并清除定时器
        return () => {
            clearInterval(statsInterval);
            closeBinaryStream();
        };
    }, []);

    return (
        <div style={styles.container}>
            {/* 3. 图形引擎挂载点：脱离 React 更新周期的独立渲染区域
                外部 Three.js / WebGPU 引擎初始化在 Renderer 内部进行，
                Canvas 容器绝对定位且放置于最底层 */}
            <div style={styles.canvasContainer}>
                <Renderer onNodeHover={handleNodeHover} />
            </div>

            {/* 控制台悬浮 UI 层：负责低频数据更新 */}
            <div style={styles.uiPanel}>
                <h2 style={styles.panelTitle}>Network Monarch 节点控制台</h2>
                <div style={styles.statRow}>
                    <span style={styles.statLabel}>已处理数据包总数：</span>
                    {/* 数字格式化千分位展示 */}
                    <span style={styles.statValue}>{packets.toLocaleString()}</span>
                </div>
            </div>

            {/* 节点详情悬浮面板：根据 Raycaster 命中结果动态渲染 */}
            <InfoPanel node={hoveredNode} position={panelPosition} />
        </div>
    );
}

// React 内联样式，避免外部依赖，确保组件自闭环
const styles: Record<string, React.CSSProperties> = {
    container: {
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        backgroundColor: '#0a0a0a', // 深色图形应用背景
    },
    canvasContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1, // 图层在底层
    },
    uiPanel: {
        position: 'absolute',
        top: '24px',
        left: '24px',
        zIndex: 10, // UI 图层在最上层
        backgroundColor: 'rgba(15, 20, 25, 0.85)',
        border: '1px solid rgba(77, 184, 255, 0.3)',
        borderRadius: '8px',
        padding: '16px 20px',
        color: '#e0e0e0',
        fontFamily: 'Consolas, monospace',
        minWidth: '280px',
        backdropFilter: 'blur(8px)', // 毛玻璃效果
        pointerEvents: 'auto',
    },
    panelTitle: {
        margin: '0 0 16px 0',
        fontSize: '14px',
        color: '#4db8ff',
        textTransform: 'uppercase',
        letterSpacing: '1px',
    },
    statRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '14px',
    },
    statLabel: {
        color: '#8c9bac',
    },
    statValue: {
        fontWeight: 'bold',
        color: '#4ade80', // 科技绿标识数据
    }
};
