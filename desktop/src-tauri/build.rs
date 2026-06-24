fn main() {
    // Forward the build ID stamped by the Makefile dmg target into the binary.
    // Falls back to "dev" so regular `cargo build` / `tauri dev` still compiles.
    let build_id = std::env::var("ARGUS_BUILD_ID").unwrap_or_else(|_| "dev".to_string());
    println!("cargo:rustc-env=ARGUS_BUILD_ID={build_id}");
    println!("cargo:rerun-if-env-changed=ARGUS_BUILD_ID");
    tauri_build::build()
}
