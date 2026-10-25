use std::fs::OpenOptions;
use std::time::Instant;
use tempfile::tempdir;

#[test]
fn test_ntfs_allocation_benchmark() {
    let dir = tempdir().expect("tempdir");
    let test_size: u64 = 500 * 1024 * 1024; // 500 MB

    // 1. Plain pre-allocation
    let plain_path = dir.path().join("plain.dat");
    let t0 = Instant::now();
    let plain_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&plain_path)
        .expect("open plain");
    plain_file.set_len(test_size).expect("set_len plain");
    let plain_duration = t0.elapsed();

    // 2. Sparse pre-allocation
    let sparse_path = dir.path().join("sparse.dat");
    let t1 = Instant::now();
    let sparse_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&sparse_path)
        .expect("open sparse");

    #[cfg(windows)]
    unsafe {
        use std::os::windows::io::AsRawHandle;
        const FSCTL_SET_SPARSE: u32 = 0x000900C4;
        extern "system" {
            fn DeviceIoControl(
                hDevice: isize,
                dwIoControlCode: u32,
                lpInBuffer: *const std::ffi::c_void,
                nInBufferSize: u32,
                lpOutBuffer: *mut std::ffi::c_void,
                nOutBufferSize: u32,
                lpBytesReturned: *mut u32,
                lpOverlapped: *mut std::ffi::c_void,
            ) -> i32;
        }

        let handle = sparse_file.as_raw_handle();
        let mut bytes_returned = 0u32;
        let _ = DeviceIoControl(
            handle as isize,
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        );
    }
    sparse_file.set_len(test_size).expect("set_len sparse");
    let sparse_duration = t1.elapsed();

    println!("\n=== NTFS File Allocation Benchmark (500 MB) ===");
    println!("Plain set_len:  {:?}", plain_duration);
    println!("Sparse set_len: {:?}", sparse_duration);
    println!("===============================================\n");

    assert!(plain_file.metadata().unwrap().len() == test_size);
    assert!(sparse_file.metadata().unwrap().len() == test_size);
}
