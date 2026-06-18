#![allow(non_camel_case_types)]
use std::os::raw::{c_char, c_int, c_void};

// 【M2 修复】FFI 不透明指针类型
// 使用包含零长度数组的 repr(C) struct 替代空 enum，
// 避免 uninhabited type 触发优化器的错误假设。
#[repr(C)]
pub struct ndpi_detection_module_struct { _opaque: [u8; 0] }
#[repr(C)]
pub struct ndpi_flow_struct { _opaque: [u8; 0] }

#[repr(C)]
pub struct ndpi_protocol {
    pub master_protocol: u16,
    pub app_protocol: u16,
    pub category: u16,
}


unsafe extern "C" {
    pub fn ndpi_init_detection_module(g_ctx: *mut c_void) -> *mut ndpi_detection_module_struct;
    pub fn ndpi_finalize_initialization(mod_: *mut ndpi_detection_module_struct) -> c_int;
    
    // 获取协议名称
    pub fn ndpi_get_proto_name(mod_: *mut ndpi_detection_module_struct, proto_id: u16) -> *const c_char;

    // 获取 ndpi_flow_struct 大小
    pub fn ndpi_detection_get_sizeof_ndpi_flow_struct() -> u32;

    // 分配 flow 和释放
    pub fn ndpi_flow_malloc(size: usize) -> *mut c_void;
    pub fn ndpi_free_flow(flow: *mut ndpi_flow_struct);

    // 核心包处理
    pub fn ndpi_detection_process_packet(
        ndpi_struct: *mut ndpi_detection_module_struct,
        flow: *mut ndpi_flow_struct,
        packet: *const u8,
        packetlen: u16,
        packet_time_ms: u64,
        input_info: *mut c_void, // opaque pointer for ndpi_flow_input_info
    ) -> ndpi_protocol;
}
