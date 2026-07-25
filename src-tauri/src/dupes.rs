//! 내용이 같은 파일(중복)을 찾는다.
//!
//! 순서가 곧 비용 절감이다. 내용을 읽는 해시는 비싸므로 **크기로 먼저 거른다** —
//! 크기가 다르면 내용도 다르다. 같은 크기 후보만 부분 해시(앞 16KiB)로 다시 거르고,
//! 부분까지 같은 것만 전체 해시한다. blake3 는 암호학적 강도라, 해시 충돌로 서로 다른
//! 파일이 '중복'으로 오판돼 삭제되는 일을 막는다(약한 해시를 쓰면 그 위험이 실재한다).
//!
//! 하드 링크는 같은 실체를 가리키므로 '중복'이 아니다 — 하나를 지워도 공간이 나지
//! 않는다. 전체 해시 그룹 안에서 (볼륨 시리얼, 파일 ID)로 접어, 회수 가능 용량을
//! 부풀리지 않는다.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// 부분 해시로 읽을 앞부분 크기. 대부분의 서로 다른 같은-크기 파일은 여기서 갈린다.
const PARTIAL_BYTES: usize = 16 * 1024;
/// 전체 해시를 읽을 청크 크기.
const CHUNK: usize = 256 * 1024;
/// 이보다 작은 파일은 다루지 않는다. 4KiB 미만 소형 파일은 수가 많고 회수 가치가 낮아,
/// 해시 비용만 늘리고 목록을 잡음으로 채운다. 화면에 이 하한을 함께 고지한다.
pub const DEFAULT_MIN_BYTES: u64 = 64 * 1024;
/// 반환 그룹 상한. 회수 가능 용량이 큰 것부터. 넘으면 truncated 로 알린다.
const MAX_GROUPS: usize = 1000;

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 진행 상황·취소. scan::Progress 와 같은 역할이되 중복 탐지 전용 축을 쓴다.
pub struct DupeProgress {
    /// 순회하며 만난 파일 수(크기 수집 단계).
    pub scanned: AtomicU64,
    /// 해시한 파일 수(부분+전체).
    pub hashed: AtomicU64,
    /// 해시하며 읽은 바이트.
    pub bytes: AtomicU64,
    /// 확정된 중복 그룹 수.
    pub groups: AtomicU64,
    pub errors: AtomicU64,
    pub cancel: AtomicBool,
    /// 지금 무슨 단계인지("scanning" | "hashing"). 화면 문구를 위해.
    phase: Mutex<&'static str>,
}

impl DupeProgress {
    pub fn new() -> Self {
        DupeProgress {
            scanned: AtomicU64::new(0),
            hashed: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            groups: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
            phase: Mutex::new("scanning"),
        }
    }
    fn set_phase(&self, p: &'static str) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = p;
    }
    pub fn phase(&self) -> &'static str {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl Default for DupeProgress {
    fn default() -> Self {
        Self::new()
    }
}

/// 중복 그룹 하나. 같은 내용의 파일들.
#[derive(Serialize)]
pub struct DuplicateGroup {
    /// 파일 하나의 크기(그룹 내 전부 동일).
    pub size: u64,
    /// 그룹의 파일 수.
    pub count: u64,
    /// 하나만 남기고 지웠을 때 회수되는 용량 = size × (count − 1).
    pub reclaimable: u64,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
pub struct DupeResult {
    pub groups: Vec<DuplicateGroup>,
    #[serde(rename = "totalGroups")]
    pub total_groups: u64,
    #[serde(rename = "totalReclaimable")]
    pub total_reclaimable: u64,
    #[serde(rename = "filesScanned")]
    pub files_scanned: u64,
    #[serde(rename = "filesHashed")]
    pub files_hashed: u64,
    #[serde(rename = "bytesHashed")]
    pub bytes_hashed: u64,
    /// 다룬 최소 파일 크기. 이보다 작은 중복은 찾지 않았음을 화면이 고지한다.
    #[serde(rename = "minBytes")]
    pub min_bytes: u64,
    pub errors: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// 그룹이 상한(MAX_GROUPS)에 걸려 잘렸는지.
    pub truncated: bool,
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// 크기별 경로 목록을 수집한다. 재해석 지점(정션·심볼릭 링크)은 따라가지 않는다 —
/// 스캔과 같은 이유로, 순환·이중 계수·원격 접촉을 막는다.
fn collect(root: &Path, min_bytes: u64, prog: &DupeProgress) -> HashMap<u64, Vec<String>> {
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if prog.cancelled() {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => {
                prog.errors.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        for entry in entries.flatten() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => {
                    prog.errors.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };
            if is_reparse(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                prog.scanned.fetch_add(1, Ordering::Relaxed);
                let size = meta.len();
                if size >= min_bytes {
                    by_size
                        .entry(size)
                        .or_default()
                        .push(entry.path().to_string_lossy().into_owned());
                }
            }
        }
    }
    by_size
}

fn partial_hash(path: &str) -> Option<[u8; 32]> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; PARTIAL_BYTES];
    let mut read = 0;
    while read < PARTIAL_BYTES {
        match f.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return None,
        }
    }
    Some(*blake3::hash(&buf[..read]).as_bytes())
}

fn full_hash(path: &str, prog: &DupeProgress) -> Option<[u8; 32]> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if prog.cancelled() {
            return None;
        }
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                hasher.update(&buf[..n]);
                prog.bytes.fetch_add(n as u64, Ordering::Relaxed);
            }
            Err(_) => return None,
        }
    }
    Some(*hasher.finalize().as_bytes())
}

/// 같은 실체를 가리키는 하드 링크를 접는다. 파일 ID 를 못 읽으면(권한·플랫폼) 별개로 둔다.
fn dedup_hardlinks(paths: Vec<String>) -> Vec<String> {
    let mut seen: std::collections::HashSet<(u32, u64)> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        match identity(&p) {
            Some(id) => {
                if seen.insert(id) {
                    out.push(p);
                }
            }
            None => out.push(p),
        }
    }
    out
}

#[cfg(windows)]
fn identity(path: &str) -> Option<(u32, u64)> {
    crate::win::file_identity(Path::new(path))
}

#[cfg(not(windows))]
fn identity(path: &str) -> Option<(u32, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path).ok()?;
    Some((m.dev() as u32, m.ino()))
}

/// 같은 크기 후보를 (부분 해시 → 전체 해시)로 좁혀 진짜 중복 그룹만 남긴다.
fn resolve_group(size: u64, paths: Vec<String>, prog: &DupeProgress) -> Vec<DuplicateGroup> {
    // 1) 부분 해시로 1차 분할.
    let partial: Vec<(String, [u8; 32])> = paths
        .into_par_iter()
        .filter_map(|p| {
            if prog.cancelled() {
                return None;
            }
            let h = partial_hash(&p);
            prog.hashed.fetch_add(1, Ordering::Relaxed);
            match h {
                Some(h) => Some((p, h)),
                None => {
                    prog.errors.fetch_add(1, Ordering::Relaxed);
                    None
                }
            }
        })
        .collect();

    let mut by_partial: HashMap<[u8; 32], Vec<String>> = HashMap::new();
    for (p, h) in partial {
        by_partial.entry(h).or_default().push(p);
    }

    let mut out = Vec::new();
    for (_, group) in by_partial {
        if group.len() < 2 || prog.cancelled() {
            continue;
        }
        // 2) 전체 해시로 확정.
        let full: Vec<(String, [u8; 32])> = group
            .into_par_iter()
            .filter_map(|p| {
                let h = full_hash(&p, prog);
                match h {
                    Some(h) => Some((p, h)),
                    None => {
                        // 취소로 None 이면 errors 를 올리지 않는다.
                        if !prog.cancelled() {
                            prog.errors.fetch_add(1, Ordering::Relaxed);
                        }
                        None
                    }
                }
            })
            .collect();

        let mut by_full: HashMap<[u8; 32], Vec<String>> = HashMap::new();
        for (p, h) in full {
            by_full.entry(h).or_default().push(p);
        }
        for (_, same) in by_full {
            // 3) 하드 링크는 같은 실체이므로 접는다.
            let mut same = dedup_hardlinks(same);
            if same.len() < 2 {
                continue;
            }
            // 경로 정렬로 결과를 결정적으로 만든다(테스트·재현).
            same.sort_unstable();
            let count = same.len() as u64;
            out.push(DuplicateGroup {
                size,
                count,
                reclaimable: size * (count - 1),
                paths: same,
            });
            prog.groups.fetch_add(1, Ordering::Relaxed);
        }
    }
    out
}

pub fn find_duplicates(root: &Path, min_bytes: u64, prog: &DupeProgress) -> DupeResult {
    let start = std::time::Instant::now();

    prog.set_phase("scanning");
    let by_size = collect(root, min_bytes, prog);

    prog.set_phase("hashing");
    // 후보(같은 크기 2개 이상)만 남긴다.
    let candidates: Vec<(u64, Vec<String>)> =
        by_size.into_iter().filter(|(_, v)| v.len() >= 2).collect();

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (size, paths) in candidates {
        if prog.cancelled() {
            break;
        }
        groups.extend(resolve_group(size, paths, prog));
    }

    // 회수 가능 용량이 큰 것부터. 상한을 넘으면 뒤를 자르되 사실을 남긴다.
    groups.sort_unstable_by(|a, b| {
        b.reclaimable
            .cmp(&a.reclaimable)
            .then_with(|| a.paths.first().cmp(&b.paths.first()))
    });
    let total_groups = groups.len() as u64;
    let total_reclaimable: u64 = groups.iter().map(|g| g.reclaimable).sum();
    let truncated = groups.len() > MAX_GROUPS;
    if truncated {
        groups.truncate(MAX_GROUPS);
    }

    DupeResult {
        groups,
        total_groups,
        total_reclaimable,
        files_scanned: prog.scanned.load(Ordering::Relaxed),
        files_hashed: prog.hashed.load(Ordering::Relaxed),
        bytes_hashed: prog.bytes.load(Ordering::Relaxed),
        min_bytes,
        errors: prog.errors.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        cancelled: prog.cancelled(),
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn write(path: &PathBuf, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("discan_dupe_{}", name));
        let _ = fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn finds_identical_content_across_folders() {
        let root = fixture("basic");
        let big = vec![b'A'; 100 * 1024]; // 100KiB, 하한 초과
        let other = vec![b'B'; 100 * 1024]; // 같은 크기, 다른 내용
        write(&root.join("a").join("dup1.bin"), &big);
        write(&root.join("b").join("dup2.bin"), &big);
        write(&root.join("c").join("dup3.bin"), &big);
        write(&root.join("unique.bin"), &other); // 같은 크기지만 내용 다름 → 중복 아님

        let prog = DupeProgress::new();
        let r = find_duplicates(&root, DEFAULT_MIN_BYTES, &prog);

        assert_eq!(r.groups.len(), 1);
        let g = &r.groups[0];
        assert_eq!(g.count, 3);
        assert_eq!(g.size, 100 * 1024);
        assert_eq!(g.reclaimable, 100 * 1024 * 2); // 3개 중 2개분
                                                   // 내용이 다른 같은-크기 파일은 그룹에 없다.
        assert!(g.paths.iter().all(|p| !p.ends_with("unique.bin")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_files_below_min_bytes() {
        let root = fixture("small");
        let tiny = vec![b'x'; 1024]; // 1KiB < 64KiB 하한
        write(&root.join("t1.bin"), &tiny);
        write(&root.join("t2.bin"), &tiny);

        let prog = DupeProgress::new();
        let r = find_duplicates(&root, DEFAULT_MIN_BYTES, &prog);
        assert_eq!(r.groups.len(), 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn different_sizes_are_never_hashed() {
        let root = fixture("sizes");
        write(&root.join("a.bin"), &vec![b'A'; 100 * 1024]);
        write(&root.join("b.bin"), &vec![b'B'; 200 * 1024]);

        let prog = DupeProgress::new();
        let r = find_duplicates(&root, DEFAULT_MIN_BYTES, &prog);
        assert_eq!(r.groups.len(), 0);
        // 크기가 모두 달라 후보가 없으므로 해시가 한 번도 일어나지 않는다.
        assert_eq!(r.files_hashed, 0);

        let _ = fs::remove_dir_all(&root);
    }
}
