//! 디렉터리 트리를 병렬로 순회하며 크기와 분야를 집계한다.

use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::category::{classify_ext, hint_from_dir, Category, ALL_CATEGORIES, CATEGORY_COUNT};

/// Windows 재해석 지점(심볼릭 링크·정션·OneDrive 자리표시자).
/// 따라 들어가면 순환하거나 같은 데이터를 두 번 세게 된다.
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[derive(Serialize, Clone)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub files: u64,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Vec<Node>,
    /// 가지치기로 잘려나간 자식 수. 0이면 트리가 완전하다.
    pub truncated: u32,
}

#[derive(Serialize, Clone)]
pub struct CategoryStat {
    pub key: String,
    pub label: String,
    pub size: u64,
    pub files: u64,
}

#[derive(Serialize)]
pub struct ScanResult {
    pub root: Node,
    pub categories: Vec<CategoryStat>,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    #[serde(rename = "totalFiles")]
    pub total_files: u64,
    #[serde(rename = "totalDirs")]
    pub total_dirs: u64,
    /// 권한 거부 등으로 읽지 못한 디렉터리 수. 결과가 과소 집계됐다는 신호다.
    pub errors: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    /// 사용자가 중단시킨 결과인지. true면 부분 집계다.
    pub cancelled: bool,
}

#[derive(Clone, Copy, Default)]
struct CatAcc {
    size: u64,
    files: u64,
}

#[derive(Clone, Copy)]
struct Stats {
    cats: [CatAcc; CATEGORY_COUNT],
}

impl Default for Stats {
    fn default() -> Self {
        Stats {
            cats: [CatAcc::default(); CATEGORY_COUNT],
        }
    }
}

impl Stats {
    fn add(&mut self, cat: Category, size: u64) {
        let slot = &mut self.cats[cat.index()];
        slot.size += size;
        slot.files += 1;
    }

    fn merge(&mut self, other: &Stats) {
        for i in 0..CATEGORY_COUNT {
            self.cats[i].size += other.cats[i].size;
            self.cats[i].files += other.cats[i].files;
        }
    }
}

/// 스캔 진행 중 공유되는 카운터. 진행률 표시와 취소에 쓴다.
pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub cancel: AtomicBool,
}

impl Progress {
    pub fn new() -> Self {
        Progress {
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
        }
    }

    pub fn reset(&self) {
        self.files.store(0, Ordering::Relaxed);
        self.dirs.store(0, Ordering::Relaxed);
        self.bytes.store(0, Ordering::Relaxed);
        self.errors.store(0, Ordering::Relaxed);
        self.cancel.store(false, Ordering::Relaxed);
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// 하드 링크·정션을 따라가지 않는지 판정.
fn is_reparse_point(meta: &fs::Metadata) -> bool {
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

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        // 선행 점만 있는 이름(`.gitignore`)은 확장자가 아니라 이름이다.
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn scan_dir(path: &Path, hint: Option<Category>, progress: &Progress) -> (Node, Stats) {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let mut node = Node {
        name,
        path: path.to_string_lossy().into_owned(),
        size: 0,
        files: 0,
        is_dir: true,
        children: Vec::new(),
        truncated: 0,
    };
    let mut stats = Stats::default();

    if progress.is_cancelled() {
        return (node, stats);
    }

    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => {
            // 권한 거부가 대부분이다. 세어두고 조용히 넘어간다.
            progress.errors.fetch_add(1, Ordering::Relaxed);
            return (node, stats);
        }
    };

    let mut subdirs: Vec<(std::path::PathBuf, String)> = Vec::new();
    let mut local_files: u64 = 0;
    let mut local_bytes: u64 = 0;

    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                progress.errors.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };

        if is_reparse_point(&meta) {
            continue;
        }

        if meta.is_dir() {
            let child_name = entry.file_name().to_string_lossy().into_owned();
            subdirs.push((entry.path(), child_name));
        } else if meta.is_file() {
            let size = meta.len();
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let cat = hint.unwrap_or_else(|| classify_ext(&extension_of(&file_name)));
            stats.add(cat, size);
            local_files += 1;
            local_bytes += size;
        }
    }

    node.files += local_files;
    node.size += local_bytes;
    progress.files.fetch_add(local_files, Ordering::Relaxed);
    progress.bytes.fetch_add(local_bytes, Ordering::Relaxed);
    progress.dirs.fetch_add(subdirs.len() as u64, Ordering::Relaxed);

    // 하위 디렉터리를 병렬로 내려간다. rayon의 작업 훔치기가 중첩 호출을 알아서 편다.
    let results: Vec<(Node, Stats)> = subdirs
        .par_iter()
        .map(|(child_path, child_name)| {
            let child_hint = hint_from_dir(child_name, hint);
            scan_dir(child_path, child_hint, progress)
        })
        .collect();

    for (child_node, child_stats) in results {
        node.size += child_node.size;
        node.files += child_node.files;
        stats.merge(&child_stats);
        node.children.push(child_node);
    }

    // 큰 것부터. 가지치기와 화면 표시 모두 이 순서를 전제한다.
    node.children.sort_unstable_by(|a, b| b.size.cmp(&a.size));

    (node, stats)
}

/// 트리를 화면에 실을 만한 크기로 줄인다.
///
/// 전체를 그대로 직렬화하면 드라이브 하나에 수십만 노드가 나와 IPC에서 막힌다.
/// 눈에 보이지도 않을 작은 노드를 버리되, 버린 개수는 남겨 사용자가 알 수 있게 한다.
fn prune(node: &mut Node, min_size: u64, depth: u32, max_depth: u32, max_children: usize) {
    if depth >= max_depth {
        node.truncated = node.children.len() as u32;
        node.children.clear();
        return;
    }

    let before = node.children.len();
    node.children.retain(|c| c.size >= min_size);
    if node.children.len() > max_children {
        node.children.truncate(max_children);
    }
    node.truncated = (before - node.children.len()) as u32;

    for child in node.children.iter_mut() {
        prune(child, min_size, depth + 1, max_depth, max_children);
    }
}

pub fn scan(root: &Path, progress: &Progress) -> ScanResult {
    let start = std::time::Instant::now();
    progress.reset();

    let root_hint = root
        .file_name()
        .and_then(|s| hint_from_dir(&s.to_string_lossy(), None));

    let (mut node, stats) = scan_dir(root, root_hint, progress);

    // 드라이브 루트는 `file_name()`이 비어 `C:\` 같은 표시가 사라진다. 되살려 준다.
    if node.name.is_empty() {
        node.name = root.to_string_lossy().into_owned();
    }

    let total_size = node.size;
    // 전체의 0.05% 미만은 버린다. 100GB 스캔이면 50MB가 경계선이 된다.
    let min_size = (total_size / 2000).max(1);
    prune(&mut node, min_size, 0, 12, 80);

    let mut categories: Vec<CategoryStat> = ALL_CATEGORIES
        .iter()
        .map(|c| CategoryStat {
            key: c.key().to_string(),
            label: c.label().to_string(),
            size: stats.cats[c.index()].size,
            files: stats.cats[c.index()].files,
        })
        .filter(|s| s.files > 0)
        .collect();
    categories.sort_unstable_by(|a, b| b.size.cmp(&a.size));

    ScanResult {
        root: node,
        categories,
        total_size,
        total_files: progress.files.load(Ordering::Relaxed),
        total_dirs: progress.dirs.load(Ordering::Relaxed),
        errors: progress.errors.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        cancelled: progress.is_cancelled(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    /// 알려진 크기의 파일로 작은 트리를 만든다. 호출자가 정리 책임을 진다.
    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("discan_test_{}", name));
        let _ = fs::remove_dir_all(&root);

        let make = |path: &PathBuf, bytes: usize| {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut f = fs::File::create(path).unwrap();
            f.write_all(&vec![b'x'; bytes]).unwrap();
        };

        make(&root.join("movie.mp4"), 5000);
        make(&root.join("notes.pdf"), 1000);
        make(&root.join("src").join("main.rs"), 300);
        make(&root.join("src").join("util.rs"), 200);
        // node_modules 하위는 확장자와 무관하게 캐시로 잡혀야 한다.
        make(&root.join("node_modules").join("dep").join("index.js"), 700);

        root
    }

    #[test]
    fn aggregates_sizes_and_counts() {
        let root = fixture("agg");
        let progress = Progress::new();
        let result = scan(&root, &progress);

        assert_eq!(result.total_size, 7200);
        assert_eq!(result.total_files, 5);
        // src, node_modules, node_modules/dep
        assert_eq!(result.total_dirs, 3);
        assert_eq!(result.errors, 0);
        assert!(!result.cancelled);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn classifies_by_extension_and_directory_hint() {
        let root = fixture("classify");
        let progress = Progress::new();
        let result = scan(&root, &progress);

        let by_key = |key: &str| {
            result
                .categories
                .iter()
                .find(|c| c.key == key)
                .map(|c| c.size)
                .unwrap_or(0)
        };

        assert_eq!(by_key("video"), 5000);
        assert_eq!(by_key("document"), 1000);
        // .rs 두 개만 코드다. node_modules 의 .js 는 여기 포함되면 안 된다.
        assert_eq!(by_key("code"), 500);
        assert_eq!(by_key("cache"), 700);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extension_parsing_ignores_dotfiles() {
        assert_eq!(extension_of("archive.tar.GZ"), "gz");
        assert_eq!(extension_of(".gitignore"), "");
        assert_eq!(extension_of("Makefile"), "");
        assert_eq!(extension_of("trailing."), "");
    }
}
