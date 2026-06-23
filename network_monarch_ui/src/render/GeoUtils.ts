/**
 * GeoUtils.ts - 地球测地线（大圆弧）几何计算工具
 * 
 * 用于在 Three.js 球面上绘制两点之间的最短路径弧线，
 * 替代穿过球体内部的直线连接。
 */
import * as THREE from 'three';

/** 地球投影半径，与后端 lat_lon_to_xyz(lat, lon, 300.0) 一致 */
export const GLOBE_RADIUS = 300;

/** 弧线抬升高度系数：弧线在球面上方的最大偏移 = 两点距离 * 此系数 */
const ARC_LIFT_FACTOR = 0.15;

/**
 * 在球面上计算两点之间的大圆弧（测地线）路径
 * 
 * 核心数学：
 * 给定球面上两个 3D 点 A 和 B，大圆弧是连接它们的最短球面路径。
 * 使用球面线性插值 (slerp) 计算弧上的中间点，
 * 并在弧线最高点添加额外的径向抬升，使弧线在球面上方微微隆起，
 * 增强视觉层次感。
 * 
 * @param startPos - 起点 3D 坐标（已在球面上）
 * @param endPos   - 终点 3D 坐标（已在球面上）
 * @param segments - 弧线分段数（影响平滑度，默认 32）
 * @returns Float32Array 包含 (segments+1) 个 3D 顶点
 */
export function computeGeodesicArc(
    startPos: THREE.Vector3,
    endPos: THREE.Vector3,
    segments: number = 32
): Float32Array {
    const points = new Float32Array((segments + 1) * 3);

    // 将两个坐标归一化为球面单位向量
    const startDir = startPos.clone().normalize();
    const endDir = endPos.clone().normalize();

    // 两向量之间的夹角（用于 slerp 和抬升计算）
    const angle = startDir.angleTo(endDir);

    // 弧线最高点的额外抬升量（弧越长，抬升越高）
    const liftHeight = angle * GLOBE_RADIUS * ARC_LIFT_FACTOR;

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;

        // 球面线性插值 (slerp)
        // 计算球面上 t 处的方向向量
        const sinAngle = Math.sin(angle);
        let interpDir: THREE.Vector3;

        if (sinAngle < 0.001) {
            // 两点几乎重合时退化为线性插值
            interpDir = startDir.clone().lerp(endDir, t);
        } else {
            // 标准 slerp 公式
            const factorA = Math.sin((1 - t) * angle) / sinAngle;
            const factorB = Math.sin(t * angle) / sinAngle;
            interpDir = startDir.clone().multiplyScalar(factorA)
                .add(endDir.clone().multiplyScalar(factorB));
        }

        // 抬升计算：sin(π*t) 使弧线在中点最高（t=0.5 时 sin=1）
        const lift = Math.sin(Math.PI * t) * liftHeight;

        // 最终坐标 = 单位方向 × (球面半径 + 抬升)
        const radius = GLOBE_RADIUS + lift;
        interpDir.normalize().multiplyScalar(radius);

        points[i * 3 + 0] = interpDir.x;
        points[i * 3 + 1] = interpDir.y;
        points[i * 3 + 2] = interpDir.z;
    }

    return points;
}

/**
 * 用 Canvas 2D 程序化生成暗黑风格地球纹理
 * 
 * 在无法下载外部纹理时作为后备方案。
 * 绘制简化的大陆轮廓（主要洲际）+ 经纬线网格。
 * 等距矩形投影 (Equirectangular Projection)。
 * 
 * @param width  - 纹理宽度（像素），默认 2048
 * @param height - 纹理高度（像素），默认 1024
 * @returns THREE.CanvasTexture 实例
 */
export function generateProceduralEarthTexture(
    width: number = 2048,
    height: number = 1024
): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    // 深海背景
    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, width, height);

    // 经纬线网格（暗色参考线）
    ctx.strokeStyle = 'rgba(20, 60, 100, 0.15)';
    ctx.lineWidth = 1;
    // 纬线：每 15°
    for (let lat = -75; lat <= 75; lat += 15) {
        const y = ((90 - lat) / 180) * height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    // 经线：每 15°
    for (let lon = -180; lon <= 180; lon += 15) {
        const x = ((lon + 180) / 360) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    // 赤道线（更亮）
    ctx.strokeStyle = 'rgba(40, 100, 160, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // ===== 简化大陆轮廓 =====
    // 使用极度简化的多边形近似各大洲轮廓
    // 坐标格式：[lon, lat] → 转换为像素坐标
    ctx.fillStyle = 'rgba(15, 40, 60, 0.6)';
    ctx.strokeStyle = 'rgba(40, 120, 180, 0.4)';
    ctx.lineWidth = 1.5;

    const continents: [number, number][][] = [
        // 北美洲（极简轮廓）
        [[-130,50],[-125,60],[-100,65],[-80,60],[-60,50],[-65,45],[-80,25],[-100,20],[-105,25],[-120,35],[-130,50]],
        // 南美洲
        [[-80,10],[-60,5],[-35,-5],[-35,-20],[-40,-25],[-55,-35],[-70,-55],[-75,-45],[-70,-20],[-80,-5],[-80,10]],
        // 欧洲
        [[-10,36],[0,44],[5,48],[15,55],[30,60],[40,55],[30,45],[25,40],[15,38],[5,36],[-10,36]],
        // 非洲
        [[-15,15],[-15,30],[0,35],[10,35],[35,30],[50,12],[40,0],[30,-10],[35,-35],[20,-35],[15,-25],[10,-5],[-5,5],[-15,15]],
        // 亚洲（简化）
        [[30,35],[40,45],[60,55],[80,55],[100,50],[120,55],[130,45],[140,35],[120,25],[105,20],[100,10],[80,10],[70,25],[60,30],[40,30],[30,35]],
        // 澳大利亚
        [[115,-15],[130,-12],[150,-15],[155,-25],[150,-38],[130,-35],[115,-25],[115,-15]],
    ];

    for (const continent of continents) {
        ctx.beginPath();
        for (let i = 0; i < continent.length; i++) {
            const [lon, lat] = continent[i];
            const px = ((lon + 180) / 360) * width;
            const py = ((90 - lat) / 180) * height;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // 城市亮点（模拟夜间灯光）
    const cities: [number, number][] = [
        // 亚洲
        [121.47, 31.23], [116.39, 39.91], [139.69, 35.69], [126.98, 37.57], [100.51, 13.76],
        [72.88, 19.08], [77.21, 28.61], [103.85, 1.35],
        // 欧洲
        [-0.12, 51.51], [2.35, 48.86], [13.41, 52.52], [-3.70, 40.42], [12.50, 41.90],
        [37.62, 55.75],
        // 北美
        [-73.94, 40.67], [-118.24, 34.05], [-87.63, 41.88], [-122.42, 37.77], [-99.13, 19.43],
        // 南美
        [-43.17, -22.91], [-46.63, -23.55], [-58.38, -34.60],
        // 非洲
        [31.23, 30.04], [28.05, -26.20],
        // 大洋洲
        [151.21, -33.87], [174.78, -36.85],
    ];

    for (const [lon, lat] of cities) {
        const px = ((lon + 180) / 360) * width;
        const py = ((90 - lat) / 180) * height;

        // 发光效果：多层圆形从大到小、从暗到亮
        const gradient = ctx.createRadialGradient(px, py, 0, px, py, 8);
        gradient.addColorStop(0, 'rgba(100, 180, 255, 0.8)');
        gradient.addColorStop(0.3, 'rgba(60, 120, 200, 0.4)');
        gradient.addColorStop(1, 'rgba(30, 80, 150, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
}
