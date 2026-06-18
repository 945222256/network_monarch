import { defineSystem, defineQuery, removeEntity, addEntity, addComponent } from 'bitecs';
import { Transform, Particle, Appearance, TTL } from './components';
import type { NetworkMonarchWorld } from './world';
import { world } from './world';

/**
 * 活跃实体硬性上限（FATAL-1 修复）
 * 
 * 重要：bitECS 0.3.40 的 createWorld() 不接受 { maxEntities } 参数，
 * 该参数被静默忽略，实际内部上限固定为 100,000。
 * 设置为 80,000（预留 20% 安全余量），避免触碰真实上限导致崩溃。
 * 
 * 如需更高上限，必须升级到 bitECS ^0.4.0 并适配新 API。
 */
const MAX_ACTIVE_ENTITIES = 80_000;

/**
 * 单次 onmessage 回调最大处理数据包数（P0-B 修复）
 * 限制单次 WebSocket 消息回调中创建的实体数量，
 * 防止大批量数据包独占主线程导致渲染帧被饿死。
 * 200 个实体 × 每实体 ~10 次内存写入 ≈ 2000 次操作，约耗时 0.5ms，
 * 对 60fps（16.6ms/帧）的渲染预算影响可接受。
 */
const MAX_PER_BATCH = 200;

/**
 * 全局活跃实体计数器（P1 修复）
 * 替代每次 onmessage 都调用 kinematicQuery(world).length 的高开销查询。
 * 在 addEntity 时 +1，在 removeEntity 时 -1，O(1) 读取。
 */
let globalActiveCount = 0;

// 将 Query 查询实例静态缓存在模块顶级作用域中，防范运行态反复生成查询开销
const kinematicQuery = defineQuery([Transform, Particle]);

/**
 * 动力学系统 (Kinematic System)
 * 职责：依据 `progress` 标量和增量 `delta` 针对 `start` 与 `target` 直接在内存中实施线性插值 (Lerp)
 */
export const kinematicSystem = defineSystem((world: NetworkMonarchWorld) => {
    const { delta } = world.time;
    const entities = kinematicQuery(world);

    // 严禁在此循环内部使用 .forEach(), .map() 或进行任何 { x, y, z } 矢量对象的实例化
    // 全程运用 flat C-style for 循环以达标 Zero-Allocation
    for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        
        // 读取并更新进度值
        let p = Particle.progress[eid];
        p += Particle.speed[eid] * delta;
        if (p > 1.0) p = 1.0; // 进行极简钳制保护
        Particle.progress[eid] = p;

        // 标量级别的数据抽取：直接寻址原始内存以保障性能
        const startX = Particle.start[eid][0];
        const startY = Particle.start[eid][1];
        const startZ = Particle.start[eid][2];

        const targetX = Particle.target[eid][0];
        const targetY = Particle.target[eid][1];
        const targetZ = Particle.target[eid][2];

        // 高效 Inline Math：在同一连续指令流水线中计算插值，并将结果直接压入 ECS 结构体内存
        Transform.position[eid][0] = startX + (targetX - startX) * p;
        Transform.position[eid][1] = startY + (targetY - startY) * p;
        Transform.position[eid][2] = startZ + (targetZ - startZ) * p;
    }

    return world;
});

const ttlQuery = defineQuery([TTL]);

/**
 * 生命周期管理系统 (TTL System)
 * 职责：追踪实体的累积存活时长，当年龄超越限定后将实体摧毁并复用其内存槽位
 */
export const ttlSystem = defineSystem((world: NetworkMonarchWorld) => {
    const { delta } = world.time;
    const entities = ttlQuery(world);

    for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        
        // 累积实体寿命
        TTL.age[eid] += delta;

        // 判定该实体是否生命枯竭，如果是，则安全释放 Entity ID
        if (TTL.age[eid] > TTL.maxAge[eid]) {
            removeEntity(world, eid);
            // 全局计数器同步递减（P1：与 ingestPackets 中的递增配对）
            globalActiveCount = Math.max(0, globalActiveCount - 1);
        }
    }

    return world;
});

/**
 * 封包注入管道 (Ingest Packets)
 * 职责：高效消费外部传来的高密集度 Float32Array 缓冲区
 * 数据排列: [srcX, srcY, srcZ, targetX, targetY, targetZ, protocolId]
 */
export const ingestPackets = (buffer: Float32Array, count: number) => {
    const CHUNK_SIZE = 7;

    // P1 优化：使用全局计数器替代昂贵的 kinematicQuery(world).length
    if (globalActiveCount >= MAX_ACTIVE_ENTITIES) {
        // 实体池已满，静默丢弃本批次数据包，等待 TTL 系统回收腾出空间
        return;
    }

    // 三重限流：取实体池余量、数据包数量、单批上限三者的最小值
    const remaining = MAX_ACTIVE_ENTITIES - globalActiveCount;
    const safeCount = Math.min(count, remaining, MAX_PER_BATCH);

    // 不借助 buffer.slice 等方法，用原始指针偏移 (offset) 手动遍历解析，消灭所有的分配垃圾
        for (let i = 0; i < safeCount; i++) {
            const offset = i * CHUNK_SIZE;
            
            const srcX = buffer[offset];
            const srcY = buffer[offset + 1];
            const srcZ = buffer[offset + 2];
            
            let tgtX = buffer[offset + 3];
            let tgtY = buffer[offset + 4];
            let tgtZ = buffer[offset + 5];
            
            // 如果后端坐标为 (0,0,0)（如私有 IP 等无法查表的情况），
            // 在前端执行球极散射，让未解析的 IP 形成围绕中心的星环。
            if (tgtX === 0 && tgtY === 0 && tgtZ === 0) {
                const r = 800 + Math.random() * 200;
                const theta = (i % 360) * (Math.PI / 180) + Math.random();
                const phi = Math.acos((Math.random() * 2) - 1);
                tgtX = r * Math.sin(phi) * Math.cos(theta);
                tgtY = r * Math.sin(phi) * Math.sin(theta);
                tgtZ = r * Math.cos(phi);
            }
            
            const protocolId = buffer[offset + 6];

            // 安全阀：用 try-catch 包裹 addEntity，防止极端并发下仍然突破上限
            let eid: number;
            try {
                eid = addEntity(world);
            } catch {
                // bitECS 内部 max entities 被触发，立即停止本批次注入
                console.warn('[ECS] 实体池已满，本批次剩余数据包被丢弃');
                return;
            }

            // 装载相关组件标志位
            addComponent(world, Transform, eid);
            addComponent(world, Particle, eid);
            addComponent(world, Appearance, eid);
            addComponent(world, TTL, eid);

            // 全局计数器同步递增（P1：与 ttlSystem 中的递减配对）
            globalActiveCount++;

            // 硬写入：将解码数值录入组件数据层
            Transform.position[eid][0] = srcX;
            Transform.position[eid][1] = srcY;
            Transform.position[eid][2] = srcZ;

            Particle.start[eid][0] = srcX;
            Particle.start[eid][1] = srcY;
            Particle.start[eid][2] = srcZ;

            Particle.target[eid][0] = tgtX;
            Particle.target[eid][1] = tgtY;
            Particle.target[eid][2] = tgtZ;

            // 设置动画进度起始点以及匀速基准
            Particle.progress[eid] = 0.0;
            Particle.speed[eid] = 0.5 + Math.random() * 0.5;

            Appearance.protocolId[eid] = protocolId;

            // 粒子存活时间：3~5 秒
            // 之前设为 10~15 秒导致实体累积速度远超回收速度，直接打爆实体池。
            // 3~5 秒是一个平衡点：足够让粒子完成从起点到终点的飞行动画，
            // 同时在网络空闲时不至于瞬间全黑。
            TTL.age[eid] = 0.0;
            TTL.maxAge[eid] = 3.0 + Math.random() * 2.0; 
    }
};
