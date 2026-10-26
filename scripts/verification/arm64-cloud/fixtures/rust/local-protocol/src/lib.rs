pub fn label(value: u32) -> String { assert!(value > 0); format!("rea-fixture-{}", local_bytes::increment(value)) }
