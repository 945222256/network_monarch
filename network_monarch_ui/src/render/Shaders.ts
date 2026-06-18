import * as THREE from 'three';
import { 
    attribute, 
    color, 
    select, 
    positionLocal,
    equal,
    float,
    vec3
} from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

/**
 * 构造用于海量网络节点流的 TSL 节点材质 (WebGPU/WebGL 兼容)
 * 严格秉承 DoD 范式：在 CPU 这端只塞入无状态特征值，颜色逻辑计算推至 GPU 端执行。
 */
export const createParticleMaterial = (): MeshBasicNodeMaterial => {
    // 1. 获取 InstancedMesh 外部注入的自定义 GPU TypedArray 属性 
    // protocolId：来源于 ECS 的 Appearance.protocolId 数据
    // @ts-ignore - Ignore TSL definition mismatch for AttributeNode in 0.184.0
    const protocolId = float(attribute('protocolId', 'float'));
    
    // instancePosition：来源于 ECS 的 Transform.position 数据 (零额外分配封装)
    // @ts-ignore
    const instancePos = vec3(attribute('instancePosition', 'vec3'));

    // 2. 定义 WebGPU 着色器层面的显存颜色常量 (Constant Nodes)
    const colorHttp = color(0xff3333); // 协议1.0 -> HTTP: 红色
    const colorDns  = color(0x33ff33); // 协议2.0 -> DNS:  绿色
    const colorTcp  = color(0x3333ff); // 协议3.0 -> TCP:  蓝色
    const colorDefault = color(0xaaaaaa); // 其他 -> 未知: 灰色

    // 3. 构建 Look-Up Table (LUT) GPU 分支树
    // 利用 TSL 的 select() 函数创建像素并发判断的 Shader Node。
    // 这取代了必须用 JS 进行 `byte[i] = r; byte[i+1] = g;` 的缓慢颜色矩阵拼接。
    // @ts-ignore
    const particleColor = select(
        // @ts-ignore
        equal(protocolId, 1.0), colorHttp,
        select(
            // @ts-ignore
            equal(protocolId, 2.0), colorDns,
            select(
                // @ts-ignore
                equal(protocolId, 3.0), colorTcp,
                colorDefault
            )
        )
    );

    // 4. 重构顶点变换矩阵树
    // 传统的 InstancedMesh 依赖 instanceMatrix 更新（16个float带来极大的带宽消耗）。
    // 在这里，我们将基础平面的本地坐标 (positionLocal) 与我们一维映射的实体三维坐标 (instancePos) 相加，
    // 完成了极低消耗的变换。每个粒子单帧变换开销瞬间暴降 ~81% (从 16降至3)。
    const finalPosition = positionLocal.add(instancePos);

    // 5. 将运算流构建入 WebGPU 的 MeshBasicNodeMaterial
    const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false, // 禁用深度写入消除粒子相互穿插切割引发的 Z-fighting 与伪影
        blending: THREE.AdditiveBlending, // 网络图谱中经典的 “叠加发光” 效果，视觉冲击更强
    });

    // 替换材质核心着色行为与坐标转换行为
    material.colorNode = particleColor;
    material.positionNode = finalPosition;

    return material;
};
