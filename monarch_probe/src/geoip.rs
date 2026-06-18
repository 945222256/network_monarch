//! GeoIP 离线查询引擎
//!
//! 使用 MaxMind MMDB 格式数据库进行 IP 地理位置离线查询，
//! 替代原有 NextTrace 子进程调用方案，避免频繁启动外部进程和 API 频控问题。
//!
//! 依赖：
//!   maxminddb = "0.24"             — MMDB 格式读取
//!   reqwest   = { version = "0.12", features = ["blocking"] } — 同步阻塞 HTTP 下载

use maxminddb::{self, geoip2};
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::SystemTime;

/// MMDB 数据库的下载地址（来自 P3TERX 的 GitHub 镜像，跟踪 MaxMind GeoLite2-City 最新版）
const MMDB_DOWNLOAD_URL: &str =
    "https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-City.mmdb";

/// MMDB 数据库文件名
const MMDB_FILENAME: &str = "GeoLite2-City.mmdb";

/// 数据库过期天数阈值：超过此天数则重新下载
const MAX_AGE_DAYS: u64 = 7;

/// GeoIP 查询结果结构体
#[derive(Debug, Clone)]
pub struct GeoResult {
    /// 纬度（十进制度）
    pub lat: f32,
    /// 经度（十进制度）
    pub lon: f32,
    /// 国家名称（英文）
    pub country: String,
    /// ISP 名称（来自 autonomous_system_organization 字段）
    pub isp: String,
}

impl Default for GeoResult {
    /// 查询失败时返回的默认值：坐标原点、Unknown
    fn default() -> Self {
        Self {
            lat: 0.0,
            lon: 0.0,
            country: "Unknown".to_string(),
            isp: "Unknown".to_string(),
        }
    }
}

/// GeoIP 离线查询引擎
///
/// 内部持有 maxminddb::Reader，程序启动时初始化一次，
/// 后续所有 IP 查询直接走内存映射的 MMDB 文件，零网络开销。
pub struct GeoIpEngine {
    /// MMDB 数据库读取器，数据加载到 Vec<u8> 中
    reader: maxminddb::Reader<Vec<u8>>,
}

impl GeoIpEngine {
    /// 构造函数：确保 MMDB 文件存在且未过期，然后加载到内存
    ///
    /// 流程：
    /// 1. 调用 ensure_mmdb() 检查/下载数据库文件
    /// 2. 使用 maxminddb::Reader::open_readfile 加载
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let mmdb_path = Self::get_mmdb_path();
        Self::ensure_mmdb(&mmdb_path)?;
        println!("[GeoIP] 正在加载 MMDB 数据库: {}", mmdb_path.display());
        let reader = maxminddb::Reader::open_readfile(&mmdb_path)?;
        println!("[GeoIP] MMDB 数据库加载成功");
        Ok(Self { reader })
    }

    /// 获取 MMDB 文件的完整路径：与可执行文件同目录
    fn get_mmdb_path() -> PathBuf {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        exe_dir.join(MMDB_FILENAME)
    }

    /// 确保 MMDB 数据库文件存在且未过期
    ///
    /// 判断逻辑：
    /// - 文件不存在 → 下载
    /// - 文件存在但修改时间超过 MAX_AGE_DAYS 天 → 重新下载
    /// - 文件存在且未过期 → 跳过
    ///
    /// 使用 reqwest::blocking 同步阻塞下载，因为只在启动时调用一次
    fn ensure_mmdb(path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
        if path.exists() {
            if let Ok(metadata) = std::fs::metadata(path) {
                if let Ok(modified) = metadata.modified() {
                    let age = SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default();
                    let age_days = age.as_secs() / 86400;
                    if age_days < MAX_AGE_DAYS {
                        println!(
                            "[GeoIP] MMDB 文件已存在且未过期（{}天前更新），跳过下载",
                            age_days
                        );
                        return Ok(());
                    }
                    println!(
                        "[GeoIP] MMDB 文件已过期（{}天前更新），准备重新下载",
                        age_days
                    );
                }
            }
        } else {
            println!("[GeoIP] MMDB 文件不存在，准备首次下载");
        }

        println!("[GeoIP] 正在从 {} 下载 MMDB 数据库...", MMDB_DOWNLOAD_URL);

        // 【M4 修复】设置 30 秒超时，防止在网络不可达时（如中国大陆 GitHub CDN）永久阻塞
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        let response = client.get(MMDB_DOWNLOAD_URL).send()?;

        if !response.status().is_success() {
            return Err(format!(
                "MMDB 下载失败，HTTP 状态码: {}",
                response.status()
            )
            .into());
        }
        let bytes = response.bytes()?;

        // 【M5 修复】先写入临时文件，成功后再 rename（原子操作）
        // 如果下载中途被中断（如 Ctrl+C），不会留下损坏的 MMDB 文件
        let tmp_path = path.with_extension("mmdb.tmp");
        std::fs::write(&tmp_path, &bytes)?;
        std::fs::rename(&tmp_path, path)?;

        println!(
            "[GeoIP] MMDB 数据库下载完成，大小: {:.2} MB",
            bytes.len() as f64 / 1024.0 / 1024.0
        );
        Ok(())
    }

    /// 根据 IPv4 地址字节查询地理位置信息
    ///
    /// 参数：
    /// - ip_bytes: IPv4 地址的 4 字节数组（网络字节序，即大端序）
    ///
    /// 返回：
    /// - GeoResult 包含 lat, lon, country, isp
    /// - 查询失败时静默返回默认值 (0.0, 0.0, "Unknown", "Unknown")
    pub fn lookup(&self, ip_bytes: [u8; 4]) -> GeoResult {
        let ip = IpAddr::from(ip_bytes);

        let city: geoip2::City = match self.reader.lookup(ip) {
            Ok(c) => c,
            Err(_) => return GeoResult::default(),
        };

        let (lat, lon) = city
            .location
            .as_ref()
            .map(|loc| {
                (
                    loc.latitude.unwrap_or(0.0) as f32,
                    loc.longitude.unwrap_or(0.0) as f32,
                )
            })
            .unwrap_or((0.0, 0.0));

        let country = city
            .country
            .as_ref()
            .and_then(|c| {
                c.names
                    .as_ref()
                    .and_then(|n| n.get("en").map(|s| s.to_string()))
            })
            .unwrap_or_else(|| "Unknown".to_string());

        // 提取 ISP 信息
        // 注意：GeoLite2-City 免费版的 Traits 结构体中不包含 isp / organization /
        // autonomous_system_organization 字段（这些仅在付费版 GeoIP2-ISP 中可用）。
        // 因此此处直接回退为 "Unknown"。
        // 如果未来升级到付费版数据库，可在此处扩展提取逻辑。
        let isp = "Unknown".to_string();

        GeoResult {
            lat,
            lon,
            country,
            isp,
        }
    }

    /// 便捷方法：直接将 IPv4 地址转换为 3D 球面坐标 (x, y, z)
    ///
    /// 使用标准球面坐标转换公式：
    ///   x = radius * cos(lat_rad) * sin(lon_rad)
    ///   y = radius * sin(lat_rad)
    ///   z = radius * cos(lat_rad) * cos(lon_rad)
    pub fn lookup_xyz(&self, ip_bytes: [u8; 4], radius: f32) -> (f32, f32, f32) {
        let geo = self.lookup(ip_bytes);
        let lat_rad = geo.lat.to_radians();
        let lon_rad = geo.lon.to_radians();
        let x = radius * lat_rad.cos() * lon_rad.sin();
        let y = radius * lat_rad.sin();
        let z = radius * lat_rad.cos() * lon_rad.cos();
        (x, y, z)
    }
}
