import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
// WebGPURenderer 必须使用 three/webgpu 导入以支持 TSL
import { WebGPURenderer } from 'three/webgpu';

// 导入基于 TSL 构造的节点材质
import { createParticleMaterial } from './Shaders';

// 假设我们的 ECS 模块路径，按实际项目结构适配
import { world } from '../ecs/world';
import { Transform, Appearance } from '../ecs/components';
import { kinematicSystem, ttlSystem } from '../ecs/systems';

// I will define particleQuery here to avoid circular dependencies if it was missing from exports.
import { defineQuery } from 'bitecs';
import { Particle } from '../ecs/components';
import { getActiveNodes } from '../ecs/NodeManager';
import type { NodeInfo } from '../ecs/NodeManager';
const renderParticleQuery = defineQuery([Transform, Particle]);

/** Renderer 组件的 Props 接口 */
interface RendererProps {
    /**
     * 节点悬停回调：当鼠标悬停在某个节点球体上时被调用，
     * 传递节点信息和屏幕坐标；鼠标离开时以 (null, null) 调用。
     */
    onNodeHover?: (node: NodeInfo | null, screenPos: { x: number; y: number } | null) => void;
}

export const Renderer: React.FC<RendererProps> = ({ onNodeHover }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current) return;
        // 【M17 修复】将 canvasRef.current 保存到局部变量，
        // 确保 cleanup 函数执行时 ref 已被 React 置为 null 的场景下仍可正确移除事件监听
        const canvas = canvasRef.current;

        // 1. 初始化高能效的 WebGPURenderer
        const renderer = new WebGPURenderer({
            canvas: canvasRef.current,
            antialias: false, // 在 10 万+ 粒子级别下，关闭抗锯齿大幅提升吞吐量
            powerPreference: 'high-performance',
        });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050505);

        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
        camera.position.z = 1000;

        // 2. 几何体与材质的零分配初始化
        // bitECS 0.3.x 的数组组件 [Types.f32, 3] 是嵌套结构 Array<Float32Array>，
        // 其 .length 直接等于 maxEntities（默认 100,000），不需要除以 3。
        // 【FATAL-2 修复】之前错误地除以 3 导致 InstancedMesh 和 buffer 只有正确大小的 1/3。
        const maxParticles = Transform.position.length;
        
        // 所有的网络粒子复用同一个极简的四边形作为基础单元
        const geometry = new THREE.PlaneGeometry(2, 2);
        const material = createParticleMaterial();

        const mesh = new THREE.InstancedMesh(geometry, material, maxParticles);
        
        // 关键优化：我们的粒子是在 GPU 与 ECS 中驱动的，
        // Three 内部的 BoundingBox 算法追踪不到实例化粒子的坐标变化，
        // 必须关闭视锥体裁剪，防止它在超出视野时被异常剔除。
        mesh.frustumCulled = false;

        // 3. DoD 数据绑定核心：分配致密显存缓冲区 (Dense Buffer)
        // 规避 bitecs 实体 ID 稀疏性导致的 Three.js 幽灵粒子问题
        const renderPositionData = new Float32Array(maxParticles * 3);
        const renderProtocolData = new Float32Array(maxParticles * 1);

        const instancePositionAttr = new THREE.InstancedBufferAttribute(renderPositionData, 3);
        instancePositionAttr.setUsage(THREE.DynamicDrawUsage);
        mesh.geometry.setAttribute('instancePosition', instancePositionAttr);

        // protocolId 作为一维属性提供给 GPU 内核里的 TSL 计算出最终的颜色 (LUT)
        const protocolIdAttr = new THREE.InstancedBufferAttribute(renderProtocolData, 1);
        protocolIdAttr.setUsage(THREE.DynamicDrawUsage);
        mesh.geometry.setAttribute('protocolId', protocolIdAttr);

        scene.add(mesh);

        // ======== 节点球体 InstancedMesh ========
        // 用于渲染从 NodeManager 获取的活跃网络节点位置，
        // 与粒子流的 InstancedMesh 独立，使用标准 instanceMatrix 路径
        // 以支持 Three.js 的 Raycaster 交互拾取。
        const NODE_MAX_COUNT = 2000;
        const nodeSphereGeo = new THREE.SphereGeometry(8, 16, 16);
        const nodeSphereMat = new THREE.MeshBasicMaterial({
            color: 0x4db8ff,
            transparent: true,
            opacity: 0.8,
        });
        const nodeMesh = new THREE.InstancedMesh(nodeSphereGeo, nodeSphereMat, NODE_MAX_COUNT);
        nodeMesh.frustumCulled = false;
        nodeMesh.count = 0;
        scene.add(nodeMesh);

        // 复用单个 Matrix4 对象来设置每个节点实例的位置变换
        const nodeMatrix = new THREE.Matrix4();

        // ======== Raycaster 交互系统 ========
        const raycaster = new THREE.Raycaster();
        const pointerNDC = new THREE.Vector2();
        let cachedActiveNodes: NodeInfo[] = [];

        /** 处理鼠标位置并执行 Raycaster 检测 */
        const performRaycast = (clientX: number, clientY: number): {
            node: NodeInfo;
            screenPos: { x: number; y: number };
        } | null => {
            pointerNDC.x = (clientX / window.innerWidth) * 2 - 1;
            pointerNDC.y = -(clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(pointerNDC, camera);
            const intersects = raycaster.intersectObject(nodeMesh);
            if (intersects.length > 0) {
                const instanceId = intersects[0].instanceId;
                if (instanceId !== undefined && instanceId < cachedActiveNodes.length) {
                    return {
                        node: cachedActiveNodes[instanceId],
                        screenPos: { x: clientX, y: clientY },
                    };
                }
            }
            return null;
        };

        // ======== 鼠标事件监听（P2：节流 100ms） ========
        let lastRaycastTime = 0;
        const RAYCAST_THROTTLE_MS = 100; // 每 100ms 最多做一次射线检测

        const handleMouseMove = (event: MouseEvent) => {
            const now = performance.now();
            if (now - lastRaycastTime < RAYCAST_THROTTLE_MS) return;
            lastRaycastTime = now;

            const result = performRaycast(event.clientX, event.clientY);
            if (result) {
                onNodeHover?.(result.node, result.screenPos);
            } else {
                onNodeHover?.(null, null);
            }
        };

        canvasRef.current.addEventListener('mousemove', handleMouseMove);

        // 响应式 Resize
        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        let lastTime = performance.now();

        // 4. 使用 renderer.setAnimationLoop 替代原生的 rAF，以原生支持 WebGPU 的异步渲染机制
        const tick = () => {
            const now = performance.now();
            world.time.delta = (now - lastTime) / 1000;
            world.time.elapsed += world.time.delta;
            lastTime = now;

            // A. 执行 ECS System：更新逻辑直写 TypedArray 数组，缓存命中率极高
            kinematicSystem(world);
            ttlSystem(world);

            // B. 获取当前存活的粒子列表
            const activeEntities = renderParticleQuery(world);
            const activeCount = activeEntities.length;

            // C. 数据致密打包 (Dense Packing)
            // 实体 ID 在 bitecs 中并非完美连续（因死亡而被反复复用）。
            // 若直接将 Transform.position 绑定给显卡，会导致 GPU 读到大量已死亡实体 (其 ID 的 slot 内的陈旧脏数据) 的坐标。
            // 因此必须经过一轮极速内存拷贝，将所有活体数据密集排列至缓冲区前列。
            for (let i = 0; i < activeCount; i++) {
                const eid = activeEntities[i];
                renderPositionData[i * 3 + 0] = Transform.position[eid][0];
                renderPositionData[i * 3 + 1] = Transform.position[eid][1];
                renderPositionData[i * 3 + 2] = Transform.position[eid][2];
                renderProtocolData[i] = Appearance.protocolId[eid];
            }

            // D. 动态裁剪 Render Pipeline 的 Draw Call 指令
            mesh.count = activeCount;

            // D. 向显存标记脏缓冲区
            // 这个操作不会生成新的内存对象，仅触发现有的 BufferDMA 传输
            if (activeCount > 0) {
                instancePositionAttr.needsUpdate = true;
                protocolIdAttr.needsUpdate = true;
            }

            // E. 让摄像机缓慢旋转，增加 3D 纵深感
            camera.position.x = Math.sin(world.time.elapsed * 0.1) * 1200;
            camera.position.z = Math.cos(world.time.elapsed * 0.1) * 1200;
            camera.lookAt(0, 0, 0);

            // F. 更新节点球体 InstancedMesh
            cachedActiveNodes = getActiveNodes();
            const nodeCount = Math.min(cachedActiveNodes.length, NODE_MAX_COUNT);
            for (let ni = 0; ni < nodeCount; ni++) {
                const nodeInfo = cachedActiveNodes[ni];
                nodeMatrix.identity();
                nodeMatrix.setPosition(nodeInfo.x, nodeInfo.y, nodeInfo.z);
                nodeMesh.setMatrixAt(ni, nodeMatrix);
            }
            nodeMesh.count = nodeCount;
            if (nodeCount > 0) {
                nodeMesh.instanceMatrix.needsUpdate = true;
            }

            // G. WebGPU 提交渲染
            // 【M11 修复】捕获 renderAsync 的 Promise 拒绝，防止设备丢失时产生 unhandled rejection
            renderer.renderAsync(scene, camera).catch((err: unknown) => {
                console.error('[Renderer] WebGPU 渲染异常:', err);
            });
        };

        renderer.setAnimationLoop(tick);

        // 组件销毁时的清理闭包
        return () => {
            window.removeEventListener('resize', handleResize);
            // 【M17 修复】使用局部变量 canvas 而非 canvasRef.current
            canvas.removeEventListener('mousemove', handleMouseMove);
            renderer.setAnimationLoop(null);
            if (renderer.dispose) renderer.dispose();
            geometry.dispose();
            material.dispose();
            nodeSphereGeo.dispose();
            nodeSphereMat.dispose();
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{ 
                display: 'block', 
                width: '100vw', 
                height: '100vh', 
                overflow: 'hidden' 
            }}
        />
    );
};
