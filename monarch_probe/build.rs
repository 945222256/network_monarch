fn main() {
    // 告诉 Cargo 链接我们刚刚用 MSBuild 编译出来的 nDPI 静态库
    println!("cargo:rustc-link-search=native=G:\\Playground\\network_monarch\\ndpi\\windows\\bin\\x64_Debug");
    println!("cargo:rustc-link-lib=static=nDPI");

    // 告诉 Cargo 链接 pthreads 静态库 (nDPI 的依赖)
    println!("cargo:rustc-link-search=native=G:\\Playground\\network_monarch\\ndpi\\windows\\packages\\pthreads.2.9.1.4\\build\\native\\lib\\v110\\x64\\Debug\\static\\cdecl");
    println!("cargo:rustc-link-lib=static=libpthread-static");

    // 告诉 Cargo 链接 Windows 的 Socket 库 (nDPI 需要)
    println!("cargo:rustc-link-lib=Ws2_32");
}
