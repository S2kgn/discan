mod category;
mod scan;

use scan::{Progress, ScanResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

struct AppState {
    progress: Arc<Progress>,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
}

#[derive(Serialize)]
struct DriveInfo {
    path: String,
    label: String,
    total: u64,
    free: u64,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetDiskFreeSpaceExW(
        lp_directory_name: *const u16,
        lp_free_bytes_available_to_caller: *mut u64,
        lp_total_number_of_bytes: *mut u64,
        lp_total_number_of_free_bytes: *mut u64,
    ) -> i32;
}

#[cfg(windows)]
fn disk_space(path: &str) -> (u64, u64) {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    // SAFETY: 세 출력 포인터 모두 살아 있는 지역 변수를 가리키고, 경로는 널 종료된 UTF-16이다.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) };
    if ok == 0 {
        (0, 0)
    } else {
        (total, avail)
    }
}

#[cfg(not(windows))]
fn disk_space(_path: &str) -> (u64, u64) {
    (0, 0)
}

/// 마운트된 드라이브 목록. Windows에서는 A~Z를 훑는다 —
/// 26회 `metadata` 호출은 API를 끌어들일 값어치가 없을 만큼 싸다.
#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    let mut drives = Vec::new();

    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if std::fs::metadata(&path).is_ok() {
            let (total, free) = disk_space(&path);
            drives.push(DriveInfo {
                label: format!("{}:", letter as char),
                path,
                total,
                free,
            });
        }
    }

    #[cfg(not(windows))]
    drives.push(DriveInfo {
        path: "/".to_string(),
        label: "/".to_string(),
        total: 0,
        free: 0,
    });

    drives
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    state.progress.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn start_scan(app: tauri::AppHandle, path: String) -> Result<ScanResult, String> {
    // State 가드는 await 를 넘길 수 없다. 블록 안에서 필요한 것만 꺼내고 즉시 버린다.
    let progress = {
        let state = app.state::<AppState>();
        state.progress.clone()
    };

    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("디렉터리가 아닙니다: {}", path));
    }

    progress.reset();

    // 진행 상황 송신. 스캔 자체는 카운터만 올리고, 방출은 이 스레드가 전담한다.
    let done = Arc::new(AtomicBool::new(false));
    {
        let app = app.clone();
        let progress = progress.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(150));
                let _ = app.emit(
                    "scan-progress",
                    ProgressPayload {
                        files: progress.files.load(Ordering::Relaxed),
                        dirs: progress.dirs.load(Ordering::Relaxed),
                        bytes: progress.bytes.load(Ordering::Relaxed),
                        errors: progress.errors.load(Ordering::Relaxed),
                    },
                );
            }
        });
    }

    let scan_progress = progress.clone();
    let result = tauri::async_runtime::spawn_blocking(move || scan::scan(&root, &scan_progress))
        .await
        .map_err(|e| format!("스캔 작업이 중단되었습니다: {}", e));

    done.store(true, Ordering::Relaxed);
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            progress: Arc::new(Progress::new()),
        })
        .invoke_handler(tauri::generate_handler![list_drives, start_scan, cancel_scan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
