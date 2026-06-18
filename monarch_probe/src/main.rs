mod ndpi_ffi;
mod trace;
mod geoip;  // GeoIP 离线查询引擎模块
use etherparse::{SlicedPacket, TransportSlice};
use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo};
use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;
use sysinfo::{System, ProcessesToUpdate};
use windivert::prelude::*;
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;  // 用于构造 Binary/Text 双轨帧

#[derive(Default)]
struct TrafficStats {
    bytes_up: usize,
    bytes_down: usize,
}

fn lat_lon_to_xyz(lat: f32, lon: f32, radius: f32) -> (f32, f32, f32) {
    let lat_rad = lat.to_radians();
    let lon_rad = lon.to_radians();
    let x = radius * lat_rad.cos() * lon_rad.sin();
    let y = radius * lat_rad.sin();
    let z = radius * lat_rad.cos() * lon_rad.cos();
    (x, y, z)
}

fn main() -> Result<(), Box<dyn Error>> {
    println!("Monarch Probe starting... initializing L0/L1 abyss.");

    // ===== 初始化离线 GeoIP 查询引擎 =====
    // 替代原有 NextTrace 子进程方案，消除外部 API 调用和进程启动开销
    let geo_engine = match geoip::GeoIpEngine::new() {
        Ok(engine) => {
            println!("[启动] GeoIP 离线引擎初始化成功");
            std::sync::Arc::new(engine)
        }
        Err(e) => {
            panic!("[启动] GeoIP 引擎初始化失败，无法继续: {}", e);
        }
    };

    let ndpi_mod = unsafe {
        println!("Initializing nDPI...");
        let m = ndpi_ffi::ndpi_init_detection_module(std::ptr::null_mut());
        if m.is_null() {
            panic!("Failed to initialize nDPI detection module!");
        }

        // Finalize initialization (this enables all protocols and prepares the engine)
        if ndpi_ffi::ndpi_finalize_initialization(m) != 0 {
            panic!("Failed to finalize nDPI initialization!");
        }

        println!("nDPI module initialized successfully at {:?}", m);
        m
    };

    let port_to_pid = Arc::new(RwLock::new(HashMap::<u16, u32>::new()));
    let pid_to_name = Arc::new(RwLock::new(HashMap::<u32, String>::new()));
    let traffic_stats = Arc::new(RwLock::new(HashMap::<u32, TrafficStats>::new()));
    let ip_to_xyz = Arc::new(RwLock::new(HashMap::<u32, (f32, f32, f32)>::new()));
    
    // Default local machine location (e.g., somewhere central or your actual lat/lon)
    let local_xyz = lat_lon_to_xyz(30.0, 120.0, 300.0);

    let (ws_tx, _) = tokio::sync::broadcast::channel::<[f32; 7]>(100000);
    let ws_tx_clone = ws_tx.clone();

    // Text 帧广播通道：用于向前端推送 JSON 格式的节点元数据（国家、ISP 等）
    let (ws_text_tx, _) = tokio::sync::broadcast::channel::<String>(1000);
    let ws_text_tx_clone = ws_text_tx.clone();

    // Thread 0: WebSocket 服务器
    // 同时监听 Binary 通道（数据包可视化）和 Text 通道（节点元数据 JSON）
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            // 【M21 修复】WebSocket 绑定失败时打印错误而非静默忽略
            match tokio::net::TcpListener::bind("127.0.0.1:1421").await {
                Ok(listener) => {
                println!("[WebSocket] 服务器已在 127.0.0.1:1421 启动监听");
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        let mut bin_rx = ws_tx_clone.subscribe();
                        let mut text_rx = ws_text_tx_clone.subscribe();
                        tokio::spawn(async move {
                            if let Ok(mut ws_stream) = tokio_tungstenite::accept_async(stream).await {
                                println!("[WebSocket] 前端客户端已连接");
                                let mut buffer = Vec::new();
                                let mut last_send = std::time::Instant::now();
                                loop {
                                    tokio::select! {
                                        // 接收 Binary 数据包（[f32; 7] 的可视化数据）
                                        result = bin_rx.recv() => {
                                            match result {
                                                Ok(data) => {
                                                    for f in data.iter() {
                                                        buffer.extend_from_slice(&f.to_ne_bytes());
                                                    }
                                                    // 攒批发送：满 100 条或超 33ms（约 30fps）
                                                    if buffer.len() >= 28 * 100 || last_send.elapsed().as_millis() > 33 {
                                                        if ws_stream.send(Message::Binary(buffer.clone().into())).await.is_err() {
                                                            break;
                                                        }
                                                        buffer.clear();
                                                        last_send = std::time::Instant::now();
                                                    }
                                                }
                                                Err(e) => {
                                                    // 【S1 修复】区分 Lagged 和 Closed 错误
                                                    // Lagged 仅表示接收端跟不上发送速度，跳过了一些消息，不应断开连接
                                                    match e {
                                                        tokio::sync::broadcast::error::RecvError::Lagged(n) => {
                                                            eprintln!("[WebSocket] Binary 通道落后，跳过了 {} 条消息", n);
                                                            // 继续接收，不断开
                                                        }
                                                        tokio::sync::broadcast::error::RecvError::Closed => break,
                                                    }
                                                }
                                            }
                                        }
                                        // 接收 Text 消息（节点元数据 JSON）
                                        result = text_rx.recv() => {
                                            match result {
                                                Ok(text) => {
                                                    if ws_stream.send(Message::Text(text.into())).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Err(e) => {
                                                    // 【S1 修复】Text 通道同样区分 Lagged 和 Closed
                                                    match e {
                                                        tokio::sync::broadcast::error::RecvError::Lagged(n) => {
                                                            eprintln!("[WebSocket] Text 通道落后，跳过了 {} 条消息", n);
                                                        }
                                                        tokio::sync::broadcast::error::RecvError::Closed => break,
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        });
                    }
                }
            }
                Err(e) => {
                    eprintln!("[WebSocket] 绑定端口 1421 失败: {}. 可能被其他进程占用。", e);
                }
            }
        });
    });

    // Thread 1: System and Connection Poller
    let p2p_clone = Arc::clone(&port_to_pid);
    let p2n_clone = Arc::clone(&pid_to_name);
    thread::spawn(move || {
        let mut sys = System::new_all();
        let af_flags = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
        let proto_flags = ProtocolFlags::TCP | ProtocolFlags::UDP;

        loop {
            // Update processes
            sys.refresh_processes(ProcessesToUpdate::All, true);
            let mut name_map = p2n_clone.write().unwrap();
            for (pid, process) in sys.processes() {
                name_map.insert(pid.as_u32(), process.name().to_string_lossy().into_owned());
            }
            drop(name_map);

            // Update sockets
            if let Ok(sockets) = get_sockets_info(af_flags, proto_flags) {
                let mut port_map = p2p_clone.write().unwrap();
                port_map.clear();
                for si in sockets {
                    let local_port = match si.protocol_socket_info {
                        ProtocolSocketInfo::Tcp(tcp) => tcp.local_port,
                        ProtocolSocketInfo::Udp(udp) => udp.local_port,
                    };
                    for pid in si.associated_pids {
                        port_map.insert(local_port, pid);
                    }
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });

    // Thread 2: Aggregator and Printer
    let stats_clone = Arc::clone(&traffic_stats);
    let name_clone = Arc::clone(&pid_to_name);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let mut stats = stats_clone.write().unwrap();
        let names = name_clone.read().unwrap();
        
        println!("--- Traffic Report ---");
        for (pid, traffic) in stats.iter_mut() {
            if traffic.bytes_up > 0 || traffic.bytes_down > 0 {
                let name = names.get(pid).map(|s| s.as_str()).unwrap_or("Unknown");
                let up_mb = traffic.bytes_up as f64 / 1024.0 / 1024.0;
                let down_mb = traffic.bytes_down as f64 / 1024.0 / 1024.0;
                
                println!(
                    "[PID: {} - {}] -> UP: {:.2} MB/s | DOWN: {:.2} MB/s",
                    pid, name, up_mb, down_mb
                );
                
                // Reset stats for next second
                traffic.bytes_up = 0;
                traffic.bytes_down = 0;
            }
        }
    });

    // [已移除] Deep Space Prober Thread (NextTrace Sidecar)
    // 原有的 NextTrace 子进程调用已被 GeoIP 离线引擎完全替代
    // trace.rs 文件保留但不再被主循环调用

    // Thread 3: WinDivert Packet Capture (Main Thread)
    let filter = "tcp or udp";
    let flags = WinDivertFlags::new().set_sniff().set_recv_only();
    let divert = match WinDivert::network(filter, 0, flags) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to open WinDivert: {}. Please run as Administrator.", e);
            return Ok(());
        }
    };

    println!("Intercepting packets via WinDivert...");
    let mut buffer = [0u8; 65535];
    
    // Flow track table: (src_ip, dst_ip, src_port, dst_port, proto) -> (*mut flow, protocol_name)
    let mut flows: HashMap<(u32, u32, u16, u16, u8), (*mut ndpi_ffi::ndpi_flow_struct, String)> = HashMap::new();
    let start_time = std::time::Instant::now();

    // ===== 可视化采样率控制器 =====
    // 每捕获 SAMPLE_RATE 个数据包，只将其中 1 个广播给前端进行可视化。
    // GeoIP 查表和 IP 缓存对所有包都执行（确保元数据完整），
    // 但二进制粒子广播会被采样，防止前端主线程被淹没。
    // 采样率 10 意味着：如果后端每秒捕获 10,000 个包，前端只需处理 1,000 个。
    let sample_rate: u64 = 10;
    let mut vis_packet_counter: u64 = 0;

    loop {
        match divert.recv(Some(&mut buffer)) {
            Ok(packet) => {
                let is_outbound = packet.address.outbound();
                let data_len = packet.data.len();

                // Parse packet to get ports
                if let Ok(sliced) = SlicedPacket::from_ip(&packet.data) {
                    let local_port = if let Some(ref transport) = sliced.transport {
                        match transport {
                            TransportSlice::Tcp(tcp) => if is_outbound { tcp.source_port() } else { tcp.destination_port() },
                            TransportSlice::Udp(udp) => if is_outbound { udp.source_port() } else { udp.destination_port() },
                            _ => continue,
                        }
                    } else {
                        continue;
                    };

                    let port_map = port_to_pid.read().unwrap();
                    let pid_opt = port_map.get(&local_port).copied();
                    drop(port_map);

                    if let Some(pid) = pid_opt {
                        let mut stats = traffic_stats.write().unwrap();
                        let entry = stats.entry(pid).or_default();
                        if is_outbound {
                            entry.bytes_up += data_len;
                        } else {
                            entry.bytes_down += data_len;
                        }
                    }

                    // Extract IP info for flow tracking
                    if let Some(net) = sliced.net {
                        let (src_ip, dst_ip, proto) = match net {
                            etherparse::NetSlice::Ipv4(ipv4) => (
                                u32::from_be_bytes(ipv4.header().source()),
                                u32::from_be_bytes(ipv4.header().destination()),
                                ipv4.header().protocol().0
                            ),
                            etherparse::NetSlice::Ipv6(ipv6) => {
                                // Simplified: fold IPv6 to u32 for quick map (just for test)
                                let s = ipv6.header().source();
                                let d = ipv6.header().destination();
                                let src32 = (s[0] as u32) << 24 | (s[1] as u32) << 16 | (s[2] as u32) << 8 | s[3] as u32;
                                let dst32 = (d[0] as u32) << 24 | (d[1] as u32) << 16 | (d[2] as u32) << 8 | d[3] as u32;
                                (src32, dst32, ipv6.header().next_header().0)
                            },
                            _ => continue,
                        };
                        
                        // 【M8 修复】用 if-let 替代 unwrap()，避免未来重构控制流时 panic
                        let (src_port, dst_port) = if let Some(ref transport) = sliced.transport {
                            match transport {
                                TransportSlice::Tcp(t) => (t.source_port(), t.destination_port()),
                                TransportSlice::Udp(u) => (u.source_port(), u.destination_port()),
                                _ => (0, 0),
                            }
                        } else {
                            continue;
                        };

                        // Bidirectional flow key
                        let key = if src_ip < dst_ip {
                            (src_ip, dst_ip, src_port, dst_port, proto)
                        } else {
                            (dst_ip, src_ip, dst_port, src_port, proto)
                        };

                        // Prevent memory leak from accumulating too many flows
                        if flows.len() > 10000 && !flows.contains_key(&key) {
                            // extremely basic LRU: just clear everything when we hit the cap to avoid OOM
                            for (_, (ptr, _)) in flows.drain() {
                                unsafe {
                                    ndpi_ffi::ndpi_free_flow(ptr); // nDPI will free internal data and the ptr itself
                                }
                            }
                        }

                        // [GeoIP] 不再需要触发 NextTrace 跟踪

                        let flow_entry = flows.entry(key).or_insert_with(|| {
                            let size = unsafe { ndpi_ffi::ndpi_detection_get_sizeof_ndpi_flow_struct() as usize };
                            let ptr = unsafe { ndpi_ffi::ndpi_flow_malloc(size) as *mut ndpi_ffi::ndpi_flow_struct };
                            // 【FATAL-6 修复】检查空指针，防止内存分配失败时对 null 写入导致段错误
                            if ptr.is_null() {
                                eprintln!("[nDPI] ndpi_flow_malloc 分配 {} 字节失败，返回空指针", size);
                                // 返回空指针标记，在后续使用前会被检查
                                return (ptr, String::new());
                            }
                            // ndpi_flow_malloc 通常已零初始化，但显式清零更安全
                            unsafe { std::ptr::write_bytes(ptr as *mut u8, 0, size); }
                            (ptr, String::new())
                        });

                        // 【FATAL-6 补充】如果 flow 指针为空（分配失败），跳过 DPI 处理
                        if flow_entry.0.is_null() {
                            continue;
                        }

                        let packet_time_ms = start_time.elapsed().as_millis() as u64;
                        let protocol = unsafe {
                            ndpi_ffi::ndpi_detection_process_packet(
                                ndpi_mod,
                                flow_entry.0,
                                packet.data.as_ptr(),
                                packet.data.len() as u16,
                                packet_time_ms,
                                std::ptr::null_mut()
                            )
                        };

                        // If protocol detected and not yet cached
                        if protocol.app_protocol != 0 && flow_entry.1.is_empty() {
                            let name_ptr = unsafe { ndpi_ffi::ndpi_get_proto_name(ndpi_mod, protocol.app_protocol) };
                            if !name_ptr.is_null() {
                                let c_str = unsafe { std::ffi::CStr::from_ptr(name_ptr) };
                                if let Ok(s) = c_str.to_str() {
                                    flow_entry.1 = s.to_string();
                                }
                            }
                        }

                        // === GeoIP 离线查表：先查缓存，未命中则调用 GeoIpEngine ===
                        let target_xyz = {
                            let map = ip_to_xyz.read().unwrap();
                            map.get(&dst_ip).copied()
                        };
                        let target_xyz = match target_xyz {
                            Some(xyz) => xyz,
                            None => {
                                // 缓存未命中：使用离线 GeoIP 引擎查表（微秒级完成）
                                let ip_bytes = dst_ip.to_be_bytes();
                                let geo_result = geo_engine.lookup(ip_bytes);
                                let xyz = lat_lon_to_xyz(geo_result.lat, geo_result.lon, 300.0);

                                // 写入缓存，避免重复查表
                                ip_to_xyz.write().unwrap().insert(dst_ip, xyz);

                                // 构造 JSON 元数据并通过 Text 通道广播给前端
                                let ip_str = format!(
                                    "{}.{}.{}.{}",
                                    ip_bytes[0], ip_bytes[1], ip_bytes[2], ip_bytes[3]
                                );
                                // 【M7 修复】使用 serde_json 安全序列化 JSON，
                                // 避免 country/isp 字段含双引号或反斜杠时生成无效 JSON
                                let json_msg = serde_json::json!({
                                    "type": "node",
                                    "ip": ip_str,
                                    "country": geo_result.country,
                                    "isp": geo_result.isp,
                                    "x": xyz.0,
                                    "y": xyz.1,
                                    "z": xyz.2
                                }).to_string();
                                let _ = ws_text_tx.send(json_msg);

                                xyz
                            }
                        };
                        
                        let (sx, sy, sz) = local_xyz;
                        let (tx, ty, tz) = target_xyz;
                        
                        // ===== 采样门控：只有被采中的包才广播给前端可视化 =====
                        vis_packet_counter += 1;
                        if vis_packet_counter % sample_rate == 0 {
                            let proto_f32 = protocol.app_protocol as f32;

                            let payload: [f32; 7] = if is_outbound {
                                [sx, sy, sz, tx, ty, tz, proto_f32]
                            } else {
                                [tx, ty, tz, sx, sy, sz, proto_f32]
                            };
                            
                            let _ = ws_tx.send(payload);
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("Error receiving packet: {}", e);
            }
        }
    }
}

