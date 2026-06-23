import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
// WebGPURenderer 必须使用 three/webgpu 导入以支持 TSL
import { WebGPURenderer } from 'three/webgpu';
// OrbitControls 提供鼠标拖拽旋转、滚轮缩放、右键平移的 3D 交互能力
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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
        camera.position.set(0, 200, 1200);

        // ======== OrbitControls 3D 交互系统 ========
        // 左键拖拽 = 轨道旋转，滚轮 = 缩放，右键 = 平移
        const controls = new OrbitControls(camera, canvas);
        controls.enableDamping = true;        // 启用惯性阻尼，操作手感更顺滑
        controls.dampingFactor = 0.08;        // 阻尼系数
        controls.minDistance = 200;           // 最近缩放距离
        controls.maxDistance = 5000;          // 最远缩放距离
        controls.autoRotate = true;           // 默认开启自动旋转（类似展厅效果）
        controls.autoRotateSpeed = 0.5;       // 自动旋转速度（较慢，营造氛围感）
        controls.target.set(0, 0, 0);         // 旋转中心 = 世界原点

        // 用户交互时暂停自动旋转，5 秒无操作后恢复
        let userInteractionTimer: ReturnType<typeof setTimeout> | null = null;
        const pauseAutoRotate = () => {
            controls.autoRotate = false;
            if (userInteractionTimer) clearTimeout(userInteractionTimer);
            userInteractionTimer = setTimeout(() => {
                controls.autoRotate = true;
            }, 5000); // 5 秒无操作后恢复自动旋转
        };
        controls.addEventListener('start', pauseAutoRotate);

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

        // ======== 线框地球 (Wireframe Globe) ========
        // 半径 300 与后端 lat_lon_to_xyz(lat, lon, 300.0) 匹配
        // 提供地理位置参照，让蓝色节点的位置有直观意义
        const GLOBE_RADIUS = 300;

        // 主球体轮廓线（经纬网格）
        const globeGeo = new THREE.SphereGeometry(GLOBE_RADIUS, 36, 18);
        const globeEdges = new THREE.EdgesGeometry(globeGeo);
        const globeWire = new THREE.LineSegments(
            globeEdges,
            new THREE.LineBasicMaterial({ color: 0x1a3a5c, transparent: true, opacity: 0.25 })
        );
        scene.add(globeWire);
        globeGeo.dispose(); // EdgesGeometry 已复制数据，释放原始几何体

        // 赤道环（更亮，作为南北半球的参照）
        const equatorGeo = new THREE.RingGeometry(GLOBE_RADIUS - 0.5, GLOBE_RADIUS + 0.5, 128);
        const equatorMat = new THREE.MeshBasicMaterial({
            color: 0x2a6496, transparent: true, opacity: 0.4, side: THREE.DoubleSide
        });
        const equator = new THREE.Mesh(equatorGeo, equatorMat);
        equator.rotation.x = Math.PI / 2; // 水平放置
        scene.add(equator);

        // ======== 节点球体 InstancedMesh ========
        // 用于渲染从 NodeManager 获取的活跃网络节点位置，
        // 与粒子流的 InstancedMesh 独立，使用标准 instanceMatrix 路径
        // 以支持 Three.js 的 Raycaster 交互拾取。
        const NODE_MAX_COUNT = 2000;
        const nodeSphereGeo = new THREE.SphereGeometry(14, 16, 16); // 半径 14（原 8），更清晰可辨
        const nodeSphereMat = new THREE.MeshBasicMaterial({
            color: 0x4db8ff,
            transparent: true,
            opacity: 0.85,
        });
        const nodeMesh = new THREE.InstancedMesh(nodeSphereGeo, nodeSphereMat, NODE_MAX_COUNT);
        nodeMesh.frustumCulled = false;
        nodeMesh.count = 0;
        scene.add(nodeMesh);

        // 复用单个 Matrix4 对象来设置每个节点实例的位置变换
        const nodeMatrix = new THREE.Matrix4();

        // ======== 连接线（球心 → 节点射线） ========
        // 每帧动态更新，可视化从用户位置到各目标服务器的连接方向
        const CONNECTION_LINE_MAX = 2000;
        const linePositions = new Float32Array(CONNECTION_LINE_MAX * 2 * 3); // 每条线 2 个顶点 × 3 坐标
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
        lineGeo.setDrawRange(0, 0); // 初始无线段
        const lineMat = new THREE.LineBasicMaterial({
            color: 0x1a8cff, transparent: true, opacity: 0.3
        });
        const connectionLines = new THREE.LineSegments(lineGeo, lineMat);
        connectionLines.frustumCulled = false;
        scene.add(connectionLines);

        // ======== 节点文字标签（Sprite + CanvasTexture） ========
        // 在每个节点球体旁显示 "国家 | IP" 文字，让用户一眼知道流量去了哪里
        const labelSprites: THREE.Sprite[] = [];
        const labelSpritePool: THREE.Sprite[] = []; // 对象池：回收不再使用的 Sprite

        /**
         * 从 Canvas 生成文字纹理的 Sprite
         * @param text - 要显示的文字（如 "US | 142.250.72.14"）
         * @returns THREE.Sprite 实例
         */
        function createLabelSprite(text: string): THREE.Sprite {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d')!;
            canvas.width = 512;
            canvas.height = 64;

            // 半透明黑底 + 青蓝色文字
            ctx.fillStyle = 'rgba(5, 10, 20, 0.7)';
            ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
            ctx.fill();

            ctx.font = 'bold 28px Consolas, monospace';
            ctx.fillStyle = '#4db8ff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, canvas.width / 2, canvas.height / 2);

            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearFilter;
            const spriteMat = new THREE.SpriteMaterial({
                map: texture, transparent: true, depthTest: false
            });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.scale.set(120, 15, 1); // 宽 120、高 15 的世界单位标签
            return sprite;
        }

        /** 回收所有现有标签 Sprite 到对象池 */
        function recycleLabelSprites(): void {
            for (const sprite of labelSprites) {
                scene.remove(sprite);
                labelSpritePool.push(sprite);
            }
            labelSprites.length = 0;
        }

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
            controls.update(); // resize 后同步更新 controls
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

            // E. 更新 OrbitControls（处理惯性阻尼和自动旋转）
            controls.update();

            // F. 更新节点球体 InstancedMesh + 连接线 + 标签
            cachedActiveNodes = getActiveNodes();
            const nodeCount = Math.min(cachedActiveNodes.length, NODE_MAX_COUNT);

            // F1. 更新节点球体位置
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

            // F2. 更新连接线（球心 → 每个节点的射线）
            const lineVertexCount = nodeCount * 2; // 每条线段 2 个顶点
            for (let li = 0; li < nodeCount; li++) {
                const nd = cachedActiveNodes[li];
                const base = li * 6; // 2 顶点 × 3 坐标
                // 起点：球心 (0, 0, 0)
                linePositions[base + 0] = 0;
                linePositions[base + 1] = 0;
                linePositions[base + 2] = 0;
                // 终点：节点位置
                linePositions[base + 3] = nd.x;
                linePositions[base + 4] = nd.y;
                linePositions[base + 5] = nd.z;
            }
            lineGeo.setDrawRange(0, lineVertexCount);
            (lineGeo.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;

            // F3. 更新文字标签（每秒最多更新一次，避免频繁 Canvas 重绘）
            // 仅在节点数量变化时重建标签
            if (labelSprites.length !== nodeCount) {
                recycleLabelSprites();
                for (let si = 0; si < nodeCount; si++) {
                    const nd = cachedActiveNodes[si];
                    const labelText = `${nd.country} | ${nd.ip}`;
                    let sprite: THREE.Sprite;
                    if (labelSpritePool.length > 0) {
                        sprite = labelSpritePool.pop()!;
                        // 更新已回收 Sprite 的纹理内容
                        const oldMat = sprite.material as THREE.SpriteMaterial;
                        if (oldMat.map) oldMat.map.dispose();
                        const newSprite = createLabelSprite(labelText);
                        oldMat.map = (newSprite.material as THREE.SpriteMaterial).map;
                        oldMat.needsUpdate = true;
                        newSprite.material.dispose(); // 释放临时材质
                    } else {
                        sprite = createLabelSprite(labelText);
                    }
                    // 标签定位在节点球体上方 25 个单位
                    sprite.position.set(nd.x, nd.y + 25, nd.z);
                    scene.add(sprite);
                    labelSprites.push(sprite);
                }
            } else {
                // 数量不变时只更新位置（节点可能移动了）
                for (let si = 0; si < nodeCount; si++) {
                    const nd = cachedActiveNodes[si];
                    labelSprites[si].position.set(nd.x, nd.y + 25, nd.z);
                }
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
            controls.removeEventListener('start', pauseAutoRotate);
            controls.dispose();
            if (userInteractionTimer) clearTimeout(userInteractionTimer);
            renderer.setAnimationLoop(null);
            if (renderer.dispose) renderer.dispose();
            geometry.dispose();
            material.dispose();
            nodeSphereGeo.dispose();
            nodeSphereMat.dispose();
            // 清理地球相关资源
            globeEdges.dispose();
            globeWire.material.dispose();
            equatorGeo.dispose();
            equatorMat.dispose();
            // 清理连接线
            lineGeo.dispose();
            lineMat.dispose();
            // 清理标签 Sprite
            recycleLabelSprites();
            for (const pooled of labelSpritePool) {
                const mat = pooled.material as THREE.SpriteMaterial;
                if (mat.map) mat.map.dispose();
                mat.dispose();
            }
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
