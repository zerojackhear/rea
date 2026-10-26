fn main() {
    println!("rea-rust-arm64-cloud os={} arch={} label={}", std::env::consts::OS, std::env::consts::ARCH, local_protocol::label(41));
}
