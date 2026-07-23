//! 디렉터리 열거.
//!
//! Windows 에서는 `std::fs::read_dir` + `entry.metadata()` 대신 Win32 로 직접
//! 열거한다. 그 조합이 항목마다 돌려주는 것은 **논리 크기뿐**이라 두 가지가 함께
//! 어긋나 있었다.
//!
//! - 하드 링크로 이어진 같은 실체를 링크 수만큼 중복 계산한다
//!   (`C:\Windows\WinSxS` 가 실제 점유보다 몇 배 크게 잡히는 원인).
//! - 디스크 점유를 클러스터 올림으로 **근사**할 수밖에 없다.
//!
//! `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)` 는 항목마다 파일 ID·
//! 할당 크기·논리 크기·속성을 **한 번의 열거로 함께** 돌려주므로 두 문제가 같이
//! 풀린다. 파일마다 핸들을 여는 방식(`CreateFileW` × 파일 수)은 스캔 시간이
//! 자릿수 단위로 늘어나므로 쓰지 않는다 — 이 모듈이 여는 핸들은 **디렉터리당 하나**다.

use std::path::Path;

/// 디렉터리 항목 하나.
pub struct Entry {
    pub name: std::ffi::OsString,
    /// Win32 파일 속성 비트. 비 Windows 에서는 0이다.
    pub attributes: u32,
    /// 논리 크기(EndOfFile).
    pub size: u64,
    /// 파일시스템이 실제로 배정한 바이트(AllocationSize). `None` 이면 이 플랫폼이
    /// 주지 않는다는 뜻이고, 그때는 호출자가 클러스터 올림으로 대신한다.
    pub allocation: Option<u64>,
    /// 볼륨 안에서 파일 **실체**를 지목하는 ID. 하드 링크 판정 키의 뒤쪽 절반이다.
    /// 0은 '미상'이라 `None` 으로 접는다 — 0을 유효한 ID로 쓰면 서로 다른 파일이
    /// 한 실체로 뭉쳐 실제 용량이 조용히 사라진다.
    pub file_id: Option<u64>,
    pub is_dir: bool,
    pub is_file: bool,
    /// 재해석 지점인지. 링크(정션·심볼릭)와 클라우드 자리표시자가 **둘 다** 여기
    /// 걸리므로 갈래는 호출자가 확정한다 — 이 플래그만 보고 건너뛰면 OneDrive
    /// 폴더가 통째로 무신호 제외된다.
    pub is_reparse: bool,
}

/// 디렉터리 하나의 열거 결과.
pub struct Listing {
    pub entries: Vec<Entry>,
    /// 항목 단위로 실패해 목록에서 빠진 오류들.
    ///
    /// Win32 일괄 열거에서는 항상 비어 있다(디렉터리가 통째로 성공하거나 통째로
    /// 실패한다). 비 Windows 의 `read_dir` 은 항목마다 실패할 수 있어, 그것을
    /// 조용히 버리지 않도록 여기에 모아 호출자가 계상하게 한다.
    pub entry_errors: Vec<std::io::Error>,
}

#[cfg(windows)]
pub fn read_dir(path: &Path) -> std::io::Result<Listing> {
    imp::read_dir(path)
}

/// 비 Windows 폴백. 파일 ID·할당 크기는 얻지 못하므로 `None` 이고, 그 결과
/// 하드 링크 중복 제거와 정확한 점유량은 이 플랫폼에서 꺼진다(결과 필드가 그 사실을 말한다).
#[cfg(not(windows))]
pub fn read_dir(path: &Path) -> std::io::Result<Listing> {
    let mut entries = Vec::new();
    let mut entry_errors = Vec::new();
    for item in std::fs::read_dir(path)? {
        let item = match item {
            Ok(i) => i,
            Err(e) => {
                entry_errors.push(e);
                continue;
            }
        };
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(e) => {
                entry_errors.push(e);
                continue;
            }
        };
        let ft = meta.file_type();
        entries.push(Entry {
            name: item.file_name(),
            attributes: 0,
            size: meta.len(),
            allocation: None,
            file_id: None,
            is_dir: ft.is_dir(),
            is_file: ft.is_file(),
            is_reparse: ft.is_symlink(),
        });
    }
    Ok(Listing {
        entries,
        entry_errors,
    })
}

#[cfg(windows)]
mod imp {
    use super::{Entry, Listing};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_HANDLE_EOF, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
        GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_BOTH_DIR_INFO,
        FILE_LIST_DIRECTORY, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    /// 열거 버퍼 크기(u64 단위 = 64KiB).
    ///
    /// 항목 하나는 최대 약 600바이트(이름 255자 + 고정부)라 한 번의 호출로 수백 개가
    /// 돌아온다. 버퍼를 `Vec<u64>` 로 잡는 이유는 `FILE_ID_BOTH_DIR_INFO` 가 8바이트
    /// 정렬을 요구하기 때문이다 — `Vec<u8>` 은 1바이트 정렬이라 미정렬 접근이 된다.
    const BUF_U64: usize = 8 * 1024;

    /// 디렉터리 핸들. 조기 반환·`?`·패닉 어느 경로로 빠져도 닫힌다.
    struct DirHandle(HANDLE);

    impl Drop for DirHandle {
        fn drop(&mut self) {
            // SAFETY: 이 구조체가 소유한, 아직 닫지 않은 유효 핸들 하나만 닫는다.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// MAX_PATH(260)을 넘는 경로에는 `\\?\` 접두사를 붙여 연다.
    ///
    /// `std::fs::read_dir` 이 내부적으로 하던 일과 같다. 붙이지 않으면 260자를 넘는
    /// 디렉터리가 하나도 열리지 않아, 깊은 트리가 통째로 `tooLong` 으로 빠진다 —
    /// Win32 열거로 갈아타면서 조용히 잃기 쉬운 동작이라 여기서 되살린다.
    ///
    /// 접두사는 경로 정규화(`.`·`..`·중복 구분자·정방향 슬래시)를 **끄므로**, 짧은
    /// 경로에는 붙이지 않고 붙일 때는 구분자만 정규화한다. 이 앱의 순회 경로는
    /// 검증된 절대 루트에 이름을 이어 붙인 것이라 `..` 이 남을 여지는 없다.
    fn wide_path(path: &Path) -> Vec<u16> {
        const MAX_PATH_LEN: usize = 260;
        const BACKSLASH: u16 = b'\\' as u16;
        const SLASH: u16 = b'/' as u16;

        let raw: Vec<u16> = path.as_os_str().encode_wide().collect();
        let already_verbatim = raw.starts_with(&[BACKSLASH, BACKSLASH, b'?' as u16, BACKSLASH]);
        // 드라이브 절대 경로에만 붙인다. UNC 는 이 앱이 애초에 거부하는 형태다.
        let drive_absolute =
            raw.len() >= 3 && raw[1] == b':' as u16 && (raw[2] == BACKSLASH || raw[2] == SLASH);

        if already_verbatim || raw.len() < MAX_PATH_LEN || !drive_absolute {
            return raw.into_iter().chain(std::iter::once(0)).collect();
        }

        let mut out: Vec<u16> = r"\\?\".encode_utf16().collect();
        out.extend(
            raw.into_iter()
                .map(|c| if c == SLASH { BACKSLASH } else { c }),
        );
        out.push(0);
        out
    }

    pub fn read_dir(path: &Path) -> std::io::Result<Listing> {
        let wide = wide_path(path);

        // 재해석 지점을 **따라간다**(`OPEN_REPARSE_POINT` 를 주지 않는다). `read_dir`
        // 과 같은 의미를 유지해야 OneDrive 동기화 루트·WOF 압축 디렉터리를 정상적으로
        // 내려갈 수 있다. 링크를 따라가지 않는 방어는 호출자가 항목 단위로 건다.
        // SAFETY: 널 종료된 UTF-16 경로와 상수 플래그만 넘긴다. 실패는 값으로 돌아온다.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let dir = DirHandle(handle);

        let mut buf: Vec<u64> = vec![0; BUF_U64];
        let byte_len = (BUF_U64 * 8) as u32;
        let mut entries: Vec<Entry> = Vec::new();
        let mut first = true;

        loop {
            let class = if first {
                FileIdBothDirectoryRestartInfo
            } else {
                FileIdBothDirectoryInfo
            };
            // SAFETY: 살아 있는 디렉터리 핸들과, 길이를 정확히 넘긴 8바이트 정렬 버퍼다.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    dir.0,
                    class,
                    buf.as_mut_ptr() as *mut core::ffi::c_void,
                    byte_len,
                )
            };
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                // 열거 끝은 오류가 아니다. 두 코드 모두 실제로 관측되므로 함께 본다.
                let code = err.raw_os_error().unwrap_or(0) as u32;
                if code == ERROR_NO_MORE_FILES || code == ERROR_HANDLE_EOF {
                    break;
                }
                return Err(err);
            }
            first = false;

            let base = buf.as_ptr() as *const u8;
            let mut offset: usize = 0;
            loop {
                // SAFETY: `offset` 은 커널이 채운 `NextEntryOffset` 사슬을 따라가므로
                // 버퍼 안을 가리키고, 그 자리에는 커널이 쓴 유효한 구조체가 있다.
                let info = unsafe { &*(base.add(offset) as *const FILE_ID_BOTH_DIR_INFO) };

                let name_units = info.FileNameLength as usize / 2;
                // SAFETY: `FileName` 은 가변 길이 배열의 첫 원소이고, 커널이 그 뒤로
                // `FileNameLength` 바이트를 같은 버퍼 안에 채워 두었다.
                let name_slice = unsafe {
                    std::slice::from_raw_parts(
                        std::ptr::addr_of!(info.FileName) as *const u16,
                        name_units,
                    )
                };

                // `.`·`..` 는 항목이 아니다. 넣으면 자기 자신으로 무한히 내려간다.
                let is_dot =
                    name_slice == [b'.' as u16] || name_slice == [b'.' as u16, b'.' as u16];
                if !is_dot {
                    let attributes = info.FileAttributes;
                    let is_dir = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
                    entries.push(Entry {
                        name: OsString::from_wide(name_slice),
                        attributes,
                        size: info.EndOfFile.max(0) as u64,
                        allocation: Some(info.AllocationSize.max(0) as u64),
                        // 0은 '미상'이다. FAT 계열은 여기가 안정적이지 않아 호출자가
                        // 파일시스템 이름을 보고 중복 제거 자체를 끈다.
                        file_id: match info.FileId {
                            0 => None,
                            id => Some(id as u64),
                        },
                        is_dir,
                        is_file: !is_dir,
                        is_reparse: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
                    });
                }

                let next = info.NextEntryOffset as usize;
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }

        Ok(Listing {
            entries,
            entry_errors: Vec::new(),
        })
    }
}
