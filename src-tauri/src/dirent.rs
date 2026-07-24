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
        CreateFileW, FileAttributeTagInfo, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
        GetFileInformationByHandleEx, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    /// 대상을 **바꾸는** 재해석 지점(링크)의 태그. std 의 `is_symlink` 이 참으로
    /// 보는 것이 정확히 이 둘이며, 클라우드·WOF·중복제거 같은 나머지 재해석 지점과
    /// 구분된다. windows-sys 는 이 값을 `Win32_System_SystemServices` feature 에 두는데,
    /// 상수 둘 때문에 모듈 전체를 켜기보다(공격 표면·빌드 시간을 늘린다) 이 파일의
    /// `FILE_ATTRIBUTE_*` 상수들과 같은 방식으로 둔다. 값은 MSDN 고정값이다.
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;

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

    /// 열거용 디렉터리 핸들을 연다. 재해석 지점 바꿔치기(TOCTOU)를 좁히기 위해
    /// **먼저 재해석 지점을 따라가지 않고** 열어 정체를 확인한다.
    ///
    /// 호출자(`scan_dir`)는 `read_dir` 직전에 `is_redirecting_link` 로 링크를 거르지만,
    /// 그 판정과 이 `CreateFileW` 사이의 창에서 대상이 심볼릭 링크(→ `\\attacker\share`)
    /// 로 바뀌면, 예전 구현은 그 링크를 따라 원격을 열어 현재 사용자의 NTLM 협상을
    /// 공격자 호스트로 내보냈다 — `resolve_root` 가 세 겹으로 막아 둔 바로 그 위협이
    /// 순회 한복판에서 다시 열린 것이다.
    ///
    /// 그래서 첫 열기는 `OPEN_REPARSE_POINT` 로 재해석 지점을 **따라가지 않는다**.
    /// - 정상 디렉터리(절대다수): 그 핸들로 그대로 열거한다. 이 플래그는 재해석
    ///   지점이 아닌 대상에는 무영향이라 열거 동작·성능이 그대로다. 바꿔치기된
    ///   심볼릭 링크는 재해석 지점이라 이 갈래로 오지 않으므로, 공격은 원격 접촉
    ///   **없이** 아래 링크 갈래에서 걸린다.
    /// - 링크(심볼릭·정션): 따라가지 않고 거부한다. 호출자가 이미 링크를 거르므로
    ///   이 거부는 사실상 TOCTOU 창에서만 발동한다.
    /// - 그 밖의 재해석 지점(OneDrive 클라우드 루트·WOF·중복제거): 따라가야 정상
    ///   순회가 되므로, 재해석 지점을 따라가는 방식으로 다시 연다(예전 동작 유지).
    ///
    /// 근본 해결은 검증된 부모 핸들을 쥐고 `NtQueryDirectoryFile` 로 내려가 경로
    /// 문자열 바꿔치기가 열거 대상에 닿지 못하게 하는 것이고, 그건 별개 과제다.
    /// 이 함수는 창을 없애지 못하고 **가장 흔한 공격 형태(정상 디렉터리 → 링크
    /// 바꿔치기)를 원격 접촉 없이 막는** 부분 완화다.
    fn open_dir(wide: &[u16]) -> std::io::Result<DirHandle> {
        // 1) 재해석 지점을 따라가지 않고 연다. 속성/태그 조회를 위해 읽기 권한을 더한다.
        // SAFETY: 널 종료된 UTF-16 경로와 상수 플래그만 넘긴다. 실패는 값으로 돌아온다.
        let probe = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if probe == INVALID_HANDLE_VALUE {
            // 정상 디렉터리는 이 플래그로도 문제없이 열리므로, 실패는 진짜 실패다
            // (없음·거부 등). 여기서 플래그 없이 다시 열면 바로 그 취약점을 되살린다.
            return Err(std::io::Error::last_os_error());
        }
        let probe = DirHandle(probe);

        // 2) 재해석 지점인지, 링크인지 태그로 가른다.
        // SAFETY: FILE_ATTRIBUTE_TAG_INFO 는 정수 두 필드짜리 POD 이며 all-zero 가
        // 유효한 비트 패턴이다.
        let mut tag: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: 방금 연 핸들과, 크기를 정확히 넘긴 살아 있는 출력 구조체다.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                probe.0,
                FileAttributeTagInfo,
                &mut tag as *mut _ as *mut core::ffi::c_void,
                core::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };

        // 태그를 못 읽었거나 재해석 지점이 아니면, 따라가지 않은 이 핸들로 그대로
        // 열거한다(원격 접촉이 없는 안전한 기본값). 정상 디렉터리는 전부 이 갈래다.
        if ok == 0 || tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            return Ok(probe);
        }

        // 링크(심볼릭·정션)는 따라가지 않고 거부한다. 원시 OS 코드가 없는 오류라
        // 호출자의 `error_kind` 가 'other' 로 계상하며, 이는 호출자가 링크를 직접
        // 거를 때(`is_redirecting_link`)와 같은 갈래다 — 조용히 빠지지 않는다.
        if tag.ReparseTag == IO_REPARSE_TAG_SYMLINK || tag.ReparseTag == IO_REPARSE_TAG_MOUNT_POINT
        {
            return Err(std::io::Error::other(
                "재해석 지점(링크) 디렉터리는 따라가지 않는다",
            ));
        }

        // 링크가 아닌 재해석 지점(클라우드·WOF·중복제거)은 따라가야 정상 순회가 된다.
        // 예전과 같이 재해석 지점을 따라가는 방식으로 다시 연다.
        drop(probe);
        // SAFETY: 위와 같되 OPEN_REPARSE_POINT 를 빼 재해석 지점을 따라간다.
        let follow = unsafe {
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
        if follow == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        Ok(DirHandle(follow))
    }

    pub fn read_dir(path: &Path) -> std::io::Result<Listing> {
        let wide = wide_path(path);
        let dir = open_dir(&wide)?;

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

#[cfg(all(test, windows))]
mod tests {
    use super::read_dir;
    use std::path::{Path, PathBuf};
    use std::process;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 심볼릭 링크(개발자 모드/관리자 필요)와 정션(권한 불필요)을 모두 시도한다.
    /// 조용히 통과하는 테스트는 없는 테스트보다 나쁘므로, 둘 다 실패하면 건너뛴다.
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn lists_a_normal_directory() {
        let root = std::env::temp_dir().join(format!("discan_dirent_{}", process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.bin"), b"xyz").unwrap();
        let fx = Fixture(root);

        let listing = read_dir(&fx.0).expect("정상 디렉터리는 열거되어야 한다");
        assert!(listing
            .entries
            .iter()
            .any(|e| e.name.to_string_lossy() == "a.bin"));
        assert!(listing.entry_errors.is_empty());
    }

    /// 순회 진입 TOCTOU 완화: 링크 디렉터리를 `read_dir` 로 직접 열면 **따라가지 않고
    /// 거부**한다. 판정과 열기 사이에 대상이 심볼릭 링크(→ 원격)로 바뀌어도 그 링크를
    /// 따라 원격을 여는 경로를 여기서 닫는다. 대상 디렉터리 자체는 그대로 열린다.
    #[test]
    fn refuses_to_follow_a_directory_link() {
        let base = std::env::temp_dir();
        let target = base.join(format!("discan_dirent_tgt_{}", process::id()));
        let link = base.join(format!("discan_dirent_lnk_{}", process::id()));
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir(&link);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.bin"), b"xyz").unwrap();
        let _tfx = Fixture(target.clone());

        if !make_dir_link(&target, &link) {
            eprintln!(
                "[skip] refuses_to_follow_a_directory_link: 심볼릭 링크·정션 생성 실패(개발자 모드 필요)"
            );
            return;
        }

        // 링크를 따라갔다면 target 의 항목이 나왔을 것이다. 거부되어야 한다.
        let refused = read_dir(&link).is_err();
        // 대상은 정상적으로 열린다(완화가 정상 디렉터리를 막지 않는다).
        let target_entries = read_dir(&target).map(|l| l.entries.len()).unwrap_or(0);

        let _ = std::fs::remove_dir(&link);
        assert!(
            refused,
            "링크 디렉터리를 따라가 열거했다 — TOCTOU 완화가 깨졌다"
        );
        assert!(
            target_entries >= 1,
            "대상 디렉터리는 정상적으로 열려야 한다"
        );
    }
}
