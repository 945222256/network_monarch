import { ingestPackets } from '../ecs/systems';
import { handleMetadata } from '../ecs/NodeManager';

// 采用全局可变对象（Mutable Global Object）追踪统计数据
// 零分配设计，完全避免每次消息派发创建事件对象
export const NetworkStats = {
    totalPacketsReceived: 0,
    totalBytesReceived: 0
};

const WS_URL = 'ws://127.0.0.1:1421';
let ws: WebSocket | null = null;
let isReconnecting = false;
/** 【M10 修复】保存重连定时器 ID，确保关闭时可以取消 */
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * 初始化高频二进制网络流
 * 严格遵守零分配（Zero-Allocation）与面向数据设计（DoD）原则
 * 
 * 消息分流策略：
 * - ArrayBuffer 类型 → 二进制粒子数据，交给 ECS 系统处理
 * - string 类型 → JSON 元数据消息，交给 NodeManager 处理
 */
export function initBinaryStream() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    ws = new WebSocket(WS_URL);
    // 强制使用 arraybuffer，确保接收到的直接是二进制连续内存块
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log('[BinaryStream] WebSocket连接已建立');
        isReconnecting = false;
    };

    ws.onmessage = (event: MessageEvent) => {
        // ========== 消息类型分流 ==========
        // 后端在同一条 WebSocket 连接上混合发送二进制帧和文本帧。
        // 二进制帧 (ArrayBuffer) 携带高频粒子运动数据；
        // 文本帧 (string) 携带低频节点元数据（IP、国家、进程等）。
        if (typeof event.data === 'string') {
            // --- 文本帧：JSON 元数据消息 ---
            // 委托 NodeManager 解析并更新全局节点注册表
            handleMetadata(event.data);
            return;
        }

        // --- 二进制帧：粒子运动数据 ---
        const buffer = event.data as ArrayBuffer;
        NetworkStats.totalBytesReceived += buffer.byteLength;

        // 每个数据包由 7 个 32位浮点数（Float32）构成：
        // [srcX, srcY, srcZ, targetX, targetY, targetZ, protocolId]
        // 7 * 4 bytes = 28 bytes
        const PACKET_SIZE_BYTES = 28;

        // 整数除法，计算当前帧批次包含的数据包数量
        const packetCount = Math.floor(buffer.byteLength / PACKET_SIZE_BYTES);
        NetworkStats.totalPacketsReceived += packetCount;

        if (packetCount > 0) {
            // DoD & 零分配核心：
            // 直接使用 Float32Array 视图映射 ArrayBuffer 的内存，不创建任何中间结构体。
            const floatView = new Float32Array(buffer);
            ingestPackets(floatView, packetCount);
        }
    };

    ws.onclose = () => {
        console.warn('[BinaryStream] WebSocket已断开，尝试重连...');
        scheduleReconnect();
    };

    ws.onerror = (error) => {
        console.error('[BinaryStream] WebSocket发生错误:', error);
        ws?.close();
    };
}

/**
 * 【M10 修复】关闭 WebSocket 连接并清理所有重连定时器
 * 
 * 用途：在 React useEffect cleanup 中调用，
 * 防止 HMR 热更新时旧连接残留导致重复数据注入。
 */
export function closeBinaryStream(): void {
    // 取消挂起的重连定时器
    if (reconnectTimerId !== null) {
        clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
    }
    isReconnecting = false;

    // 关闭 WebSocket 连接
    if (ws) {
        // 移除事件处理器防止 onclose 触发重连
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
        ws = null;
        console.log('[BinaryStream] WebSocket 连接已主动关闭');
    }
}

/**
 * 简单的断线重连机制
 */
function scheduleReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    reconnectTimerId = setTimeout(() => {
        reconnectTimerId = null;
        initBinaryStream();
    }, 2000);
}
