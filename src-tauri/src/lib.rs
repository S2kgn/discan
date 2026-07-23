// 이 프로젝트의 규율은 '모든 unsafe 에 논증을 남긴다'이고, 그 규율의 가치는 예외가
// 없을 때만 성립한다 — 하나라도 빠지면 다음 사람이 '여기는 안 붙여도 되는 자리'를
// 스스로 판단하기 시작한다. 사람의 기억 대신 린트가 지키게 한다(CI 는 -D warnings).
#![warn(clippy::undocumented_unsafe_blocks)]

mod category;
mod dirent;
mod scan;

use scan::{Progress, ScanResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 스캔 하나의 수명을 관리하는 상태.
///
/// "동시에 두 스캔이 돌지 않는다"는 불변식은 백엔드가 직접 강제한다.
/// 프런트엔드의 `scanning` 플래그는 신뢰 경계 바깥이고, 개발자 콘솔에서
/// invoke 한 번이면 우회된다.
struct ScanState {
    running: AtomicBool,
    /// 스캔 세대. 취소 요청이 지금 도는 스캔을 겨냥한 것인지 확인한다.
    generation: AtomicU64,
    /// 지금 도는 스캔의 진행 카운터. **스캔마다 새로 만들어 갈아 끼운다.**
    ///
    /// 예전처럼 상태에 `Progress` 하나만 두면, 커맨드 future 가 드롭된 스캔
    /// (웹뷰 리로드 등 — `spawn_blocking`에는 취소가 전파되지 않아 순회는 계속 돈다)이
    /// 다음 스캔과 같은 카운터를 공유한다. 옛 워커들이 새 스캔의 진행률에 계속
    /// 더하면 '동시에 두 스캔이 돌지 않는다'는 불변식이 바로 여기서 깨진다.
    /// 세대마다 객체가 다르면 그 공유 자체가 성립하지 않는다.
    current: Mutex<Option<Arc<Progress>>>,
}

struct AppState {
    inner: Arc<ScanState>,
}

/// 정상·오류·패닉·**future 드롭** 어느 경로로 빠져나가도 실행 플래그를 되돌리고,
/// 자기 세대의 스캔에 취소를 세우고, 진행 방출 스레드를 끝낸다.
///
/// 드롭된 future 의 순회는 `spawn_blocking` 안에서 계속 돈다. 취소를 세우지 않으면
/// 그 스캔은 아무도 멈출 수 없고(`request_cancel`은 `running=false`라 즉시 기각된다)
/// 디스크를 끝까지 읽는다. 스스로 빠져나가게 하는 것이 유일한 출구다.
///
/// `done` 도 여기서 소유한다. 예전에는 스캔 await 가 **정상 반환한 뒤에만** 세워져,
/// 웹뷰 리로드 등으로 커맨드 future 가 그 await 지점에서 드롭되면 `done` 이 영원히
/// false 로 남았다. 그러면 방출 스레드는 다음 스캔이 시작될 때까지(즉 사용자가 다시
/// 스캔하지 않으면 앱이 끝날 때까지) 150ms 마다 깨어나 이미 취소된 세대의 카운터를
/// 계속 emit 한다 — '끝난 세대의 이벤트를 보내지 않는다'는 이 파일의 세대 방어와
/// 정면으로 어긋나는 상태다. 탈출 조건을 한 곳으로 모아 세 경로를 한꺼번에 닫는다.
struct RunGuard {
    state: Arc<ScanState>,
    progress: Arc<Progress>,
    done: Arc<AtomicBool>,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        // 방출을 먼저 끊고, 취소를 세우고, 실행 플래그를 마지막에 푼다.
        // 이 Progress 는 이 스캔의 것이라 다음 스캔에는 영향이 없지만,
        // 순서를 지켜야 그 사실이 자명하다.
        self.done.store(true, Ordering::SeqCst);
        self.progress.cancel.store(true, Ordering::Relaxed);
        self.state.running.store(false, Ordering::SeqCst);
    }
}

/// 커맨드 오류.
///
/// 문구가 아니라 **코드**로 분기해야 프런트의 안내가 백엔드 문자열 변경에
/// 조용히 깨지지 않는다. 한국어 부분 문자열로 갈래를 나누면 '네트워크 드라이브
/// 거부'가 '접근 권한을 확인하십시오'로 안내되고, 국제화도 원천 봉쇄된다.
/// `message`는 프런트 사전에 아직 없는 코드가 왔을 때의 최후 폴백이다.
#[derive(Serialize, Clone, Debug)]
pub struct CommandError {
    /// `"emptyPath"` | `"uncRejected"` | `"deviceNamespace"` | `"notFound"`
    /// | `"notADirectory"` | `"linkUnresolved"` | `"remoteDrive"`
    /// | `"unsupportedPath"` | `"busy"` | `"joinError"`.
    pub code: &'static str,
    /// 경로 등 코드만으로는 알 수 없는 보조 정보. 화면 문구는 프런트가 만든다.
    pub detail: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &'static str, message: &str, detail: impl Into<String>) -> Self {
        CommandError {
            code,
            detail: detail.into(),
            message: message.to_string(),
        }
    }
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    #[serde(rename = "skippedLinks")]
    skipped_links: u64,
    #[serde(rename = "currentPath")]
    current_path: String,
    #[serde(rename = "scanId")]
    scan_id: u64,
}

#[derive(Serialize)]
struct DriveInfo {
    path: String,
    label: String,
    total: u64,
    /// 볼륨 전체 여유. 탐색기가 보여 주는 값과 같은 정의다.
    free: u64,
    /// 쿼터가 걸린 볼륨에서는 이 값이 `free`보다 작다.
    #[serde(rename = "availableToCaller")]
    available_to_caller: u64,
    /// `"fixed"` | `"removable"` | `"remote"` | `"cdrom"` | `"ram"` | `"unknown"`.
    #[serde(rename = "driveType")]
    drive_type: &'static str,
    /// 용량 조회 실패 시 GetLastError 값. 0이면 정상.
    #[serde(rename = "errorCode")]
    error_code: u32,
}

#[cfg(windows)]
mod win {
    //! Windows API는 windows-sys 바인딩으로만 부른다.
    //! 손으로 쓴 extern 선언은 컴파일러가 실제 export와 대조해 주지 못해,
    //! 인자를 하나 빠뜨려도 조용히 컴파일되고 런타임에 스택이 깨진다.

    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW,
        GetFileInformationByHandle, GetLogicalDrives, GetVolumeInformationW,
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        GetThreadErrorMode, SetErrorMode, SetThreadErrorMode, SEM_FAILCRITICALERRORS,
        SEM_NOOPENFILEERRORBOX,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub const DRIVE_REMOVABLE: u32 = 2;
    pub const DRIVE_FIXED: u32 = 3;
    pub const DRIVE_REMOTE: u32 = 4;
    pub const DRIVE_CDROM: u32 = 5;
    pub const DRIVE_RAMDISK: u32 = 6;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 빈 이동식 드라이브에서 "디스크를 넣으십시오" 시스템 대화상자가 뜨면
    /// 그 순간 앱이 멈춘 것처럼 보인다. 프로세스 전체에 한 번만 건다.
    ///
    /// 기존 모드를 읽어 **합친다**. 통째로 덮으면 WebView2·GPU 드라이버·셸 확장처럼
    /// 같은 프로세스에 얹히는 서드파티 컴포넌트가 이미 세워 둔 플래그
    /// (`SEM_NOGPFAULTERRORBOX` 등)가 조용히 풀린다.
    ///
    /// 다만 값을 읽는 유일한 방법이 `SetErrorMode(0)`이라 두 호출 사이에 프로세스
    /// 전역 모드가 0으로 떨어지는 창이 생긴다(MS 가 이 read-modify-write 를
    /// 비권장하고 `SetThreadErrorMode`를 권하는 이유가 정확히 이 경합이다).
    /// **이 호출은 `run()` 최상단, 즉 Tauri Builder 가 WebView2·GPU 워커 스레드를
    /// 만들기 전에만 유효하다** — 위치를 옮기면 그 창이 실제 위험이 되므로 회귀
    /// 방지 대상이다. 순회 스레드는 아래 스레드 단위 설정으로 따로 덮는다.
    pub fn suppress_error_dialogs() {
        // SAFETY: 인자 없는 프로세스 전역 플래그 설정이며 반환값은 이전 모드다.
        unsafe {
            let prev = SetErrorMode(0);
            SetErrorMode(prev | SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
        }
    }

    /// 지금 스레드에만 오류 대화상자 억제를 건다.
    ///
    /// `GetThreadErrorMode`는 값을 읽는 데 부작용이 없어 위와 같은 창이 없다.
    /// 실제로 대화상자를 유발하는 stat 은 전부 순회 워커에서 일어나므로,
    /// 그 스레드들이 시작할 때 여기를 부르면 프로세스 전역 설정에 기대지 않는다.
    pub fn suppress_error_dialogs_for_thread() {
        // SAFETY: 조회는 인자가 없고, 설정의 출력 포인터는 필요 없어 널을 넘긴다.
        // 두 호출 모두 이 스레드에만 작용한다.
        unsafe {
            let prev = GetThreadErrorMode();
            SetThreadErrorMode(
                prev | SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX,
                std::ptr::null_mut(),
            );
        }
    }

    /// 프로세스가 상승된(관리자) 토큰으로 도는지.
    ///
    /// 같은 볼륨도 권한에 따라 접근 거부 건수와 총량이 GB 단위로 달라진다.
    /// 실패하면 false 로 본다 — 알 수 없을 때 '관리자'라고 적는 쪽이 더 나쁘다.
    pub fn is_elevated() -> bool {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: 현재 프로세스 의사 핸들과 출력 핸들 포인터만 넘긴다.
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
        if opened == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut ret_len: u32 = 0;
        // SAFETY: 구조체 크기를 정확히 넘기고, 출력 포인터는 살아 있는 지역 변수다.
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret_len,
            )
        };
        // SAFETY: 위에서 연 핸들 하나만 닫는다.
        unsafe {
            CloseHandle(token);
        }
        ok != 0 && elevation.TokenIsElevated != 0
    }

    /// 디렉터리의 객체 신원 (볼륨 시리얼, 파일 인덱스).
    ///
    /// 경로 문자열은 검증한 뒤에도 다른 대상을 가리키도록 바뀔 수 있다(정션 교체).
    /// 핸들로 읽은 이 쌍은 그 창을 문자열이 아닌 **객체 동일성**으로 닫는 유일한
    /// 값이다. 재해석 지점을 따라가지 않도록 `OPEN_REPARSE_POINT`를 함께 준다 —
    /// 따라가면 검증 대상이 아니라 링크 대상의 신원을 읽게 되어 대조가 무의미해진다.
    /// 읽기 권한이 아니라 속성 조회 권한만 요구하므로 잠긴 디렉터리에서도 열린다.
    pub fn file_identity(path: &std::path::Path) -> Option<(u32, u64)> {
        let w: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: 널 종료된 UTF-16 경로와 상수 플래그만 넘긴다. 실패는 값으로 돌아온다.
        let handle = unsafe {
            CreateFileW(
                w.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: BY_HANDLE_FILE_INFORMATION 은 정수 필드로만 구성된 POD 이며,
        // all-zero 가 유효한 비트 패턴이다(널이 될 수 없는 필드·니치가 없다).
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: 방금 연 핸들과 살아 있는 출력 구조체를 넘긴다.
        let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
        // SAFETY: 위에서 연 핸들 하나만 닫는다.
        unsafe {
            CloseHandle(handle);
        }
        if ok == 0 {
            return None;
        }
        Some((
            info.dwVolumeSerialNumber,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        ))
    }

    /// 존재하는 드라이브 문자 비트마스크. 원격 I/O를 일으키지 않는다.
    pub fn logical_drives() -> u32 {
        // SAFETY: 인자 없는 순수 조회.
        unsafe { GetLogicalDrives() }
    }

    /// 드라이브 종류. 이 호출도 네트워크로 나가지 않는다.
    pub fn drive_type(root: &str) -> u32 {
        let w = wide(root);
        // SAFETY: 널 종료된 UTF-16 경로 하나만 넘긴다.
        unsafe { GetDriveTypeW(w.as_ptr()) }
    }

    /// (총량, 볼륨 여유, 호출자 사용 가능량, 오류 코드).
    pub fn disk_space(root: &str) -> (u64, u64, u64, u32) {
        let w = wide(root);
        let mut avail: u64 = 0;
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        // SAFETY: 세 출력 포인터 모두 살아 있는 지역 변수를 가리킨다.
        let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
        if ok == 0 {
            // SAFETY: 직전 호출 실패 코드를 읽는 것뿐이다.
            (0, 0, 0, unsafe { GetLastError() })
        } else {
            (total, free, avail, 0)
        }
    }

    /// 볼륨 클러스터 크기. 논리 크기와 디스크 점유의 차이를 설명할 근거다.
    pub fn cluster_bytes(root: &str) -> u64 {
        let w = wide(root);
        let (mut spc, mut bps, mut freec, mut totalc) = (0u32, 0u32, 0u32, 0u32);
        // SAFETY: 네 출력 포인터 모두 살아 있는 지역 변수를 가리킨다.
        let ok =
            unsafe { GetDiskFreeSpaceW(w.as_ptr(), &mut spc, &mut bps, &mut freec, &mut totalc) };
        if ok == 0 {
            0
        } else {
            spc as u64 * bps as u64
        }
    }

    /// (파일시스템 이름, 표시용 볼륨 시리얼, 원시 볼륨 시리얼).
    ///
    /// 원시 값까지 돌려주는 이유는 하드 링크 판정 키가 (볼륨 시리얼, 파일 ID) 쌍이기
    /// 때문이다. 표시용 `XXXX-XXXX` 를 다시 파싱하는 것보다 원본을 그대로 넘기는 편이
    /// 형식이 바뀌어도 깨지지 않는다.
    pub fn volume_info(root: &str) -> (String, String, u32) {
        let w = wide(root);
        let mut name = [0u16; 64];
        let mut fs = [0u16; 64];
        let mut serial: u32 = 0;
        let mut max_comp: u32 = 0;
        let mut flags: u32 = 0;
        // SAFETY: 두 버퍼 모두 길이를 정확히 넘기고, 출력 포인터는 지역 변수다.
        let ok = unsafe {
            GetVolumeInformationW(
                w.as_ptr(),
                name.as_mut_ptr(),
                name.len() as u32,
                &mut serial,
                &mut max_comp,
                &mut flags,
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        };
        if ok == 0 {
            return (String::new(), String::new(), 0);
        }
        let fs_name: String = String::from_utf16_lossy(&fs)
            .trim_end_matches('\0')
            .to_string();
        (
            fs_name,
            format!("{:04X}-{:04X}", serial >> 16, serial & 0xFFFF),
            serial,
        )
    }
}

#[cfg(windows)]
fn drive_type_name(t: u32) -> &'static str {
    match t {
        win::DRIVE_REMOVABLE => "removable",
        win::DRIVE_FIXED => "fixed",
        win::DRIVE_REMOTE => "remote",
        win::DRIVE_CDROM => "cdrom",
        win::DRIVE_RAMDISK => "ram",
        _ => "unknown",
    }
}

/// 마운트된 드라이브 목록.
///
/// `fs::metadata`를 A~Z로 26번 부르던 방식은 끊긴 네트워크 드라이브 하나만 있어도
/// SMB 타임아웃까지 수십 초 블로킹된다. `GetLogicalDrives`+`GetDriveTypeW`는
/// 원격 I/O를 유발하지 않으므로 그 위험이 원천적으로 사라진다.
#[cfg(windows)]
fn enumerate_drives() -> Vec<DriveInfo> {
    let mask = win::logical_drives();
    let mut drives = Vec::new();

    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let path = format!("{}:\\", letter);
        let t = win::drive_type(&path);
        let kind = drive_type_name(t);

        // 원격 드라이브는 목록에는 넣되 용량을 묻지 않는다 —
        // 그 조회 한 번이 곧 원격 호스트로의 인증 시도다.
        let (total, free, avail, err) = if t == win::DRIVE_REMOTE {
            (0, 0, 0, 0)
        } else {
            win::disk_space(&path)
        };

        drives.push(DriveInfo {
            label: format!("{}:", letter),
            path,
            total,
            free,
            available_to_caller: avail,
            drive_type: kind,
            error_code: err,
        });
    }

    drives
}

#[cfg(not(windows))]
fn enumerate_drives() -> Vec<DriveInfo> {
    vec![DriveInfo {
        path: "/".to_string(),
        label: "/".to_string(),
        total: 0,
        free: 0,
        available_to_caller: 0,
        drive_type: "fixed",
        error_code: 0,
    }]
}

/// 비동기 커맨드로 둔다. 동기 커맨드는 메인 스레드에서 돌아 창이 그려지지 않는다.
///
/// 실패를 빈 목록으로 뭉개지 않는다. 열거 스레드가 패닉하거나 런타임이 작업을
/// 취소했을 때 `unwrap_or_default()`로 빈 Vec 을 돌려주면 프런트는 그것을 정상
/// 결과로 받아 '드라이브를 찾지 못했습니다'를 띄우고, `GetLogicalDrives` 계층의
/// 문제를 사용자도 개발자도 알 수 없게 된다.
#[tauri::command]
async fn list_drives() -> Result<Vec<DriveInfo>, CommandError> {
    tauri::async_runtime::spawn_blocking(enumerate_drives)
        .await
        .map_err(|e| {
            CommandError::new(
                "joinError",
                "드라이브 목록을 읽는 작업이 예기치 않게 끝났습니다.",
                e.to_string(),
            )
        })
}

/// 새 스캔의 세대를 연다. 새 `Progress`를 만들어 설치하고 세대 번호를 올린다.
///
/// **설치가 세대 증가보다 먼저**라는 순서를 이 함수 안에 가둔다. 뒤집히면 새 세대를
/// 지목해 들어온 취소가 옛 카운터에 걸려 사라지고 '중단 중…'이 영구히 풀리지 않는다.
/// 초기화 대신 새 객체를 쓰므로, 지워야 할 잔여 상태 자체가 없다 — 리셋 순서를
/// 지키는 것보다 지킬 것이 없는 편이 낫다.
fn begin_generation(st: &ScanState) -> (u64, Arc<Progress>) {
    let progress = Arc::new(Progress::new());
    {
        // 뮤텍스가 오염돼도 설치는 반드시 성공해야 한다. 실패하면 취소가 대상을
        // 잃어 중단 버튼이 영구히 먹통이 된다.
        let mut cur = st.current.lock().unwrap_or_else(|e| e.into_inner());
        *cur = Some(progress.clone());
    }
    let id = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    (id, progress)
}

/// 취소 요청을 지금 도는 스캔에 적용할지 판정한다. 커맨드에서 떼어 둔 이유는
/// `AppHandle` 없이도 세대 가드를 테스트로 잠그기 위해서다.
fn request_cancel(st: &ScanState, scan_id: Option<u64>) -> bool {
    if !st.running.load(Ordering::SeqCst) {
        // 스캔 중이 아닐 때 플래그를 세우면 다음 스캔이 시작하자마자 죽는다.
        return false;
    }
    if let Some(id) = scan_id {
        // 이전 스캔을 겨냥한 취소가 방금 시작한 스캔을 죽이는 창을 닫는다.
        if id != st.generation.load(Ordering::SeqCst) {
            return false;
        }
    }
    let cur = st.current.lock().unwrap_or_else(|e| e.into_inner());
    match cur.as_ref() {
        Some(p) => {
            p.cancel.store(true, Ordering::Relaxed);
            true
        }
        // 세대가 열리기 전이라면 지목할 대상이 없다. 참을 돌려주면 화면만
        // '중단 중…'으로 잠기고 실제로는 아무것도 멈추지 않는다.
        None => false,
    }
}

/// 스캔 중단. `scan_id`를 주면 그 세대의 스캔만 중단한다.
///
/// 반환값을 버리지 않는다. 취소가 기각되었는데도 프런트가 '중단 중…'으로 버튼을
/// 잠그면 스캔이 끝날 때까지 사용자는 아무것도 할 수 없다 — 이미 존재하는 방어
/// 로직을 화면에 보이게 하는 데 필요한 것은 이 한 줄뿐이다.
#[tauri::command]
fn cancel_scan(app: tauri::AppHandle, scan_id: Option<u64>) -> bool {
    let state = app.state::<AppState>();
    request_cancel(&state.inner, scan_id)
}

/// `\\?\` 접두사를 표시용 경로에서 걷어낸다. 화면에 그대로 나가면 읽기 어렵다.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        // UNC 형식(`\\?\UNC\server\share`)은 접두사를 떼면 원격 경로가 로컬처럼
        // 보인다. 원형을 유지해 호출자의 `is_remote_shaped` 검사가 걸리게 둔다.
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

/// 원격 공유를 가리키는 형태인지. 구분자만 정규화해 문자열로 판정하므로
/// **어떤 I/O도 일으키지 않는다** — 판정은 경로를 열기 전에 끝나야 한다.
///
/// `\\?\C:\...` 같은 로컬 verbatim 경로는 통과시킨다. `canonicalize` 결과가
/// 늘 그 형태라 여기서 막으면 정상 경로가 전부 거부된다.
fn is_remote_shaped(s: &str) -> bool {
    let norm = s.replace('/', "\\");
    if let Some(rest) = norm
        .strip_prefix(r"\\?\")
        .or_else(|| norm.strip_prefix(r"\\.\"))
    {
        return rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("UNC\\");
    }
    norm.starts_with(r"\\")
}

/// 장치 네임스페이스를 가리키는 형태인지. `is_remote_shaped`와 같이 순수 문자열
/// 판정이라 **어떤 I/O도 일으키지 않는다**.
///
/// 사용자 입력에만 걸면 부족하다. 정션이 `\\?\GLOBALROOT\Device\HarddiskVolume1`을
/// 가리키는 구성에서는 링크 해석 단계의 어느 판정에도 걸리지 않고, 마지막 볼륨
/// 검사가 `unsupportedPath`로 거부해 '드라이브 문자로 지정하십시오'라는 엉뚱한
/// 안내가 나간다. 매 홉마다 이 판정을 함께 돌려 갈래를 제자리에서 확정한다.
///
/// GLOBALROOT 는 **접두사 바로 다음 구성요소**가 정확히 그 이름일 때만 본다.
/// 예전의 부분 문자열 검사(`contains("GLOBALROOT")`)는 `D:\Backup\GLOBALROOT_2024`
/// 같은 정상 폴더를 거부해, 사용자가 존재하지 않는 문제를 찾게 만들었다.
fn is_device_shaped(s: &str) -> bool {
    let norm = s.replace('/', "\\");
    if norm.starts_with(r"\\.\") {
        return true;
    }
    match norm.strip_prefix(r"\\?\") {
        Some(rest) => rest
            .split('\\')
            .next()
            .is_some_and(|first| first.eq_ignore_ascii_case("GLOBALROOT")),
        None => false,
    }
}

/// 링크 체인을 따라갈 최대 홉 수. 이보다 길면 순환이거나 악의적 구성이다.
const MAX_LINK_HOPS: usize = 16;

/// 경로의 **모든** 구성요소를 위에서부터 훑으며 링크를 홉 단위로 해석한다.
///
/// `symlink_metadata`는 마지막 구성요소만 따라가지 않으므로, `C:\link\sub`처럼
/// 중간이 링크면 그 stat 한 번으로 이미 SMB 세션이 열린다. 접두사를 하나씩
/// 늘려 가며 보면 각 구성요소를 '열기 전에' 링크 여부를 알 수 있다.
///
/// 직접 대상 하나만 보고 끝내면 **체인 우회가 열린다**: `C:\a` → `C:\b` →
/// `\\attacker\share` 구성에서 `C:\a`의 직접 대상은 로컬 형태라 통과하고,
/// 그 뒤의 `canonicalize`가 체인을 끝까지 따라가면서 바로 그 순간 현재 사용자
/// 컨텍스트의 NTLM 협상이 공격자 호스트로 나간다 — 사용자에게는 오류 한 줄만
/// 보이지만 자격증명 재료는 이미 넘어간 뒤다. 재해석 지점을 만드는 데는 관리자
/// 권한도 필요 없어서(디렉터리 쓰기 권한이면 족하다) 다운로드 폴더 하위를
/// 스캔 대상으로 고르는 것만으로 성립한다.
///
/// 그래서 `canonicalize`를 부르지 않는다. **매 홉마다** 형태를 먼저 판정하고,
/// 로컬이라고 확인된 뒤에만 다음 홉을 stat 한다 — 원격 대상은 한 번도 열리지 않는다.
fn resolve_links(path: &Path) -> Result<PathBuf, CommandError> {
    let unresolved = |p: &Path| {
        CommandError::new(
            "linkUnresolved",
            "링크 대상을 확인할 수 없습니다.",
            p.to_string_lossy(),
        )
    };

    let mut cur = PathBuf::new();
    for comp in path.components() {
        cur.push(comp);
        let mut hops = 0usize;
        loop {
            // 판정이 stat 보다 **먼저** 와야 한다. 순서가 바뀌면 판정은 성공해도
            // 그 전에 이미 원격 호스트로 나간 뒤다.
            let cur_str = cur.to_string_lossy();
            if is_remote_shaped(&cur_str) {
                return Err(CommandError::new(
                    "uncRejected",
                    "네트워크(UNC) 경로는 분석할 수 없습니다.",
                    cur_str,
                ));
            }
            // 장치 네임스페이스도 홉마다 본다. 여기서 놓치면 마지막 볼륨 검사가
            // `unsupportedPath`로 거부해 원인과 무관한 안내가 나간다.
            if is_device_shaped(&cur_str) {
                return Err(CommandError::new(
                    "deviceNamespace",
                    "장치 네임스페이스 경로는 분석할 수 없습니다.",
                    cur_str,
                ));
            }
            // 드라이브 문자로 매핑된 SMB 공유(`Z:\share\dir`)는 문자열만으로는 로컬과
            // 구분되지 않는다. 위 두 형태 판정만 돌리면 그 갈래에서만 '판정이 stat 보다
            // 먼저 온다'는 이 함수의 선언이 거짓이 되어, 아래 `symlink_metadata` 가
            // 네트워크 리디렉터로 그대로 나간 **뒤에야** 호출자의 마지막 볼륨 검사가
            // 거부한다. `GetDriveTypeW` 는 로컬 리디렉터 테이블만 보므로 I/O 가 없고,
            // `resolve_root` 의 선판정과 정확히 같은 코드다.
            #[cfg(windows)]
            if let Some(vol) = volume_root(&cur) {
                if win::drive_type(&vol) == win::DRIVE_REMOTE {
                    return Err(CommandError::new(
                        "remoteDrive",
                        "네트워크 드라이브는 분석할 수 없습니다.",
                        vol,
                    ));
                }
            }
            let Ok(meta) = std::fs::symlink_metadata(&cur) else {
                // 없는 구성요소는 호출자의 존재 확인이 처리한다.
                break;
            };
            // Windows 에서는 정션도 여기 걸린다(std 가 마운트 지점을 링크로 본다).
            if !meta.file_type().is_symlink() {
                break;
            }
            if hops >= MAX_LINK_HOPS {
                return Err(unresolved(&cur));
            }
            hops += 1;
            let target = std::fs::read_link(&cur).map_err(|_| unresolved(&cur))?;
            let next = if target.is_absolute() {
                target
            } else {
                cur.parent().unwrap_or(Path::new("")).join(target)
            };
            // 정션 대상은 대개 `\\?\` 형태로 돌아온다. 로컬 verbatim 만 벗겨
            // 이후 볼륨 검사가 드라이브 문자를 볼 수 있게 하되, UNC 형식은
            // 원형을 유지해 다음 반복의 형태 판정에 걸리게 둔다.
            cur = strip_verbatim(next);
        }
    }
    Ok(cur)
}

/// 사용자가 준 경로를 검증하고 실제 스캔 대상을 확정한다.
///
/// 검증은 반드시 백엔드에 둔다 — 프런트엔드 검사는 IPC 직접 호출로 우회된다.
fn resolve_root(path: &str) -> Result<PathBuf, CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new("emptyPath", "경로가 비어 있습니다.", ""));
    }

    // UNC 경로는 존재 확인 한 번만으로 SMB 세션이 열리고, 현재 사용자 컨텍스트의
    // NTLM 협상이 원격 호스트로 나간다. 사용자에게는 오류 한 줄만 보이지만
    // 그 사이에 자격증명 재료가 이미 넘어간 뒤다.
    //
    // 판정은 `is_remote_shaped`에 맡긴다. 예전처럼 `\\` 접두사만 보면
    // `\\?\C:\Users`(로컬 verbatim)와 `\\.\PhysicalDrive0`(장치 네임스페이스)까지
    // '네트워크 경로'로 안내되어, 사용자는 존재하지도 않는 네트워크 설정을 뒤진다.
    if is_remote_shaped(trimmed) {
        return Err(CommandError::new(
            "uncRejected",
            "네트워크(UNC) 경로는 분석할 수 없습니다.",
            trimmed,
        ));
    }
    // 장치 네임스페이스. `\\.\`는 전부 여기고, `\\?\GLOBALROOT\...`도 같은 갈래다
    // (UNC 형식은 위에서 이미 걸러졌다).
    if is_device_shaped(trimmed) {
        return Err(CommandError::new(
            "deviceNamespace",
            "장치 네임스페이스 경로는 분석할 수 없습니다.",
            trimmed,
        ));
    }

    // 로컬 verbatim(`\\?\C:\...`)은 정상 경로다. 접두사만 벗겨 두면 이후 볼륨
    // 검사가 드라이브 문자를 볼 수 있다(UNC 형식은 위에서 이미 걸러졌다).
    let raw = strip_verbatim(PathBuf::from(trimmed));

    // 드라이브 문자로 매핑된 SMB 공유(`Z:\projects`)는 문자열만으로는 원격임을 알 수
    // 없다. 그래서 아래 `resolve_links`의 첫 stat 이 이미 네트워크 리디렉터로 나간
    // **뒤에야** 마지막 볼륨 검사에 걸렸다 — '판정이 stat 보다 먼저 와야 한다'는
    // 불변식이 이 경로에서만 깨져 있었다. `GetDriveTypeW`는 로컬 리디렉터 테이블만
    // 보므로 I/O 없이 지금 부를 수 있고(enumerate_drives 가 쓰는 이유도 같다),
    // 끊긴 매핑 드라이브의 SMB 타임아웃도 여기서 함께 사라진다.
    #[cfg(windows)]
    if let Some(vol) = volume_root(&raw) {
        if win::drive_type(&vol) == win::DRIVE_REMOTE {
            return Err(CommandError::new(
                "remoteDrive",
                "네트워크 드라이브는 분석할 수 없습니다.",
                vol,
            ));
        }
    }

    // 문자열 접두사 검사만으로는 링크를 경유한 우회를 막지 못한다. 아래 stat 이
    // 원격을 건드리기 전에, 링크 체인을 홉 단위로 풀며 매 홉을 판정한다.
    // 결과는 재해석 지점이 모두 풀린 경로라, 화면에 표시되는 경로와 실제로 읽는
    // 대상이 일치한다.
    let root = resolve_links(&raw)?;

    // 해석 결과를 다시 검사한다. 위 검사가 무언가를 놓쳤더라도
    // 실제로 순회를 시작하기 전에 한 번 더 걸린다.
    if is_remote_shaped(&root.to_string_lossy()) {
        return Err(CommandError::new(
            "uncRejected",
            "네트워크(UNC) 경로는 분석할 수 없습니다.",
            root.to_string_lossy(),
        ));
    }

    // 링크가 모두 풀린 뒤이므로 `symlink_metadata`가 곧 대상의 메타데이터다.
    let meta = std::fs::symlink_metadata(&root)
        .map_err(|_| CommandError::new("notFound", "경로를 찾을 수 없습니다.", trimmed))?;
    if !meta.is_dir() {
        return Err(CommandError::new(
            "notADirectory",
            "디렉터리가 아닙니다.",
            trimmed,
        ));
    }

    #[cfg(windows)]
    {
        // 볼륨을 판정하지 못하면 **거부**한다. 예전처럼 통과시키면
        // `\\?\UNC\...`나 볼륨 GUID 경로에서 드라이브 종류 검사가 통째로
        // 건너뛰어져, 원격 공유가 아무 검사도 받지 않고 스캔된다.
        let Some(root_str) = volume_root(&root) else {
            return Err(CommandError::new(
                "unsupportedPath",
                "드라이브 문자로 지정된 로컬 경로만 분석할 수 있습니다.",
                root.to_string_lossy(),
            ));
        };
        // 위에서 이미 한 번 판정했지만 여기서 또 본다 — 링크 해석 결과가 다른
        // 드라이브 문자로 옮겨 갔을 수 있고, 그쪽이 매핑 드라이브일 수 있다.
        if win::drive_type(&root_str) == win::DRIVE_REMOTE {
            return Err(CommandError::new(
                "remoteDrive",
                "네트워크 드라이브는 분석할 수 없습니다.",
                root_str,
            ));
        }
    }

    Ok(root)
}

/// `C:\Users\...` → `C:\`. 드라이브 문자 형태가 아니면 None.
#[cfg(windows)]
fn volume_root(path: &Path) -> Option<String> {
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        Some(format!("{}:\\", bytes[0] as char))
    } else {
        None
    }
}

/// 스캔 **전에** 확정해야 하는 실행 조건을 모은다.
///
/// 클러스터 크기는 할당량 폴백 계산에, 파일시스템 이름은 하드 링크 중복 제거
/// 가부에 순회 **도중** 쓰인다 — 결과에 나중에 붙일 수 있는 값이 아니다.
/// 권한(상승 여부)·볼륨 시리얼도 스캔 시점의 값이어야 증거로서 의미가 있다.
fn scan_options(root: &Path, scan_id: u64) -> scan::ScanOptions {
    let _ = root;
    #[cfg(windows)]
    {
        let vol = volume_root(root);
        let (file_system, volume_serial, volume_serial_num) = vol
            .as_deref()
            .map(win::volume_info)
            .unwrap_or_else(|| (String::new(), String::new(), 0));
        scan::ScanOptions {
            cluster_bytes: vol.as_deref().map(win::cluster_bytes).unwrap_or(0),
            elevated: win::is_elevated(),
            // 검증 직후의 신원을 여기서 확정한다. 순회 진입에서 다시 읽어 대조하므로
            // 그 사이에 루트가 바꿔치기되면 문자열이 같아도 걸린다.
            root_identity: win::file_identity(root),
            file_system,
            volume_serial,
            volume_serial_num,
            scan_id,
            hardlink_min_bytes: scan::DEFAULT_HARDLINK_MIN_BYTES,
        }
    }
    #[cfg(not(windows))]
    scan::ScanOptions {
        scan_id,
        ..Default::default()
    }
}

#[tauri::command]
async fn start_scan(app: tauri::AppHandle, path: String) -> Result<ScanResult, CommandError> {
    // State 가드는 await 를 넘길 수 없다. 블록 안에서 필요한 것만 꺼내고 즉시 버린다.
    let st = {
        let state = app.state::<AppState>();
        state.inner.clone()
    };

    if st
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(CommandError::new("busy", "이미 스캔이 진행 중입니다.", ""));
    }
    // 세대를 **`resolve_root`보다 먼저** 연다.
    //
    // CAS 성공 순간부터 `running`은 참이라 취소 요청이 통과하는데, 세대가 뒤에
    // 열리면 그 사이(절전 디스크를 stat 하면 수백 ms까지 벌어진다)에 들어온 취소는
    // 지목할 대상을 찾지 못한다. 여기서 열어 두면 그 취소가 곧바로 이 스캔에 걸린다.
    let (scan_id, progress) = begin_generation(&st);
    // 이 시점 이후의 모든 조기 return 이 플래그를 되돌리고, 이 스캔을 취소하고,
    // 진행 방출 스레드를 끝낸다(future 드롭 경로 포함).
    let done = Arc::new(AtomicBool::new(false));
    let _guard = RunGuard {
        state: st.clone(),
        progress: progress.clone(),
        done: done.clone(),
    };

    // 경로 검증과 볼륨 조회도 blocking 풀에서 돌린다.
    //
    // `resolve_root`는 링크 체인을 홉마다 stat 하고 `scan_options`는 볼륨을 조회한다.
    // 절전 중인 디스크나 응답이 느린 볼륨에서는 그 호출들이 수 초씩 잡히는데, async
    // 본문에서 부르면 그동안 Tauri 런타임 워커가 통째로 묶여 `cancel_scan` 조차
    // 도달하지 못한다 — `list_drives`가 `fs::metadata` 26회 방식을 버린 이유와
    // 정확히 같은 실패 양상이다.
    let (root, options) = tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&path)?;
        // 클러스터 크기·권한·루트 신원·볼륨 메타데이터는 순회가 시작되기 전에 확정한다.
        let options = scan_options(&root, scan_id);
        Ok::<_, CommandError>((root, options))
    })
    .await
    .map_err(|e| {
        CommandError::new(
            "joinError",
            "경로를 확인하는 작업이 예기치 않게 끝났습니다.",
            e.to_string(),
        )
    })??;

    // 진행 상황 송신. 스캔 자체는 카운터만 올리고, 방출은 이 스레드가 전담한다.
    {
        let app = app.clone();
        let st = st.clone();
        let done = done.clone();
        let progress = progress.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(150));
                // sleep 에서 깬 뒤 **방출 전에** 다시 확인한다.
                //
                // `while !done { sleep; emit }` 구조는 done 을 본 뒤 150ms 자고
                // 무조건 한 번 더 방출한다. 그 잔여 이벤트는 이미 끝난 세대의
                // 것인데, 완료 직후 150ms 안에 '다시 스캔'을 누르면 새 리스너가
                // 그것을 먼저 받아 세대를 잘못 고정한다 — 이후 새 스캔의 진행은
                // 전부 폐기되고 취소도 옛 세대를 지목해 기각된다. 세대 방어를
                // 도입한 목적과 정확히 반대되는 결과다.
                // `done` 은 RunGuard 가 소유한다 — 정상 종료·오류·future 드롭 세
                // 경로가 모두 여기로 모인다.
                if done.load(Ordering::SeqCst) {
                    break;
                }
                // 다음 스캔이 이미 시작했다면 이 스레드는 방출할 자격이 없다.
                if st.generation.load(Ordering::SeqCst) != scan_id {
                    break;
                }
                let p = &progress;
                let _ = app.emit(
                    "scan-progress",
                    ProgressPayload {
                        files: p.files.load(Ordering::Relaxed),
                        dirs: p.dirs.load(Ordering::Relaxed),
                        bytes: p.bytes.load(Ordering::Relaxed),
                        errors: p.errors(),
                        skipped_links: p.skipped_links.load(Ordering::Relaxed),
                        current_path: p.current_path(),
                        scan_id,
                    },
                );
            }
        });
    }

    let scan_progress = progress.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || scan::scan(&root, &scan_progress, options))
            .await
            .map_err(|e| {
                CommandError::new(
                    "joinError",
                    "스캔 작업이 예기치 않게 끝났습니다.",
                    e.to_string(),
                )
            });

    // 가드가 어차피 세우지만, 여기서 먼저 끊어야 결과를 돌려주는 동안 이미 끝난
    // 세대의 이벤트가 한 틱 더 나가지 않는다.
    done.store(true, Ordering::SeqCst);

    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    win::suppress_error_dialogs();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 업데이터. Authenticode 인증서는 아직 없지만, minisign 공개키를 여기에
        // 심어 두면 **업데이트 산출물의 무결성**은 지금 닫을 수 있다 — 배포 채널이
        // 침해돼도 개인키 없이 만든 패키지는 클라이언트가 거부한다.
        // 공개키는 tauri.conf.json 의 plugins.updater.pubkey 에 있고, 개인키는
        // 저장소 바깥에서 환경변수로만 주입한다(src-tauri/RELEASE.md 참조).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            inner: Arc::new(ScanState {
                running: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                // 첫 스캔이 자기 것을 만들어 끼운다.
                current: Mutex::new(None),
            }),
        })
        .invoke_handler(tauri::generate_handler![
            list_drives,
            start_scan,
            cancel_scan
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unc_and_device_paths() {
        // stat 한 번이 곧 자격증명 전송이므로, 존재 확인보다 먼저 막아야 한다.
        assert_eq!(
            resolve_root(r"\\attacker.example.com\share")
                .unwrap_err()
                .code,
            "uncRejected"
        );
        assert_eq!(
            resolve_root("//attacker.example.com/share")
                .unwrap_err()
                .code,
            "uncRejected"
        );
        assert_eq!(
            resolve_root(r"\\?\GLOBALROOT\Device\HarddiskVolume1")
                .unwrap_err()
                .code,
            "deviceNamespace"
        );
        // 장치 경로를 '네트워크 문제'로 안내하면 사용자는 존재하지도 않는
        // 네트워크 설정을 확인하러 간다.
        assert_eq!(
            resolve_root(r"\\.\PhysicalDrive0").unwrap_err().code,
            "deviceNamespace"
        );
        assert_eq!(
            resolve_root(r"\\.\UNC\server\share").unwrap_err().code,
            "uncRejected"
        );
        assert_eq!(resolve_root("   ").unwrap_err().code, "emptyPath");
    }

    /// 장치 네임스페이스 판정도 링크 대상과 사용자 입력이 함께 통과하는 관문이라
    /// 형태 판정만 따로 잠근다. 부분 문자열 검사이던 시절에는 이름에 GLOBALROOT 가
    /// 들어간 정상 폴더가 거부되어, 사용자가 존재하지 않는 문제를 찾게 됐다.
    #[test]
    fn device_shape_detection_matches_components_not_substrings() {
        assert!(is_device_shaped(r"\\.\PhysicalDrive0"));
        assert!(is_device_shaped("//./PhysicalDrive0"));
        assert!(is_device_shaped(r"\\?\GLOBALROOT\Device\HarddiskVolume1"));
        assert!(is_device_shaped(r"\\?\globalroot\Device\HarddiskVolume1"));
        // 정상 경로는 이름이 비슷해도 걸리지 않는다.
        assert!(!is_device_shaped(r"D:\Backup\GLOBALROOT_2024"));
        assert!(!is_device_shaped(r"D:\GLOBALROOT backup\2024"));
        assert!(!is_device_shaped(r"\\?\C:\Users"));
        assert!(!is_device_shaped(r"C:\Users"));
        assert!(!is_device_shaped(r"\\server\share"));
    }

    /// 이름에 GLOBALROOT 가 들어간 폴더는 '장치 네임스페이스'가 아니다.
    /// 갈래를 잘못 잡으면 안내가 통째로 엉뚱해진다.
    #[test]
    fn a_folder_named_like_globalroot_is_not_a_device_path() {
        let root =
            std::env::temp_dir().join(format!("discan_GLOBALROOT_2024_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        let resolved = resolve_root(&root.to_string_lossy());
        assert!(
            resolved.is_ok(),
            "정상 폴더가 거부되었다: {:?}",
            resolved.err().map(|e| e.code)
        );
        let _ = std::fs::remove_dir(&root);
    }

    /// 로컬 verbatim 은 정상 경로다. `\\` 접두사만 보고 막던 시절에는
    /// `canonicalize` 결과 형태가 통째로 '네트워크 경로'로 거부됐다.
    #[cfg(windows)]
    #[test]
    fn accepts_a_local_verbatim_path() {
        let temp = std::env::temp_dir();
        let verbatim = format!(r"\\?\{}", temp.to_string_lossy().trim_end_matches('\\'));
        let resolved = resolve_root(&verbatim).expect("로컬 verbatim 은 통과해야 한다");
        assert!(resolved.is_dir());
        // 접두사가 남으면 볼륨 검사가 드라이브 문자를 보지 못한다.
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
    }

    /// 문자열 접두사 검사만으로는 잡히지 않는 형태들. 링크 대상과 `canonicalize`
    /// 결과가 모두 이 판정을 거치므로, 여기가 무너지면 우회가 그대로 열린다.
    #[test]
    fn remote_shape_detection_covers_verbatim_unc() {
        assert!(is_remote_shaped(r"\\server\share"));
        assert!(is_remote_shaped("//server/share"));
        assert!(is_remote_shaped(r"\\?\UNC\server\share"));
        assert!(is_remote_shaped(r"\\?\unc\server\share"));
        assert!(is_remote_shaped(r"\\.\UNC\server\share"));
        // 로컬 verbatim 은 통과해야 한다 — canonicalize 결과가 늘 이 형태다.
        assert!(!is_remote_shaped(r"\\?\C:\Users"));
        assert!(!is_remote_shaped(r"C:\Users"));
        assert!(!is_remote_shaped("/home/user"));
    }

    /// 링크 대상이 원격이면 그 대상을 **열기 전에** 거부되어야 한다.
    /// 대상을 여는 호출(과거의 `canonicalize`)은 그 자체가 SMB 인증이다.
    #[cfg(windows)]
    #[test]
    fn rejects_a_symlink_that_points_at_a_remote_share() {
        let link = std::env::temp_dir().join(format!("discan_unc_link_{}", std::process::id()));
        let _ = std::fs::remove_dir(&link);
        // 존재하지 않는 호스트를 가리켜도 링크는 만들어진다(대상을 검증하지 않는다).
        // 개발자 모드·관리자 권한이 없으면 만들 수 없으므로 그때는 건너뛴다 —
        // 다만 건너뛴다는 사실을 로그에 남긴다. 조용한 통과는 검증이 아니다.
        if std::os::windows::fs::symlink_dir(r"\\127.0.0.1\discan$", &link).is_err() {
            eprintln!(
                "[skip] rejects_a_symlink_that_points_at_a_remote_share: \
                 심볼릭 링크를 만들 수 없다(개발자 모드 필요)"
            );
            return;
        }

        let err = resolve_root(&link.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, "uncRejected");

        let _ = std::fs::remove_dir(&link);
    }

    /// 두 홉짜리 체인. 첫 홉의 **직접** 대상은 로컬 형태라, 홉마다 판정하지 않는
    /// 구현은 여기서 통과시키고 그 다음 `canonicalize`가 원격을 열어 버린다.
    #[cfg(windows)]
    #[test]
    fn rejects_a_two_hop_link_chain_that_ends_at_a_remote_share() {
        let base = std::env::temp_dir();
        let first = base.join(format!("discan_hop1_{}", std::process::id()));
        let second = base.join(format!("discan_hop2_{}", std::process::id()));
        let _ = std::fs::remove_dir(&first);
        let _ = std::fs::remove_dir(&second);

        // second → 원격, first → second. 대상 검증은 하지 않으므로 순서는 무관하다.
        if std::os::windows::fs::symlink_dir(r"\\127.0.0.1\discan$", &second).is_err() {
            eprintln!(
                "[skip] rejects_a_two_hop_link_chain_that_ends_at_a_remote_share: \
                 심볼릭 링크를 만들 수 없다(개발자 모드 필요)"
            );
            return;
        }
        if std::os::windows::fs::symlink_dir(&second, &first).is_err() {
            let _ = std::fs::remove_dir(&second);
            eprintln!("[skip] 두 번째 링크를 만들 수 없다(개발자 모드 필요)");
            return;
        }

        let err = resolve_root(&first.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, "uncRejected");

        let _ = std::fs::remove_dir(&first);
        let _ = std::fs::remove_dir(&second);
    }

    /// 링크 대상이 **매핑 네트워크 드라이브**(`Z:\share`)면 문자열 판정으로는
    /// 로컬과 구분되지 않는다. 홉마다 `GetDriveTypeW` 를 부르지 않던 시절에는
    /// 그 대상을 다음 반복의 `symlink_metadata` 가 그대로 열어(=네트워크 리디렉터로
    /// 나가) 거부는 그 뒤에야 이뤄졌다 — '판정이 stat 보다 먼저'라는 불변식이
    /// 이 갈래에서만 깨져 있었다.
    #[cfg(windows)]
    #[test]
    fn rejects_a_link_chain_that_ends_at_a_mapped_network_drive() {
        // 실제로 매핑된 원격 드라이브가 있어야 평가된다. 없으면 건너뛰되,
        // 건너뛴다는 사실을 남긴다 — 조용한 통과는 검증이 아니다.
        let mask = win::logical_drives();
        let mapped = (0..26u32).find(|i| {
            mask & (1 << i) != 0
                && win::drive_type(&format!("{}:\\", (b'A' + *i as u8) as char))
                    == win::DRIVE_REMOTE
        });
        let Some(index) = mapped else {
            eprintln!(
                "[skip] rejects_a_link_chain_that_ends_at_a_mapped_network_drive: \
                 매핑된 네트워크 드라이브가 없다"
            );
            return;
        };
        let target = format!("{}:\\", (b'A' + index as u8) as char);

        // 루트로 직접 지정하는 갈래는 이미 선판정이 막는다.
        assert_eq!(resolve_root(&target).unwrap_err().code, "remoteDrive");

        // 링크를 경유하는 갈래도 같은 자리에서 막혀야 한다.
        let link = std::env::temp_dir().join(format!("discan_mapped_{}", std::process::id()));
        let _ = std::fs::remove_dir(&link);
        if std::os::windows::fs::symlink_dir(&target, &link).is_err() {
            eprintln!(
                "[skip] rejects_a_link_chain_that_ends_at_a_mapped_network_drive: \
                 심볼릭 링크를 만들 수 없다(개발자 모드 필요)"
            );
            return;
        }
        assert_eq!(
            resolve_root(&link.to_string_lossy()).unwrap_err().code,
            "remoteDrive"
        );
        let _ = std::fs::remove_dir(&link);
    }

    /// 홉 상한을 넘는 구성(순환 포함)은 `linkUnresolved`로 거부한다.
    /// 상한이 없으면 순환 링크에서 이 루프가 영원히 돈다.
    #[cfg(windows)]
    #[test]
    fn rejects_a_link_cycle_by_hop_limit() {
        let base = std::env::temp_dir();
        let a = base.join(format!("discan_cyc_a_{}", std::process::id()));
        let b = base.join(format!("discan_cyc_b_{}", std::process::id()));
        let _ = std::fs::remove_dir(&a);
        let _ = std::fs::remove_dir(&b);

        if std::os::windows::fs::symlink_dir(&b, &a).is_err() {
            eprintln!("[skip] rejects_a_link_cycle_by_hop_limit: 심볼릭 링크를 만들 수 없다");
            return;
        }
        if std::os::windows::fs::symlink_dir(&a, &b).is_err() {
            let _ = std::fs::remove_dir(&a);
            eprintln!("[skip] rejects_a_link_cycle_by_hop_limit: 심볼릭 링크를 만들 수 없다");
            return;
        }

        assert_eq!(
            resolve_root(&a.to_string_lossy()).unwrap_err().code,
            "linkUnresolved"
        );

        let _ = std::fs::remove_dir(&a);
        let _ = std::fs::remove_dir(&b);
    }

    #[test]
    fn accepts_an_existing_directory() {
        let temp = std::env::temp_dir();
        let resolved =
            resolve_root(&temp.to_string_lossy()).expect("임시 디렉터리는 통과해야 한다");
        assert!(resolved.is_dir());
    }

    #[test]
    fn rejects_a_file() {
        let file = std::env::temp_dir().join(format!("discan_not_a_dir_{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let err = resolve_root(&file.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, "notADirectory");
        let _ = std::fs::remove_file(&file);
    }

    fn state() -> Arc<ScanState> {
        Arc::new(ScanState {
            running: AtomicBool::new(false),
            generation: AtomicU64::new(7),
            current: Mutex::new(None),
        })
    }

    /// 지금 설치된 진행 카운터. 없으면 테스트가 잘못 세운 것이다.
    fn current_progress(st: &ScanState) -> Arc<Progress> {
        st.current
            .lock()
            .unwrap()
            .clone()
            .expect("세대가 열렸다면 진행 카운터가 있어야 한다")
    }

    #[test]
    fn cancel_is_ignored_when_no_scan_is_running() {
        let st = state();
        let (_id, progress) = begin_generation(&st);
        assert!(!request_cancel(&st, None));
        // 여기서 플래그가 서면 다음 스캔이 시작하자마자 죽는다.
        assert!(!progress.cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn cancel_targets_only_its_own_generation() {
        let st = state();
        st.generation.store(6, Ordering::SeqCst);
        let (id, progress) = begin_generation(&st);
        assert_eq!(id, 7);
        st.running.store(true, Ordering::SeqCst);

        // 이전 세대를 겨냥한 취소는 방금 시작한 스캔을 건드리지 못한다.
        assert!(!request_cancel(&st, Some(6)));
        assert!(!progress.cancel.load(Ordering::Relaxed));

        assert!(request_cancel(&st, Some(7)));
        assert!(progress.cancel.load(Ordering::Relaxed));
    }

    /// 세대를 여는 순서가 뒤집히면(세대 증가 → 설치) 그 사이에 새 세대를 지목해
    /// 들어온 취소가 옛 카운터에 걸려 사라지고, '중단 중…'이 스캔이 끝날 때까지
    /// 풀리지 않는다.
    #[test]
    fn a_new_generation_starts_clean_and_keeps_later_cancels() {
        let st = state();
        st.running.store(true, Ordering::SeqCst);
        // 이전 스캔이 남긴 취소·카운터를 새 스캔이 물려받아서는 안 된다.
        let (_old_id, old) = begin_generation(&st);
        old.cancel.store(true, Ordering::Relaxed);
        old.files.store(42, Ordering::Relaxed);

        let (id, progress) = begin_generation(&st);
        assert_eq!(id, 9);
        assert!(!progress.cancel.load(Ordering::Relaxed));
        assert_eq!(progress.files.load(Ordering::Relaxed), 0);

        // 세대가 공개된 뒤에 도착한 취소는 무엇에도 지워지지 않는다.
        assert!(request_cancel(&st, Some(id)));
        assert!(progress.cancel.load(Ordering::Relaxed));
    }

    /// 드롭된 스캔과 다음 스캔이 같은 카운터를 공유하면, 아무도 멈출 수 없는 옛
    /// 순회가 새 스캔의 진행률에 계속 더한다 — '동시에 두 스캔이 돌지 않는다'는
    /// 불변식이 정확히 여기서 깨졌다.
    #[test]
    fn each_generation_gets_its_own_progress() {
        let st = state();
        let (_first_id, first) = begin_generation(&st);
        first.files.store(100, Ordering::Relaxed);

        let (second_id, second) = begin_generation(&st);
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(second.files.load(Ordering::Relaxed), 0);

        // 옛 스캔이 계속 돌아도 새 세대의 카운터는 오염되지 않는다.
        first.files.fetch_add(1, Ordering::Relaxed);
        assert_eq!(second.files.load(Ordering::Relaxed), 0);

        // 취소는 언제나 '지금 설치된' 세대를 지목한다.
        st.running.store(true, Ordering::SeqCst);
        assert!(request_cancel(&st, Some(second_id)));
        assert!(second.cancel.load(Ordering::Relaxed));
        assert!(!first.cancel.load(Ordering::Relaxed));
        assert!(Arc::ptr_eq(&current_progress(&st), &second));
    }

    #[test]
    fn reentrancy_guard_blocks_a_second_scan_and_releases_on_drop() {
        let st = state();
        assert!(st
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok());
        // 프런트의 플래그는 신뢰 경계 밖이다. 두 번째 진입은 백엔드가 거부해야 한다.
        assert!(st
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err());

        let (_id, progress) = begin_generation(&st);
        let done = Arc::new(AtomicBool::new(false));
        {
            let _guard = RunGuard {
                state: st.clone(),
                progress: progress.clone(),
                done: done.clone(),
            };
        }
        // 정상·오류·패닉 어느 경로로 빠져나가도 다음 스캔이 가능해야 한다.
        assert!(!st.running.load(Ordering::SeqCst));
        // future 가 드롭돼도 순회는 spawn_blocking 안에서 계속 돈다. 취소를 함께
        // 세우지 않으면 그 스캔은 아무도 멈출 수 없다.
        assert!(progress.cancel.load(Ordering::Relaxed));
        // 방출 스레드도 같은 드롭 경로에서 끝나야 한다. 예전에는 이 플래그가
        // 스캔 await 의 **정상 반환 뒤에만** 세워져, 드롭되면 스레드가 다음 스캔이
        // 시작될 때까지 150ms 마다 끝난 세대의 이벤트를 계속 방출했다.
        assert!(
            done.load(Ordering::SeqCst),
            "드롭 경로에서 진행 방출 스레드의 종료 조건이 서지 않았다"
        );
    }

    #[cfg(windows)]
    #[test]
    fn strips_verbatim_prefix_for_display() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Users")),
            PathBuf::from(r"C:\Users")
        );
        // UNC 형식은 그대로 둔다.
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\?\UNC\server\share")
        );
    }
}
