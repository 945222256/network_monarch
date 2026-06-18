import { defineComponent, Types } from 'bitecs';

/**
 * Transform 组件
 * 采用 [Types.f32, 3] 定义位置数组 (x, y, z)
 * 严格遵从数据导向设计（SoA），底层在内存池自动分配为连续类型化数组（TypedArray）
 */
export const Transform = defineComponent({
  position: [Types.f32, 3]
});

/**
 * Particle 组件
 * 控制网络粒子的运动轨迹（起点到终点）以及当前的插值进度
 */
export const Particle = defineComponent({
  start: [Types.f32, 3],
  target: [Types.f32, 3],
  progress: Types.f32,
  speed: Types.f32
});

/**
 * Appearance 组件
 * 包含协议对应的唯一标识符，可用于 WebGPU/Three.js 中的 instancing 渲染或着色器数据映射
 */
export const Appearance = defineComponent({
  protocolId: Types.f32
});

/**
 * TTL 组件 (Time To Live)
 * 管理并记录实体的生存时间，当超出 maxAge 将被系统统一回收处理
 */
export const TTL = defineComponent({
  age: Types.f32,
  maxAge: Types.f32
});
