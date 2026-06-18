import type { IWorld } from 'bitecs';
import { createWorld } from 'bitecs';

/**
 * 扩展标准的 IWorld 接口，加入专门存放时间的字段
 * 利用此技巧在世界上下文中共享 deltaTime，避免系统获取时间时产生闭包函数开销
 */
export interface NetworkMonarchWorld extends IWorld {
  time: {
    delta: number;
    elapsed: number;
  };
}

/**
 * 【M20 修复】安全的世界工厂函数
 * 
 * 注意：bitECS 0.3.40 的 createWorld() 不接受任何参数，
 * 默认 maxEntities = 100,000。传入 { maxEntities } 会被静默忽略。
 * 如需更高上限需升级到 bitECS ^0.4.0。
 * 
 * 使用工厂函数替代 `as unknown as T` 双重断言，
 * 确保 time 属性在导出前已完整初始化，消除模块加载时的 undefined 风险。
 */
function createMonarchWorld(): NetworkMonarchWorld {
    const w = createWorld() as NetworkMonarchWorld;
    // 初始化时间对象属性以锁定对象形态 (prevent object shape transition)，保障 V8 引擎极限性能
    w.time = { delta: 0, elapsed: 0 };
    return w;
}

export const world = createMonarchWorld();
