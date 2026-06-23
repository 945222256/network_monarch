/**
 * NodeManager - 网络节点元数据注册表
 * 
 * 职责：维护所有已知网络节点（IP）的元数据信息，
 * 包括地理位置、ISP、关联进程名和累计流量等。
 * 
 * 数据来源：后端通过 WebSocket 发送的 JSON 文本消息。
 * 与二进制粒子数据流共用同一条 WebSocket 连接，
 * 在 BinaryStream.ts 中按数据类型分流。
 */

/** 单个网络节点的完整元数据信息 */
export interface NodeInfo {
    /** IP 地址字符串，如 "192.168.1.1" 或 "2001:db8::1" */
    ip: string;
    /** 节点所在国家/地区名称 */
    country: string;
    /** 互联网服务提供商名称 */
    isp: string;
    /** 节点在 3D 场景中的 X 坐标 */
    x: number;
    /** 节点在 3D 场景中的 Y 坐标 */
    y: number;
    /** 节点在 3D 场景中的 Z 坐标 */
    z: number;
    /** 该节点的累计通信字节数 */
    totalBytes: number;
    /** 与该节点通信的本地进程名称 */
    processName: string;
    /** 最后一次收到该节点活动数据的时间戳 (Date.now() 毫秒级) */
    lastSeen: number;
}

/**
 * 全局节点注册表（单例）
 * Key: IP 地址字符串
 * Value: 该 IP 对应的完整 NodeInfo 元数据
 * 
 * 选择 Map 而非普通对象，因为 IP 字符串作为 key 的查找/插入频率极高，
 * Map 在高频键值操作中比 {} 具有更稳定的 O(1) 性能。
 */
export const nodeRegistry: Map<string, NodeInfo> = new Map();

/**
 * 检测 IP 地址是否属于私有/保留地址段
 * 
 * 这些 IP 在 MaxMind GeoIP 数据库中没有条目，
 * 查询结果默认 lat=0, lon=0 → 被放到 0°N 0°E（几内亚湾），
 * 产生标签为 "Unknown" 的幽灵节点。
 * 
 * 检测范围：
 * - 10.0.0.0/8       RFC 1918 A 类私有
 * - 172.16.0.0/12     RFC 1918 B 类私有
 * - 192.168.0.0/16    RFC 1918 C 类私有
 * - 127.0.0.0/8       环回地址
 * - 169.254.0.0/16    APIPA 链路本地
 * - 0.0.0.0           无效地址
 * 
 * @param ip - IPv4 地址字符串
 * @returns true 表示应该过滤掉
 */
function isPrivateIP(ip: string): boolean {
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('127.')) return true;
    if (ip.startsWith('169.254.')) return true;
    if (ip === '0.0.0.0') return true;
    // 172.16.0.0/12 → 172.16.x.x ~ 172.31.x.x
    if (ip.startsWith('172.')) {
        const secondOctet = parseInt(ip.split('.')[1], 10);
        if (secondOctet >= 16 && secondOctet <= 31) return true;
    }
    return false;
}

/** 节点活跃判定的时间窗口：5 分钟（毫秒值）
 *  原来的 30 秒导致节点在地球上一闪而过看不清，
 *  改为 5 分钟让用户有足够时间观察连接过的所有目的地。
 */
const ACTIVE_WINDOW_MS = 300_000;

/**
 * 【S6 修复】节点注册表清理：过期节点驱逐机制
 * 
 * 问题：nodeRegistry 只有 set 操作没有 delete，长时间运行后会无限膨胀。
 * 例如遭遇扫描或 DDoS 时，数十万不同 IP 会撑爆内存。
 * 
 * 方案：每 60 秒执行一次清理，删除 5 分钟（300 秒）未活跃的节点。
 * 利用 getActiveNodes() 的调用频率（每帧/60fps）搭便车触发清理，
 * 避免创建额外的 setInterval 定时器。
 */
const PURGE_INTERVAL_MS = 60_000;     // 清理检查间隔：60 秒
const PURGE_STALE_MS = 300_000;       // 过期阈值：5 分钟未活跃即清除
let lastPurgeTime = Date.now();

/**
 * 清理过期节点，释放 Map 内存
 * 遍历整个 registry，删除 lastSeen 超过 PURGE_STALE_MS 的节点。
 */
function purgeStaleNodes(): void {
    const now = Date.now();
    const cutoff = now - PURGE_STALE_MS;
    let purgedCount = 0;
    nodeRegistry.forEach((node, ip) => {
        if (node.lastSeen < cutoff) {
            nodeRegistry.delete(ip);
            purgedCount++;
        }
    });
    if (purgedCount > 0) {
        console.log(`[NodeManager] 清理了 ${purgedCount} 个过期节点，当前注册表大小: ${nodeRegistry.size}`);
    }
    lastPurgeTime = now;
}

/**
 * 处理后端推送的 JSON 元数据消息
 * 
 * 根据 type 字段分派到不同的处理逻辑：
 * - "node": 注册或更新节点基础信息（IP、国家、ISP、坐标）
 * - "process": 更新指定 IP 节点关联的进程名称
 * - "traffic": 累加指定 IP 节点的通信字节数
 * 
 * @param jsonStr - 后端发送的原始 JSON 字符串
 */
export function handleMetadata(jsonStr: string): void {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch (err) {
        // JSON 解析失败时打印警告并静默跳过，不阻塞主流程
        console.warn('[NodeManager] JSON 解析失败，已忽略该消息:', err);
        return;
    }

    const msgType = parsed['type'] as string | undefined;
    const ip = parsed['ip'] as string | undefined;

    // 所有消息类型都必须携带 ip 字段，否则无法索引
    if (!ip) {
        console.warn('[NodeManager] 收到缺少 ip 字段的元数据消息，已忽略');
        return;
    }

    // 过滤 RFC 1918 私有 IP 和特殊地址
    // 这些 IP 没有 GeoIP 数据，会被默认放到 (0°N, 0°E) 几内亚湾
    // 产生 "Unknown" 标签的幽灵节点，完全无意义
    if (isPrivateIP(ip)) {
        return; // 静默跳过，不注册为可视化节点
    }

    if (msgType === 'node') {
        // --- 节点注册 / 更新 (Upsert) ---
        const existing = nodeRegistry.get(ip);
        if (existing) {
            // 更新已有节点的字段（保留累计流量和进程名，仅刷新坐标与地理信息）
            existing.country = (parsed['country'] as string) ?? existing.country;
            existing.isp = (parsed['isp'] as string) ?? existing.isp;
            existing.x = (parsed['x'] as number) ?? existing.x;
            existing.y = (parsed['y'] as number) ?? existing.y;
            existing.z = (parsed['z'] as number) ?? existing.z;
            existing.lastSeen = Date.now();
        } else {
            // 创建全新的节点记录
            const newNode: NodeInfo = {
                ip,
                country: (parsed['country'] as string) ?? '未知',
                isp: (parsed['isp'] as string) ?? '未知',
                x: (parsed['x'] as number) ?? 0,
                y: (parsed['y'] as number) ?? 0,
                z: (parsed['z'] as number) ?? 0,
                totalBytes: 0,
                processName: (parsed['processName'] as string) ?? '未知',
                lastSeen: Date.now(),
            };
            nodeRegistry.set(ip, newNode);
        }
    } else if (msgType === 'process') {
        // --- 进程名更新 ---
        const node = nodeRegistry.get(ip);
        if (node) {
            node.processName = (parsed['processName'] as string) ?? node.processName;
            node.lastSeen = Date.now();
        }
    } else if (msgType === 'traffic') {
        // --- 流量累计 ---
        const node = nodeRegistry.get(ip);
        const bytes = (parsed['bytes'] as number) ?? 0;
        if (node) {
            node.totalBytes += bytes;
            node.lastSeen = Date.now();
        }
    }
}

/**
 * 获取所有"活跃"节点列表
 * 
 * 活跃定义：最后一次被观测到的时间在当前时间的 30 秒以内。
 * 用于 Renderer 渲染节点球体和 Raycaster 交互查询。
 * 
 * 【S6 修复】搭便车在此函数中触发定期清理，避免额外定时器开销。
 * 
 * @returns 活跃节点的 NodeInfo 数组
 */
export function getActiveNodes(): NodeInfo[] {
    const now = Date.now();

    // 搭便车触发清理：每 60 秒检查一次过期节点
    if (now - lastPurgeTime > PURGE_INTERVAL_MS) {
        purgeStaleNodes();
    }

    const result: NodeInfo[] = [];
    // 遍历注册表，过滤出活跃窗口内的节点
    nodeRegistry.forEach((node) => {
        if (now - node.lastSeen < ACTIVE_WINDOW_MS) {
            result.push(node);
        }
    });
    return result;
}

/**
 * 按 IP 地址精确查找单个节点
 * 
 * @param ip - 目标 IP 地址字符串
 * @returns 匹配的 NodeInfo 或 undefined（未找到时）
 */
export function getNodeByIp(ip: string): NodeInfo | undefined {
    return nodeRegistry.get(ip);
}
