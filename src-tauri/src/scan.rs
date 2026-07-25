//! 디렉터리 트리를 병렬로 순회하며 크기와 분야를 집계한다.

use rayon::prelude::*;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use crate::category::{
    classify_ext, hint_from_dir, is_conditional_cache_dir, Category, ALL_CATEGORIES, CATEGORY_COUNT,
};
use crate::dirent;

/// 클라우드 자리표시자 판정용 속성. 셋 중 하나라도 서 있으면 내용이 로컬에 없다.
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
/// NTFS 압축·희소 파일. 이 둘은 `AllocationSize` 가 실제 점유와 어긋날 수 있는
/// 유일한 갈래라, 얼마나 섞였는지를 결과에 실어 화면이 단정할 수 있는 만큼만
/// 단정하게 한다(정확한 값은 파일당 `GetCompressedFileSize` 가 필요해 너무 비싸다).
const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;

/// 순회 재귀 **사슬 하나**의 깊이 상한.
///
/// rayon 워커 스택은 기본 2MiB고 프레임 하나가 1~2KB다. 롱 패스가 켜진 시스템에서
/// 수천 단계 트리를 만나면 스택 오버플로로 프로세스가 언와인딩 없이 즉사한다 —
/// 수십 초짜리 스캔 결과가 통째로 사라지는 것보다 여기서 멈추고 신호를 남기는 편이 낫다.
///
/// 주의: 이 값은 **실제 스택 깊이의 상한이 아니다**. `scan_dir`은 `par_iter().collect()`
/// 안에서 자기를 다시 부르고, 그 collect 를 기다리는 워커는 무관한 작업을 훔쳐 같은
/// 스택 위에서 실행한다. 따라서 한 워커의 스택에는 서로 독립적인 사슬이 여러 개
/// 겹쳐 쌓일 수 있고 최악은 `훔친 횟수 × 이 상한`이다. 아래 스택 예약은 정확히
/// 그 겹침에 대한 여유분이지, 상한이 스택 안전을 '보장'하는 구조는 아니다.
/// 보장이 필요해지면 자식 디렉터리를 명시적 큐로 돌려 재귀 자체를 없애야 한다.
const MAX_SCAN_DEPTH: u32 = 128;

/// 순회 전용 워커 스택 크기.
///
/// rayon 기본값 2MiB로는 디버그 빌드 프레임(약 16KB) 기준 깊이 128을 버티지 못한다
/// — 상한을 두기 전에 스택부터 넉넉히 잡아야 상한이 실제로 발동한다.
/// 작업 훔치기로 사슬이 겹쳐 쌓이는 몫까지 여기서 흡수한다(위 주석 참조).
/// 가상 주소만 예약될 뿐 실제로 커밋되지는 않으므로 비용은 사실상 없다.
const SCAN_STACK_BYTES: usize = 32 * 1024 * 1024;

/// 디렉터리마다 트리에 남길 대용량 파일 노드 수.
/// '어느 폴더가 큰가'와 '어느 파일이 큰가'는 다른 질문이고, 후자가 정리의 실제 단위다.
const FILE_NODES_PER_DIR: usize = 10;

/// 전역 '가장 큰 파일' 목록 크기. 트리 전체를 파일까지 직렬화하는 것보다 훨씬 싸다.
const TOP_FILES: usize = 200;

/// 디렉터리 하나가 들고 갈 최대 파일 후보 수.
///
/// 전역 상위 목록 크기보다 작으면 안 된다 — 영화 200편이 한 폴더에 있을 때
/// 33번째부터는 전역 상위 200에 들 자격이 있어도 후보 단계에서 탈락해,
/// '상위 200'이라는 이름이 거짓이 된다. 전역 목록에 넘긴 직후 트리에 실을
/// 만큼만 남기므로(`FILE_NODES_PER_DIR`) 순회 중 메모리는 오히려 줄었다.
const FILE_CANDIDATES: usize = TOP_FILES;

/// 확장자 키 길이 상한. 실제 확장자 중 이보다 긴 것은 사실상 없다.
/// 파일명 끝에 해시·날짜를 붙이는 도구의 산출물이 통째로 키가 되는 것을 막는다.
const MAX_EXT_KEY_LEN: usize = 16;

/// 결과에 싣는 확장자 목록 길이. 나머지는 잔여 항목 한 줄로 접는다.
const EXT_LIST_LIMIT: usize = 30;

/// 확장자 맵 키 개수 상한. 다른 축(노드 수·실패 경로·파일 후보)에는 모두 상한이
/// 있는데 이 맵만 열려 있으면 자기-DoS 경로가 하나 남는다.
const MAX_EXT_KEYS: usize = 4096;

/// 상한을 넘긴 확장자를 접어 넣을 키. 잘라내는 대신 합계를 남겨야 목록이 100%를 설명한다.
///
/// 표시 문구가 아니라 **로케일 무관 센티널**이다. `ext` 열의 정의는 '점 없는 소문자
/// 확장자'이고, 여기에 한국어 문장을 실으면 CSV·JSON을 읽는 하류 스크립트가 잔여
/// 항목을 찾으려고 한국어 문자열을 하드코딩하게 된다 — 라벨을 다듬는 순간 그
/// 파이프라인이 조용히 깨진다. 분야 축(`Category::key()`)이 이미 안정 키와 표시
/// 라벨을 분리해 둔 것과 같은 규칙을 확장자 축에도 적용한다.
pub const EXT_OVERFLOW_KEY: &str = "__overflow";

/// 확장자가 없는 파일을 세는 키. 위와 같은 이유로 센티널이다.
pub const EXT_NONE_KEY: &str = "__none";

/// 순회 중 유지할 자식 노드 폭 상한. 최종 가지치기(80)보다 넉넉히 잡는다.
const IN_SCAN_MAX_CHILDREN: usize = 400;

/// 상대 임계 분모. 전체의 1/2000 미만은 화면에서 의미가 없다.
const SIZE_DIVISOR: u64 = 2000;

const MAX_DEPTH: u32 = 12;
const MAX_CHILDREN: usize = 80;

/// 파일 루프에서 취소를 확인하는 주기. 파일 수십만 개짜리 디렉터리 하나가
/// 중단 버튼을 먹어버리지 않도록 순회 도중에도 빠져나갈 구멍을 둔다.
#[cfg(not(test))]
const CANCEL_CHECK_INTERVAL: u64 = 4096;

/// 테스트에서는 주기를 낮춘다. 4,096개를 넘기는 픽스처를 만들지 않고도
/// **순회 도중** 취소되는 갈래(루프 중단·부분 집계)를 실제로 실행하기 위해서다 —
/// 진입부 가드만 통과하는 테스트는 사용자가 실제로 겪는 경로를 검증하지 않는다.
#[cfg(test)]
const CANCEL_CHECK_INTERVAL: u64 = 8;

/// 실패 경로 수집 상한. 목록이 무한히 자라면 그 자체가 메모리 문제다.
const MAX_FAILED_PATHS: usize = 500;

/// 하드 링크 판정 집합에 넣을 파일의 최소 크기(기본값).
///
/// 파일 100만 개를 전부 추적하면 키 집합만 수십 MB다. 하드 링크는 시스템 트리의
/// 중형 파일(WinSxS 의 구성요소 DLL·EXE)에 몰려 있으므로 하한을 두면 메모리는
/// 자릿수 단위로 줄고 잡아내는 중복은 거의 그대로다. 이 하한 미만에서 놓친 중복이
/// 있을 수 있다는 사실은 결과의 `dedupMinBytes` 로 함께 나간다 — 값이 결과에 없으면
/// 사용자는 '중복 제거했다'를 전량으로 오인한다.
///
/// 하한을 넘는 파일이 그래도 수백만 개인 대형 미디어·데이터 드라이브가 있으므로,
/// 색인 자체의 크기도 `MAX_IDS_PER_SHARD` 로 상한을 둔다(다른 모든 축과 같은
/// 자기-DoS 방어다). 이 하한과 그 상한이 함께 색인 메모리의 천장을 정한다.
pub const DEFAULT_HARDLINK_MIN_BYTES: u64 = 64 * 1024;

/// 하드 링크 판정 집합의 샤드 수.
///
/// 하한을 넘는 파일마다 집합을 두드리므로 단일 뮤텍스면 워커 수만큼 경합이 는다.
/// 파일 ID 하나가 잠그는 것이 자기 샤드뿐이면 그 경합이 사실상 사라진다.
const ID_SHARDS: usize = 32;

/// 하드 링크 판정 색인의 **샤드당** 상한.
///
/// 확장자 키·실패 경로·파일 후보·노드 수에는 모두 상한이 있는데 이 색인만 열려
/// 있으면 자기-DoS 경로가 하나 남는다(`DEFAULT_HARDLINK_MIN_BYTES` 가 규모를
/// 줄이긴 하지만, >하한 대형 파일이 수백만 개인 드라이브에서는 하드 링크가 거의
/// 없어도 항목당 십수 바이트가 파일 수에 비례해 쌓인다).
///
/// 상한에 닿으면 **새 실체를 더 추적하지 않고 '처음 본 것'으로 취급한다** — 이미
/// 추적 중인 실체의 중복 제거는 그대로 동작하고(중복은 계속 걸린다), 상한 이후의
/// 새 파일만 과다 계수(하한 미만 구간과 같은 알려진 방향)로 떨어질 뿐 **없는 용량을
/// 지우지는 않는다**. 잘못된 중복 제거가 조용한 누락보다 나쁘다는 이 파일의 원칙과
/// 같은 방향이다.
///
/// `ID_SHARDS × 이 값 × 항목 하나(≈16~20바이트)`가 색인 메모리의 천장이다
/// (32 × 131,072 ≈ 419만 항목, ~80MB). 실제 하드 링크 집합(WinSxS 등)은 수만 규모라
/// 이 상한은 정상 스캔의 중복 제거 정확도에 닿지 않는다.
const MAX_IDS_PER_SHARD: usize = 1 << 17;

#[derive(Serialize, Clone)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub files: u64,
    /// 파일 노드면 false. 트리에 파일이 섞이므로 이 필드는 더 이상 항상 참이 아니다.
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Vec<Node>,
    /// 화면에서 생략된 자식 수 합계. 0이면 이 노드의 자식이 모두 보인다.
    pub truncated: u32,
    /// 생략된 자식들의 합계 크기. 부모 용량과 보이는 자식 합의 차액을 설명한다.
    #[serde(rename = "truncatedBytes")]
    pub truncated_bytes: u64,
    #[serde(rename = "truncatedSmall")]
    pub truncated_small: u32,
    #[serde(rename = "truncatedCapped")]
    pub truncated_capped: u32,
    #[serde(rename = "truncatedDeep")]
    pub truncated_deep: u32,
    /// 사유별 생략 바이트. 합계 하나만 보내면 사유가 둘 이상인 노드
    /// (파일 5,000개 + 하위 폴더 300개짜리 디렉터리는 표시 한도와 비중 과소에
    /// **동시에** 걸린다 — 예외가 아니라 표준적인 경우다)에서 화면은 어느 줄에
    /// 바이트를 붙일지 정하지 못해 아예 그리지 못한다. 노드당 24바이트로
    /// "생략한 것은 개수·크기·사유를 남긴다"는 불변식을 되살린다.
    #[serde(rename = "truncatedBytesSmall")]
    pub truncated_bytes_small: u64,
    #[serde(rename = "truncatedBytesCapped")]
    pub truncated_bytes_capped: u64,
    #[serde(rename = "truncatedBytesDeep")]
    pub truncated_bytes_deep: u64,
    /// 생략 사유 중 사용자를 가장 크게 오도할 수 있는 하나.
    /// `"depth"` | `"count"` | `"size"`. 깊이 절단을 '비중 과소'로 적으면 거짓말이 된다.
    #[serde(rename = "truncatedReason")]
    pub truncated_reason: Option<&'static str>,
    /// 취소·오류·깊이 상한으로 하위 집계가 끝나지 못한 노드. 표시 용량은 하한값이다.
    pub incomplete: bool,
    /// 이 경로가 유니코드로 온전히 표현되지 않아 표시 문자열이 **원본과 다르다**.
    ///
    /// NTFS 파일 이름은 UTF-16 이지만 짝 없는 서로게이트를 담은 이름을 만들 수 있고,
    /// 그때 `to_string_lossy` 는 U+FFFD 로 치환한다. 그 문자열로 '탐색기에서 열기'나
    /// '경로 복사'를 하면 실재하지 않는 경로가 나가 조용히 실패한다 — 표시용 손실과
    /// 조작용 손실을 같은 문자열이 겸하는 것이 문제이므로, 사실을 실어 보내
    /// 프런트가 실패가 예정된 어포던스를 주지 않게 한다.
    #[serde(rename = "lossyPath")]
    pub lossy_path: bool,
    /// 파일 노드의 분야 키(`classify_ext` 기준). 디렉터리는 `None`.
    /// 트리맵이 타일을 분야 색으로 칠할 때 쓴다 — 이미 분류 중이라 비용이 없다.
    #[serde(rename = "category", skip_serializing_if = "Option::is_none")]
    pub category: Option<&'static str>,
}

impl Node {
    fn dir(name: String, path: String) -> Node {
        Node {
            name,
            path,
            size: 0,
            files: 0,
            is_dir: true,
            children: Vec::new(),
            truncated: 0,
            truncated_bytes: 0,
            truncated_small: 0,
            truncated_capped: 0,
            truncated_deep: 0,
            truncated_bytes_small: 0,
            truncated_bytes_capped: 0,
            truncated_bytes_deep: 0,
            truncated_reason: None,
            incomplete: false,
            lossy_path: false,
            category: None,
        }
    }

    fn file(
        name: String,
        path: String,
        size: u64,
        lossy_path: bool,
        category: &'static str,
    ) -> Node {
        Node {
            name,
            path,
            size,
            files: 1,
            is_dir: false,
            lossy_path,
            category: Some(category),
            ..Node::dir(String::new(), String::new())
        }
    }
}

/// 생략 사유를 기록한다. 사유가 겹치면 오도 위험이 큰 쪽으로 승격한다 —
/// 깊이 절단(큰 폴더가 숨을 수 있다) > 표시 한도 > 비중 과소.
fn note_truncated(node: &mut Node, reason: &'static str, count: u32, bytes: u64) {
    if count == 0 {
        return;
    }
    node.truncated += count;
    node.truncated_bytes += bytes;
    match reason {
        "depth" => {
            node.truncated_deep += count;
            node.truncated_bytes_deep += bytes;
        }
        "count" => {
            node.truncated_capped += count;
            node.truncated_bytes_capped += bytes;
        }
        _ => {
            node.truncated_small += count;
            node.truncated_bytes_small += bytes;
        }
    }
    let rank = |r: Option<&str>| match r {
        Some("depth") => 3,
        Some("count") => 2,
        Some("size") => 1,
        _ => 0,
    };
    if rank(Some(reason)) > rank(node.truncated_reason) {
        node.truncated_reason = Some(reason);
    }
}

#[derive(Serialize, Clone)]
pub struct CategoryStat {
    pub key: String,
    pub label: String,
    /// 색까지 백엔드가 실어 보낸다. 프런트에 매핑표를 두면 분야를 추가할 때
    /// 색만 조용히 빠져 '기타'와 같은 회색으로 떨어진다.
    pub color: &'static str,
    pub size: u64,
    pub files: u64,
}

#[derive(Serialize, Clone)]
pub struct ExtStat {
    /// 점 없는 소문자 확장자, 또는 `EXT_NONE_KEY`·`EXT_OVERFLOW_KEY` 센티널.
    pub ext: String,
    pub size: u64,
    pub files: u64,
    /// 이 확장자가 떨어지는 분야 키(`classify_ext` 기준, 디렉터리 힌트 미적용).
    ///
    /// 확장자 축이 전역 집계뿐이면 '기타 1.65GiB'를 눌러도 무엇으로 채워졌는지
    /// 되돌아볼 경로가 없다. 분야×확장자 교차는 이미 분류기가 아는 정보라
    /// 필드 하나로 공짜다. 센티널 키는 `other` 로 싣는다.
    pub category: &'static str,
    /// 이 행이 대표하는 **서로 다른 확장자 종수**. 보통은 1이고, 잔여 항목
    /// (`__overflow`) 행에서만 접어 넣은 종수가 된다.
    ///
    /// 종수가 없으면 '그 밖의 확장자 1.5GiB' 한 줄이 소수의 대형 파일인지 롱테일인지
    /// 구분되지 않아, 분해하려던 사용자가 같은 자리에서 다시 막힌다.
    pub kinds: u64,
}

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// 분야 키. 목록을 분야별로 색칠하거나 걸러낼 때 쓴다.
    pub category: &'static str,
    /// 표시 경로가 원본과 다르다(`Node::lossy_path` 와 같은 의미).
    #[serde(rename = "lossyPath")]
    pub lossy_path: bool,
}

#[derive(Serialize, Clone)]
pub struct FailedPath {
    pub path: String,
    /// `"denied"` | `"notFound"` | `"tooLong"` | `"tooDeep"` | `"notReady"`
    /// | `"locked"` | `"other"`.
    /// 경로 길이 초과를 '권한 문제'로 안내하면 사용자는 엉뚱한 곳을 뒤진다.
    /// 갈래를 늘릴 때는 types.ts 의 `FailedKind` 유니온과 notice.ts 의
    /// `FAILED_KIND_LABELS`/`FAILED_KIND_HINTS`를 함께 갱신해야 한다.
    pub kind: &'static str,
}

#[derive(Serialize, Clone)]
pub struct PruneParams {
    #[serde(rename = "minSize")]
    pub min_size: u64,
    #[serde(rename = "maxDepth")]
    pub max_depth: u32,
    #[serde(rename = "maxChildren")]
    pub max_children: usize,
}

#[derive(Serialize, Clone)]
pub struct ScanResult {
    pub root: Node,
    /// 디렉터리 힌트가 적용된 분류. 화면의 기본 축이다.
    pub categories: Vec<CategoryStat>,
    /// 힌트를 무시한 순수 확장자 기반 분류. '캐시 7GB'의 내부 구성을 보여준다.
    #[serde(rename = "contentCategories")]
    pub content_categories: Vec<CategoryStat>,
    /// 용량 상위 확장자(전역).
    pub extensions: Vec<ExtStat>,
    /// **분야가 `other` 인 확장자만** 따로 뽑은 상위 목록.
    ///
    /// 전역 상위 30개만 실으면 '기타'를 분해할 수 없다. 미분류가 큰 디스크의
    /// 전형적 구성은 '중간 크기 확장자 수백 종의 롱테일'이라 개별 확장자가 전역
    /// 상위 30에 하나도 들지 못하고, 사용자는 '기타 1.65GiB → 그 밖의 확장자
    /// 1.5GiB' 라는 동어반복에 도달한다. 분류표를 개선할 피드백 루프도 여기서 끊긴다.
    #[serde(rename = "otherExtensions")]
    pub other_extensions: Vec<ExtStat>,
    #[serde(rename = "largestFiles")]
    pub largest_files: Vec<FileEntry>,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    #[serde(rename = "totalFiles")]
    pub total_files: u64,
    #[serde(rename = "totalDirs")]
    pub total_dirs: u64,
    /// `dir_errors + file_errors`. 결과가 과소 집계됐다는 사용자 대상 신호다.
    pub errors: u64,
    /// 디렉터리 단위 실패. 하나당 서브트리가 통째로 빠진다.
    #[serde(rename = "dirErrors")]
    pub dir_errors: u64,
    /// 파일 하나 단위 실패.
    #[serde(rename = "fileErrors")]
    pub file_errors: u64,
    #[serde(rename = "failedPaths")]
    pub failed_paths: Vec<FailedPath>,
    /// 기록을 시도한 실패 **건수**. 같은 (경로, 갈래)가 여러 번 나면 목록에는 한 줄만
    /// 남으므로 `failed_paths.len()`보다 클 수 있다 — 규모는 이 값이, 목록이 잘렸는지는
    /// `failed_paths_truncated`가 답한다. 잘린 목록을 전량으로 오인하면 감사 결론이 뒤집힌다.
    #[serde(rename = "failedPathsTotal")]
    pub failed_paths_total: u64,
    #[serde(rename = "failedPathsTruncated")]
    pub failed_paths_truncated: bool,
    /// 순환·중복 계수를 피해 건너뛴 정션·심볼릭 링크 수.
    #[serde(rename = "skippedLinks")]
    pub skipped_links: u64,
    /// 로컬에 내용이 없는 클라우드 자리표시자 수와 그 논리 크기.
    #[serde(rename = "skippedCloud")]
    pub skipped_cloud: u64,
    #[serde(rename = "skippedCloudBytes")]
    pub skipped_cloud_bytes: u64,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
    /// 사용자가 중단시킨 결과인지. true면 부분 집계다.
    pub cancelled: bool,
    #[serde(rename = "rootPath")]
    pub root_path: String,
    /// 스냅샷 시각(RFC3339, UTC). 결과를 나중에 제시할 때 소명 근거가 된다.
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "appVersion")]
    pub app_version: &'static str,
    /// 집계 기준. 지금은 논리 크기뿐이라 화면에 그렇게 고지해야 한다.
    #[serde(rename = "sizeBasis")]
    pub size_basis: &'static str,
    /// 중복 제거 수준. `"hardlink"` | `"none"`.
    ///
    /// `"hardlink"`이면 (볼륨 시리얼, 파일 ID)가 같은 두 번째 이후 항목의 크기를
    /// 0으로 계산했다(개수는 센다 — 존재는 하니까). `"none"`이면 하드 링크로 공유된
    /// 파일이 링크 수만큼 계수되어 `C:\Windows\WinSxS` 같은 시스템 트리가 실제
    /// 점유보다 크게 나온다. 어느 쪽인지를 결과에 실어야 내보낸 CSV·JSON만 보고도
    /// 탐색기 값과 어긋나는 이유를 판정할 수 있다.
    pub dedup: &'static str,
    /// `dedup == "none"` 인 이유. `""` | `"unstableFileIds"` | `"unsupportedPlatform"`.
    ///
    /// FAT32·exFAT 은 파일 ID 가 안정적이지 않아 중복 제거를 끈다 — 껐다는 사실만
    /// 남기고 이유를 남기지 않으면 사용자는 그것을 버그로 읽는다.
    #[serde(rename = "dedupDisabledReason")]
    pub dedup_disabled_reason: &'static str,
    /// 하드 링크 추적 하한(바이트). 이 값 미만인 파일은 판정 집합에 넣지 않으므로
    /// 그 구간의 중복은 잡히지 않는다. 0이면 전부 추적했다는 뜻이다.
    #[serde(rename = "dedupMinBytes")]
    pub dedup_min_bytes: u64,
    /// 하드 링크 중복으로 판정되어 크기를 0으로 계산한 파일 수와 그 논리 바이트.
    /// "왜 탐색기와 숫자가 다른가"에 정량으로 답하는 유일한 축이다.
    #[serde(rename = "hardlinkDedupedFiles")]
    pub hardlink_deduped_files: u64,
    #[serde(rename = "hardlinkDedupedBytes")]
    pub hardlink_deduped_bytes: u64,
    /// 할당 크기를 단정할 수 없는 파일 수와 그 할당 바이트(NTFS 압축·희소 파일).
    ///
    /// 정확한 점유는 파일당 `GetCompressedFileSize` 가 필요해 열거 한 번으로는 얻지
    /// 못한다. 그래서 '얼마나 섞였는가'를 실어, 화면이 단정할 수 있는 만큼만
    /// 단정하게 한다 — 0이면 `allocatedEstimate` 는 그대로 믿어도 되는 값이다.
    #[serde(rename = "allocUncertainFiles")]
    pub alloc_uncertain_files: u64,
    #[serde(rename = "allocUncertainBytes")]
    pub alloc_uncertain_bytes: u64,
    /// 볼륨 클러스터 크기. 0이면 미상. 호출자(lib.rs)가 채운다.
    #[serde(rename = "clusterBytes")]
    pub cluster_bytes: u64,
    #[serde(rename = "fileSystem")]
    pub file_system: String,
    #[serde(rename = "volumeSerial")]
    pub volume_serial: String,
    /// 디스크 점유량. 산출 방식은 `alloc_basis`가 말한다.
    #[serde(rename = "allocatedEstimate")]
    pub allocated_estimate: u64,
    /// 위 값의 산출 방식. `"allocationSize"` | `"clusterRoundUp"` | `"unknown"`.
    ///
    /// `"allocationSize"`는 파일시스템이 항목마다 보고한 실제 할당 바이트를 그대로
    /// 누적한 값이다(디렉터리 열거가 함께 돌려주므로 추가 I/O 가 없다). MFT 상주
    /// 파일과 클러스터 슬랙까지 파일시스템의 셈을 그대로 따르므로 근사가 아니다 —
    /// 다만 NTFS 압축·희소 파일은 여전히 어긋날 수 있고, 그 규모는
    /// `allocUncertainFiles`/`allocUncertainBytes`가 말한다.
    ///
    /// `"clusterRoundUp"`은 파일마다 `ceil(size/cluster) * cluster`를 누적한 폴백이다.
    /// 디렉터리 자체가 쓰는 공간, NTFS 압축·희소 파일, MFT 상주 파일, 볼륨 중복
    /// 제거를 **반영하지 않아** 그런 트리에서는 실제보다 크게 나온다.
    #[serde(rename = "allocBasis")]
    pub alloc_basis: &'static str,
    /// 상승된(관리자) 토큰으로 스캔했는지. Windows 밖에서는 항상 false.
    ///
    /// 같은 볼륨도 권한에 따라 접근 거부 건수와 총량이 GB 단위로 달라진다.
    /// 화면은 '관리자 권한으로 다시 실행하면 보입니다'라고 안내하면서 정작
    /// 이번 결과가 어느 권한으로 찍혔는지는 남기지 않았다 — 두 스냅샷의 차이를
    /// 소명할 1차 설명 변수라 결과·내보내기에 함께 싣는다.
    pub elevated: bool,
    #[serde(rename = "pruneParams")]
    pub prune_params: PruneParams,
    /// 이 결과를 만든 스캔의 세대 번호. 취소 명령이 대상을 지목할 때 쓴다.
    #[serde(rename = "scanId")]
    pub scan_id: u64,
}

#[derive(Clone, Copy, Default)]
struct CatAcc {
    size: u64,
    files: u64,
}

#[derive(Clone, Copy)]
struct Stats {
    /// 힌트 적용 분류.
    cats: [CatAcc; CATEGORY_COUNT],
    /// 확장자만 본 분류.
    content: [CatAcc; CATEGORY_COUNT],
    /// 실제로 내려간 디렉터리 수. 공유 카운터가 아니라 트리에서 산출해야
    /// 동시 스캔이 섞여도 자기 결과만 보고하게 된다.
    dirs: u64,
}

impl Default for Stats {
    fn default() -> Self {
        Stats {
            cats: [CatAcc::default(); CATEGORY_COUNT],
            content: [CatAcc::default(); CATEGORY_COUNT],
            dirs: 0,
        }
    }
}

impl Stats {
    fn add(&mut self, cat: Category, content: Category, size: u64) {
        let slot = &mut self.cats[cat.index()];
        slot.size += size;
        slot.files += 1;
        let slot = &mut self.content[content.index()];
        slot.size += size;
        slot.files += 1;
    }

    fn merge(&mut self, other: &Stats) {
        for i in 0..CATEGORY_COUNT {
            self.cats[i].size += other.cats[i].size;
            self.cats[i].files += other.cats[i].files;
            self.content[i].size += other.content[i].size;
            self.content[i].files += other.content[i].files;
        }
        self.dirs += other.dirs;
    }
}

/// 스캔 진행 중 공유되는 카운터. 진행률 표시와 취소에 쓴다.
pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub dir_errors: AtomicU64,
    pub file_errors: AtomicU64,
    pub skipped_links: AtomicU64,
    pub skipped_cloud: AtomicU64,
    pub skipped_cloud_bytes: AtomicU64,
    pub cancel: AtomicBool,
    /// 지금 읽고 있는 디렉터리. 진행 표시가 멈춘 것처럼 보일 때 어디서 막혔는지 알려준다.
    pub current: Mutex<String>,
    /// 테스트 전용 seam. 0이 아니면 `is_cancelled`가 이 횟수만큼 불린 뒤 스스로
    /// 취소를 세운다.
    ///
    /// '순회 도중 취소'는 스레드 두 개의 타이밍에 의존해서는 결정적으로 재현되지
    /// 않는다(스캔이 먼저 끝나면 테스트가 조용히 통과한다 — 없는 테스트보다 나쁘다).
    /// 확인 횟수를 세면 루프 중단 지점과 그때의 부분 집계를 정확히 같은 자리에서
    /// 반복 실행할 수 있다. 실제 빌드에는 이 필드가 존재하지 않는다.
    #[cfg(test)]
    cancel_after_checks: AtomicU64,
    #[cfg(test)]
    checks: AtomicU64,
}

impl Progress {
    pub fn new() -> Self {
        Progress {
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            dir_errors: AtomicU64::new(0),
            file_errors: AtomicU64::new(0),
            skipped_links: AtomicU64::new(0),
            skipped_cloud: AtomicU64::new(0),
            skipped_cloud_bytes: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
            current: Mutex::new(String::new()),
            #[cfg(test)]
            cancel_after_checks: AtomicU64::new(0),
            #[cfg(test)]
            checks: AtomicU64::new(0),
        }
    }

    /// 취소 확인이 `n`번 일어난 시점에 취소를 세운다(테스트 전용).
    #[cfg(test)]
    fn cancel_after(&self, n: u64) {
        self.cancel_after_checks.store(n, Ordering::Relaxed);
    }

    pub fn errors(&self) -> u64 {
        self.dir_errors.load(Ordering::Relaxed) + self.file_errors.load(Ordering::Relaxed)
    }

    pub fn current_path(&self) -> String {
        self.current
            .lock()
            .map(|c| c.clone())
            .unwrap_or_else(|_| String::new())
    }

    fn is_cancelled(&self) -> bool {
        #[cfg(test)]
        {
            let after = self.cancel_after_checks.load(Ordering::Relaxed);
            if after > 0 && self.checks.fetch_add(1, Ordering::Relaxed) + 1 >= after {
                self.cancel.store(true, Ordering::Relaxed);
            }
        }
        self.cancel.load(Ordering::Relaxed)
    }
}

/// (크기, 경로, 이름, 분야 키, 경로 손실 여부). 크기가 앞이라 튜플 비교가 곧 크기 비교다.
type FileCand = (u64, String, String, &'static str, bool);

/// 실패 목록과 중복 판정 색인.
///
/// 엔트리 순회 실패는 실패한 항목이 아니라 **부모 디렉터리 경로**로 기록된다
/// (`DirEntry`를 얻지 못해 항목 이름을 알 수 없다). 한 디렉터리에서 그 오류가
/// 여러 번 나면 같은 (경로, 갈래)가 목록을 가득 채워 상한 500건이 반복으로 소진되고,
/// 화면에서도 같은 줄이 되풀이된다. 같은 조합은 한 줄로 접는다 — 총수는
/// `failed_total`이 따로 세므로 접어도 규모 정보는 잃지 않는다.
#[derive(Default)]
struct FailedList {
    list: Vec<FailedPath>,
    seen: std::collections::HashSet<(String, &'static str)>,
}

/// 순회 한 번에 걸쳐 공유되는 수집기. `Progress`와 달리 결과를 만들고 나면 버린다.
struct ScanCtx<'a> {
    progress: &'a Progress,
    top: Mutex<BinaryHeap<Reverse<FileCand>>>,
    /// 상위 목록의 현재 하한. 이 값 이하 파일은 락을 잡지 않고 버린다.
    top_floor: AtomicU64,
    exts: Mutex<HashMap<String, (u64, u64)>>,
    failed: Mutex<FailedList>,
    /// 목록 상한·중복 접기와 무관하게 센 실패 총수. 규모를 잃지 않기 위한 축이다.
    failed_total: AtomicU64,
    /// 상한에 걸려 **실제로 버린** 실패가 있었는지.
    ///
    /// 예전처럼 `총수 > 목록 길이`로 판정하면 중복을 접은 것만으로도 '목록이 잘렸다'가
    /// 되어, 전량이 실린 결과를 사용자가 부분 목록으로 오인한다.
    failed_dropped: AtomicBool,
    /// 볼륨 클러스터 크기. 0이면 미상이고 할당 누적을 생략한다.
    cluster: u64,
    /// 검증 시점의 루트 신원. `None`이면 대조를 생략한다.
    root_identity: Option<FileIdentity>,
    /// 파일시스템이 보고한 할당 바이트(없으면 클러스터 올림)를 누적한 디스크 점유량.
    allocated: AtomicU64,
    /// 하드 링크 중복 제거를 켤지. 파일시스템이 안정적인 ID를 주지 않으면 꺼진다.
    dedup_hardlinks: bool,
    /// 판정 집합에 넣을 최소 크기. 이 값 미만은 추적하지 않는다.
    hardlink_min_bytes: u64,
    /// 하드 링크 판정 키의 앞쪽 절반. 순회는 재해석 지점을 넘지 않으므로 스캔
    /// 하나가 보는 볼륨은 하나뿐이지만, 키에 함께 실어 그 전제를 코드로 남긴다.
    volume_serial: u32,
    /// 이미 계산에 넣은 (볼륨 시리얼, 파일 ID). 샤딩 이유는 `ID_SHARDS` 주석 참조.
    seen_ids: [Mutex<HashSet<(u32, u64)>>; ID_SHARDS],
    /// 중복으로 판정해 크기를 0으로 돌린 파일 수와 그 논리 바이트.
    deduped_files: AtomicU64,
    deduped_bytes: AtomicU64,
    /// NTFS 압축·희소 파일 수와 그 할당 바이트.
    alloc_uncertain_files: AtomicU64,
    alloc_uncertain_bytes: AtomicU64,
}

impl<'a> ScanCtx<'a> {
    fn new(progress: &'a Progress, options: &ScanOptions) -> Self {
        ScanCtx {
            progress,
            top: Mutex::new(BinaryHeap::new()),
            top_floor: AtomicU64::new(0),
            exts: Mutex::new(HashMap::new()),
            failed: Mutex::new(FailedList::default()),
            failed_total: AtomicU64::new(0),
            failed_dropped: AtomicBool::new(false),
            cluster: options.cluster_bytes,
            root_identity: options.root_identity,
            allocated: AtomicU64::new(0),
            dedup_hardlinks: dedup_disabled_reason(&options.file_system).is_empty(),
            hardlink_min_bytes: options.hardlink_min_bytes,
            volume_serial: options.volume_serial_num,
            seen_ids: std::array::from_fn(|_| Mutex::new(HashSet::new())),
            deduped_files: AtomicU64::new(0),
            deduped_bytes: AtomicU64::new(0),
            alloc_uncertain_files: AtomicU64::new(0),
            alloc_uncertain_bytes: AtomicU64::new(0),
        }
    }

    /// 이 파일 실체를 **처음** 보는지. 처음이면 true 를 돌리고 집합에 남긴다.
    ///
    /// 오염된 락에서도 복구한다. 여기서 조용히 반환하면 같은 실체가 두 번 계수되어
    /// 결과가 `dedup="hardlink"` 라고 말하면서 실제로는 중복 제거가 안 된 값이 된다.
    fn mark_file_id(&self, id: u64) -> bool {
        let shard = (id as usize) % ID_SHARDS;
        let mut set = self.seen_ids[shard]
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let key = (self.volume_serial, id);
        // 상한 미만이면 평소처럼 삽입 결과가 곧 '처음 봤는가'다.
        if set.len() < MAX_IDS_PER_SHARD {
            return set.insert(key);
        }
        // 상한에 닿은 뒤에는 새 실체를 담지 않는다(`MAX_IDS_PER_SHARD` 주석 참조).
        // 이미 담긴 실체의 중복 판정은 유지하되(present → false → 중복 제거), 새 실체는
        // '처음 본 것'(true)으로 돌려 과다 계수 쪽으로 떨어뜨린다 — 없는 용량을
        // 지우는 것보다 낫고, 색인은 더 자라지 않는다.
        !set.contains(&key)
    }

    /// 디렉터리 하나가 모은 할당 바이트를 합친다(파일마다 원자 연산을 하면
    /// 수십만 파일짜리 트리에서 그 자체가 경합이 된다).
    fn add_allocated(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        self.allocated.fetch_add(bytes, Ordering::Relaxed);
    }

    /// 파일 하나가 실제로 차지하는 클러스터 바이트. 클러스터를 모르면 0을 돌려
    /// 누적을 통째로 생략한다 — 0을 '점유 없음'으로 오해하는 것보다
    /// `alloc_basis="unknown"`으로 미상임을 밝히는 편이 정직하다.
    fn allocated_of(&self, size: u64) -> u64 {
        if self.cluster == 0 {
            0
        } else {
            size.div_ceil(self.cluster) * self.cluster
        }
    }

    fn record_failure(&self, path: &Path, kind: &'static str) {
        self.failed_total.fetch_add(1, Ordering::Relaxed);
        // 오염된 락에서 조용히 반환하면 실패 한 건이 아무 신호 없이 사라진다.
        // lib.rs 가 같은 상황에서 `into_inner()` 로 복구하므로 정책을 맞춘다 —
        // 두 파일이 서로 다른 정책을 쓰면 다음 사람이 어느 쪽이 계약인지 알 수 없다.
        let mut failed = self.failed.lock().unwrap_or_else(|e| e.into_inner());
        let key = (path.to_string_lossy().into_owned(), kind);
        // 중복 판정이 **상한 검사보다 앞**이다. 순서가 뒤집히면 목록이 500건으로 찬
        // 뒤 도착한 실패가 이미 목록에 있는 조합이어도 '상한에 걸려 버렸다'로 기록되어,
        // 없는 손실을 보고하게 된다 — `failed_dropped`는 정확히 그 오인을 막으려고
        // 도입한 필드다. 이미 본 조합은 접어도 정보 손실이 없다(총수는 위에서 셌다).
        if failed.seen.contains(&key) {
            return;
        }
        if failed.list.len() >= MAX_FAILED_PATHS {
            self.failed_dropped.store(true, Ordering::Relaxed);
            return;
        }
        // 상한을 넘긴 **새** 키는 집합에도 남기지 않는다. 남기면 `seen`이 목록과
        // 무관하게 자라 그 자체가 메모리 축이 된다 — 목록에 실린 것만 기억하면 충분하다.
        failed.seen.insert(key.clone());
        failed.list.push(FailedPath {
            path: key.0,
            kind: key.1,
        });
    }

    fn offer_files(&self, candidates: &[FileCand]) {
        let floor = self.top_floor.load(Ordering::Relaxed);
        if candidates.iter().all(|c| c.0 <= floor) {
            return;
        }
        // 오염돼도 복구한다. 조용히 반환하면 상위 파일 한 묶음이 결과 어디에도
        // 흔적을 남기지 않고 사라진다.
        let mut heap = self.top.lock().unwrap_or_else(|e| e.into_inner());
        for cand in candidates {
            if heap.len() >= TOP_FILES {
                match heap.peek() {
                    Some(Reverse((min, ..))) if *min >= cand.0 => continue,
                    _ => {
                        heap.pop();
                    }
                }
            }
            heap.push(Reverse(cand.clone()));
        }
        if heap.len() >= TOP_FILES {
            if let Some(Reverse((min, ..))) = heap.peek() {
                self.top_floor.store(*min, Ordering::Relaxed);
            }
        }
    }

    fn merge_exts(&self, local: HashMap<String, (u64, u64)>) {
        if local.is_empty() {
            return;
        }
        // 오염돼도 복구한다. 조용히 반환하면 확장자 집계 한 디렉터리 분이
        // 결과에 아무 흔적 없이 사라진다.
        let mut map = self.exts.lock().unwrap_or_else(|e| e.into_inner());
        for (ext, (size, files)) in local {
            bump_ext(&mut map, &ext, size, files);
        }
    }

    /// 하드 링크 중복 판정. 계산에 넣을 크기를 돌려준다(중복이면 0).
    ///
    /// 개수는 호출자가 그대로 센다 — 항목은 실재하므로 '파일 0개'로 만들면
    /// 디렉터리에 무엇이 들었는지가 사라진다.
    fn charge_size(&self, size: u64, file_id: Option<u64>) -> u64 {
        if !self.dedup_hardlinks || size < self.hardlink_min_bytes {
            return size;
        }
        let Some(id) = file_id else {
            return size;
        };
        if self.mark_file_id(id) {
            return size;
        }
        self.deduped_files.fetch_add(1, Ordering::Relaxed);
        self.deduped_bytes.fetch_add(size, Ordering::Relaxed);
        0
    }
}

/// 확장자 맵에 합산한다. 키가 상한에 닿으면 새 키를 만드는 대신 잔여 항목으로 접는다 —
/// 버리면 합계가 100%를 설명하지 못하고, 그냥 두면 맵이 파일 수만큼 자란다.
fn bump_ext(map: &mut HashMap<String, (u64, u64)>, ext: &str, size: u64, files: u64) {
    let key: &str = if map.len() >= MAX_EXT_KEYS && !map.contains_key(ext) {
        EXT_OVERFLOW_KEY
    } else {
        ext
    };
    if let Some(slot) = map.get_mut(key) {
        slot.0 += size;
        slot.1 += files;
    } else {
        map.insert(key.to_string(), (size, files));
    }
}

/// 하드 링크 중복 제거를 끌 이유. 빈 문자열이면 켠다.
///
/// FAT32·exFAT 은 파일 ID가 안정적이지 않아 서로 다른 파일이 같은 ID로 보일 수
/// 있다 — 그 위에서 중복 제거를 켜면 실재하는 용량이 조용히 사라진다.
/// 파일시스템 이름을 못 읽었을 때(빈 문자열)도 끈다: 과다 계수는 지금까지의
/// 알려진 한계지만, 잘못된 중복 제거는 **없는 사실을 단정하는 것**이라 더 나쁘다.
fn dedup_disabled_reason(file_system: &str) -> &'static str {
    if !cfg!(windows) {
        // 디렉터리 열거가 파일 ID를 주지 않는 플랫폼.
        return "unsupportedPlatform";
    }
    match file_system.to_ascii_uppercase().as_str() {
        "NTFS" | "REFS" => "",
        _ => "unstableFileIds",
    }
}

/// 내용이 로컬에 없는 클라우드 자리표시자인지를 속성 비트만으로 판정한다.
///
/// 디렉터리 열거가 속성을 함께 돌려주므로 추가 I/O가 없다. 이 판정은 '이 파일의
/// 바이트를 총계에서 뺀다'는 뜻이라 마스크를 하나 잘못 쓰면 실제 로컬 데이터가
/// 조용히 사라진다 — 순수 함수로 떼어 표 테스트로 잠근다.
///
/// 재해석 지점일 것을 함께 요구한다. 판정이 좁을수록 실제 로컬 데이터를 잘못
/// 빼먹을 위험이 줄고, 빼먹는 쪽이 과다 계수보다 사용자에게 나쁘다.
fn is_cloud_placeholder_attrs(attrs: u32) -> bool {
    attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && attrs
            & (FILE_ATTRIBUTE_OFFLINE
                | FILE_ATTRIBUTE_RECALL_ON_OPEN
                | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
            != 0
}

/// 할당 크기를 파일시스템의 셈만으로는 단정할 수 없는 파일.
///
/// NTFS 압축은 `AllocationSize`가 압축 후 클러스터를 가리키기도, 논리 크기를
/// 따라가기도 한다(구현·경로에 따라 다르다). 희소 파일은 구멍만큼 어긋난다.
/// 정확한 값은 파일당 `GetCompressedFileSize`가 필요해 열거 한 번으로 끝나지
/// 않으므로, 여기서는 '얼마나 섞였는가'만 세어 결과에 싣는다.
fn is_alloc_uncertain(attrs: u32) -> bool {
    attrs & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE) != 0
}

/// 경로 문자열이 원본과 다른지. `OsStr`가 UTF-8로 표현되지 않으면 표시용
/// `to_string_lossy`가 U+FFFD로 치환하므로, 그 문자열로는 파일을 다시 열 수 없다.
fn is_lossy(s: &std::ffi::OsStr) -> bool {
    s.to_str().is_none()
}

/// 이 길이를 넘는 경로에서 난 실패는 OS 코드보다 길이를 믿는다.
///
/// `read_dir`은 `\\?\` 접두사 없이 FindFirstFileW 를 부르므로, LongPathsEnabled 가
/// 꺼진 시스템(Windows 10/11 기본값)에서 MAX_PATH 를 넘는 디렉터리는 206이 아니라
/// 대부분 **ERROR_PATH_NOT_FOUND(3)** 로 실패한다. 그것을 '스캔 중 사라짐'으로
/// 안내하면 "다시 스캔하면 사라집니다"라는 **정반대의** 처방이 나가고, 정작
/// 서브트리가 통째로 빠진 사실은 설명되지 않는다.
const LONG_PATH_HINT_LEN: usize = 250;

/// 경로 길이를 **Windows 가 세는 단위**(UTF-16 코드 단위)로 잰다.
///
/// `OsStr::len()`은 Windows 에서 WTF-8 바이트 길이다. 한글은 문자당 3바이트라
/// `D:\프로젝트\백업\...` 같은 경로는 84자만 넘어도 250을 넘어서, 실제로는 삭제되어
/// 사라진 경로(2/3)나 원인 미상 오류가 전부 'tooLong'으로 승격된다 — 한국어 UI 인
/// 이 앱에서는 그 오탐이 상시적이다. MAX_PATH 260 의 단위가 UTF-16 코드 단위이므로
/// 비교 대상도 같은 단위로 맞춘다.
#[cfg(windows)]
fn path_len(path: &Path) -> usize {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().count()
}

/// Windows 밖에는 MAX_PATH 도 UTF-16 도 없다. 바이트 길이가 곧 관측 길이다.
#[cfg(not(windows))]
fn path_len(path: &Path) -> usize {
    path.as_os_str().len()
}

/// io 오류를 사용자에게 설명 가능한 갈래로 나눈다.
///
/// 경로를 함께 받는다 — 관측된 길이가 OS 코드보다 신뢰할 만한 근거인 경우가 있다.
fn error_kind(e: &std::io::Error, path: &Path) -> &'static str {
    let kind = match e.raw_os_error() {
        Some(5) => "denied",                // ERROR_ACCESS_DENIED
        Some(2) | Some(3) => "notFound",    // FILE_NOT_FOUND / PATH_NOT_FOUND
        Some(206) | Some(111) => "tooLong", // FILENAME_EXCED_RANGE / BUFFER_OVERFLOW
        Some(123) => "tooLong",             // ERROR_INVALID_NAME — 경로 구문·길이 문제
        // 미디어가 없는 이동식·광학 드라이브. 권한 문제로 안내하면 사용자가
        // 있지도 않은 설정을 뒤진다.
        Some(21) => "notReady", // ERROR_NOT_READY
        // 다른 프로세스가 쥐고 있는 파일. C: 스캔에서 드물지 않다.
        Some(32) | Some(33) => "locked", // SHARING_VIOLATION / LOCK_VIOLATION
        // 재해석 지점 대상을 시스템이 풀지 못하는 경우(끊긴 정션, 잠든 클라우드 공급자).
        // 항목은 실재하지만 지금은 열 수 없다는 점에서 'locked'와 성질이 같다.
        Some(1920) | Some(1921) => "locked", // CANT_ACCESS_FILE / CANT_RESOLVE_FILENAME
        _ => match e.kind() {
            std::io::ErrorKind::PermissionDenied => "denied",
            std::io::ErrorKind::NotFound => "notFound",
            _ => "other",
        },
    };
    // 길이가 이미 상한 근처면 '없는 경로'가 아니라 '못 여는 경로'다.
    if matches!(kind, "notFound" | "other") && path_len(path) >= LONG_PATH_HINT_LEN {
        return "tooLong";
    }
    kind
}

/// 부모 디렉터리에 있으면 그 하위 `target`·`obj`를 빌드 산출물로 볼 수 있는 파일들.
const BUILD_MARKERS: [&str; 8] = [
    "cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "cmakelists.txt",
    "makefile",
    "package.json",
    "build.sbt",
];

/// `target`·`obj` 힌트를 지문이 있을 때만 준다.
///
/// 이름만 보고 캐시로 적으면 `D:\Photos\target`의 RAW 파일이 '지워도 되는 것'으로
/// 보인다. 확장자 축(`content`)이 있어 복구는 되지만, 기본 화면이 거짓말을 해서는 안 된다.
fn child_hint(
    name: &str,
    path: &Path,
    inherited: Option<Category>,
    build_marker: bool,
) -> Option<Category> {
    if let Some(h) = hint_from_dir(name, inherited) {
        return Some(h);
    }
    if is_conditional_cache_dir(name) && (build_marker || path.join("CACHEDIR.TAG").exists()) {
        return Some(Category::Cache);
    }
    inherited
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        // 선행 점만 있는 이름(`.gitignore`)은 확장자가 아니라 이름이다.
        // 길이 상한을 넘으면 확장자가 아니라 파일명 접미사(해시·날짜)로 본다 —
        // `dump.a3f9c1e2...` 류를 그대로 키로 쓰면 맵이 파일 수만큼 자란다.
        Some(i) if i > 0 && i + 1 < name.len() && name.len() - i - 1 <= MAX_EXT_KEY_LEN => {
            name[i + 1..].to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

/// 이 스레드의 오류 대화상자를 끈다. Windows 밖에서는 아무것도 하지 않는다.
fn suppress_error_dialogs_on_this_thread() {
    #[cfg(windows)]
    crate::win::suppress_error_dialogs_for_thread();
}

/// 이 경로 자체가 **다른 곳을 가리키는** 링크인지. 대상을 따라가지 않으므로
/// I/O는 stat 한 번이다.
///
/// 재해석 지점 전체(`FILE_ATTRIBUTE_REPARSE_POINT`)를 보지 않는다. 그 비트는
/// OneDrive 동기화 루트·중복 제거·WOF 압축에도 서 있어서, 그것까지 막으면
/// 사용자가 OneDrive 폴더를 스캔 대상으로 고르는 정상 경로가 통째로 거부된다.
/// 읽기 대상을 실제로 바꾸는 것은 심볼릭 링크와 정션뿐이고 std 는 그 둘만
/// `is_symlink`으로 본다.
fn is_redirecting_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// 디렉터리의 **객체 신원**. (볼륨 시리얼, 파일 인덱스)이며 경로 문자열과 달리
/// 바꿔치기로 바뀌지 않는다. Windows 밖에서는 대조할 수단이 없어 항상 `None`이다.
pub type FileIdentity = (u32, u64);

#[cfg(windows)]
fn file_identity(path: &Path) -> Option<FileIdentity> {
    crate::win::file_identity(path)
}

#[cfg(not(windows))]
fn file_identity(_path: &Path) -> Option<FileIdentity> {
    None
}

fn scan_dir(path: &Path, hint: Option<Category>, ctx: &ScanCtx, depth: u32) -> (Node, Stats) {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let mut node = Node::dir(name, path.to_string_lossy().into_owned());
    // 상위 어딘가에서 이미 손실이 있었다면 이 아래 모든 경로가 손실이다.
    // 디렉터리마다 한 번만 재고, 자식은 이 값과 자기 이름만 OR 한다.
    let dir_lossy = is_lossy(path.as_os_str());
    node.lossy_path = dir_lossy;
    let mut stats = Stats::default();
    let progress = ctx.progress;

    if progress.is_cancelled() {
        node.incomplete = true;
        return (node, stats);
    }

    if depth >= MAX_SCAN_DEPTH {
        progress.dir_errors.fetch_add(1, Ordering::Relaxed);
        ctx.record_failure(path, "tooDeep");
        node.incomplete = true;
        return (node, stats);
    }

    // **모든 깊이에서** 다시 확인한다.
    //
    // 부모를 열거할 때 이 항목이 링크가 아니라고 판정했더라도, 그 판정과 아래
    // `read_dir` 사이에는 아무 재검사가 없었다. 같은 사용자 컨텍스트로 도는 다른
    // 프로세스가(디렉터리 쓰기 권한이면 족하다) 열거 직후 항목을 지우고 같은
    // 이름의 심볼릭 링크를 `\\attacker\share` 로 만들면, 순회 한복판에서 UNC 접촉이
    // 성립해 현재 사용자의 NTLM 협상이 공격자 호스트로 나간다 — `resolve_root`가
    // 세 겹으로 막아 둔 바로 그 위협이다. 루트에 대해서만 이 재대조를 하던 시절에는
    // 자식 쪽 창이 통째로 열려 있었고, 방어의 일관성이 거기서 깨졌다.
    //
    // 비용은 디렉터리당 `symlink_metadata` 한 번이다(디렉터리 수는 파일 수의 1/4
    // 수준이라 stat 총량 증가는 25% 미만). 창을 없애지는 못하지만 밀리초 단위로
    // 줄인다 — 근본 해결은 부모 핸들을 쥐고 `NtQueryDirectoryFile` 로 내려가는
    // 것이고, 그건 별개 과제다.
    //
    // 걸린 항목은 조용히 건너뛰지 않는다. 결과가 그 누락을 스스로 말해야 한다.
    if is_redirecting_link(path) {
        progress.dir_errors.fetch_add(1, Ordering::Relaxed);
        ctx.record_failure(path, "other");
        node.incomplete = true;
        return (node, stats);
    }

    // 링크 검사는 '지금 이 경로가 링크인가'만 답한다. 루트가 통째로 **다른**
    // 디렉터리로 바뀌어도(부모에 쓰기 권한이 있으면 성립한다) 그 검사는 통과한다.
    // 검증 시점에 받아 둔 신원과 대조하면 경로 문자열이 아니라 객체 동일성으로
    // 판정하게 되어, 남는 창은 이 대조와 바로 아래 `read_dir` 사이뿐이다.
    if depth == 0 {
        if let Some(expected) = ctx.root_identity {
            if file_identity(path) != Some(expected) {
                progress.dir_errors.fetch_add(1, Ordering::Relaxed);
                ctx.record_failure(path, "other");
                node.incomplete = true;
                return (node, stats);
            }
        }
    }

    // try_lock 이라 경합해도 순회가 멈추지 않는다. 표시가 한 틱 늦는 것은 문제가 아니다.
    if let Ok(mut cur) = progress.current.try_lock() {
        cur.clear();
        cur.push_str(&node.path);
    }

    let listing = match dirent::read_dir(path) {
        Ok(e) => e,
        Err(e) => {
            // 권한 거부가 대부분이지만 경로 길이 초과도 여기로 온다. 갈래를 남긴다.
            progress.dir_errors.fetch_add(1, Ordering::Relaxed);
            ctx.record_failure(path, error_kind(&e, path));
            node.incomplete = true;
            return (node, stats);
        }
    };

    // 항목 단위 실패는 조용히 버리지 않는다. errors 는 통계가 아니라 '집계가
    // 실제보다 작다'는 신호라, 누락되면 잘못된 안심을 준다.
    // (Win32 일괄 열거에는 이 갈래가 없어 항상 비어 있다.)
    for e in &listing.entry_errors {
        progress.file_errors.fetch_add(1, Ordering::Relaxed);
        ctx.record_failure(path, error_kind(e, path));
    }

    let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
    let mut local_files: u64 = 0;
    let mut local_bytes: u64 = 0;
    let mut local_alloc: u64 = 0;
    let mut local_uncertain_files: u64 = 0;
    let mut local_uncertain_bytes: u64 = 0;
    let mut local_exts: HashMap<String, (u64, u64)> = HashMap::new();
    // (크기, 경로, 이름, 분야키, 경로 손실 여부). 큰 것만 남기므로 문자열 할당이 곧 줄어든다.
    let mut candidates: Vec<FileCand> = Vec::new();
    let mut cand_floor: u64 = 0;
    let mut seen: u64 = 0;
    // 이 디렉터리가 빌드 루트인지. 어차피 한 번 도는 김에 같이 본다.
    let mut build_marker = false;

    for entry in listing.entries {
        seen += 1;
        if seen.is_multiple_of(CANCEL_CHECK_INTERVAL) && progress.is_cancelled() {
            node.incomplete = true;
            break;
        }

        // 클라우드 자리표시자를 **링크 검사보다 먼저** 소진한다. 둘 다 재해석
        // 지점이지만 자리표시자는 결코 링크가 아니고, 여기서 걸러 두면 OneDrive
        // 폴더에서 항목마다 아래 `symlink_metadata` 가 한 번씩 더 나가는 것을 막는다.
        // 로컬 점유가 0이므로 총계에서 빼되, 뺀 만큼은 카운터로 알린다 —
        // 조용한 누락이 가장 나쁘다.
        if entry.is_file && is_cloud_placeholder_attrs(entry.attributes) {
            progress.skipped_cloud.fetch_add(1, Ordering::Relaxed);
            progress
                .skipped_cloud_bytes
                .fetch_add(entry.size, Ordering::Relaxed);
            continue;
        }

        let name_lossy = is_lossy(&entry.name);
        let entry_path = path.join(&entry.name);

        // 재해석 지점 전체가 아니라 '링크'만 거른다. 전부 거르면 중복제거·WOF
        // 압축 파일까지 함께 사라져 실제 용량이 아무 신호 없이 누락된다.
        // 열거가 주는 것은 '재해석 지점인가'까지이고, 그것이 실제로 대상을 바꾸는
        // 링크인지는 `symlink_metadata` 가 확정한다 — 재해석 지점은 소수라 이
        // 추가 stat 은 트리 전체 비용에서 무시할 수준이다.
        if entry.is_reparse && is_redirecting_link(&entry_path) {
            // 링크를 따라가면 순환하거나 같은 데이터를 두 번 센다.
            progress.skipped_links.fetch_add(1, Ordering::Relaxed);
            continue;
        }

        if entry.is_dir {
            subdirs.push((entry_path, entry.name.to_string_lossy().into_owned()));
        } else if entry.is_file {
            let size = entry.size;
            let file_name = entry.name.to_string_lossy().into_owned();
            let ext = extension_of(&file_name);
            if !build_marker
                && (BUILD_MARKERS
                    .iter()
                    .any(|m| file_name.eq_ignore_ascii_case(m))
                    || matches!(ext.as_str(), "csproj" | "vcxproj" | "sln"))
            {
                build_marker = true;
            }

            // 하드 링크로 이어진 같은 실체는 두 번째부터 크기를 0으로 센다.
            // 개수는 그대로 센다 — 항목은 실재하므로 '없는 것'으로 만들면
            // 디렉터리에 무엇이 들었는지가 사라진다.
            let charged = ctx.charge_size(size, entry.file_id);

            let content = classify_ext(&ext);
            let cat = hint.unwrap_or(content);
            stats.add(cat, content, charged);

            let key = if ext.is_empty() { EXT_NONE_KEY } else { &ext };
            bump_ext(&mut local_exts, key, charged, 1);

            local_files += 1;
            local_bytes += charged;
            if charged > 0 {
                // 파일시스템이 보고한 할당 바이트가 있으면 그것이 정답이다.
                // 없는 플랫폼에서만 클러스터 올림으로 대신한다.
                let alloc = entry.allocation.unwrap_or_else(|| ctx.allocated_of(size));
                local_alloc += alloc;
                if is_alloc_uncertain(entry.attributes) {
                    local_uncertain_files += 1;
                    local_uncertain_bytes += alloc;
                }
            }

            // 후보에 들 만큼 크지 않으면 경로 문자열조차 만들지 않는다.
            if charged > cand_floor {
                candidates.push((
                    charged,
                    entry_path.to_string_lossy().into_owned(),
                    file_name,
                    cat.key(),
                    dir_lossy || name_lossy,
                ));
                if candidates.len() > FILE_CANDIDATES * 2 {
                    candidates.sort_unstable_by_key(|c| Reverse(c.0));
                    candidates.truncate(FILE_CANDIDATES);
                    cand_floor = candidates.last().map(|c| c.0).unwrap_or(0);
                }
            }
        }
    }

    candidates.sort_unstable_by_key(|c| Reverse(c.0));
    candidates.truncate(FILE_CANDIDATES);
    ctx.offer_files(&candidates);
    ctx.merge_exts(local_exts);
    ctx.add_allocated(local_alloc);
    if local_uncertain_files > 0 {
        ctx.alloc_uncertain_files
            .fetch_add(local_uncertain_files, Ordering::Relaxed);
        ctx.alloc_uncertain_bytes
            .fetch_add(local_uncertain_bytes, Ordering::Relaxed);
    }
    // 전역 목록에 넘긴 뒤에는 트리에 실을 만큼만 남긴다. 이 벡터는 하위 순회가
    // 끝날 때까지 스택 프레임에 살아 있어, 깊은 트리에서는 그대로 메모리 피크가 된다.
    candidates.truncate(FILE_NODES_PER_DIR);

    node.files += local_files;
    node.size += local_bytes;
    stats.dirs += subdirs.len() as u64;
    progress.files.fetch_add(local_files, Ordering::Relaxed);
    progress.bytes.fetch_add(local_bytes, Ordering::Relaxed);
    progress
        .dirs
        .fetch_add(subdirs.len() as u64, Ordering::Relaxed);

    // 하위 디렉터리를 병렬로 내려간다. rayon의 작업 훔치기가 중첩 호출을 알아서 편다.
    let results: Vec<(Node, Stats)> = subdirs
        .par_iter()
        .map(|(child_path, child_name)| {
            let hint = child_hint(child_name, child_path, hint, build_marker);
            scan_dir(child_path, hint, ctx, depth + 1)
        })
        .collect();

    for (child_node, child_stats) in results {
        node.size += child_node.size;
        node.files += child_node.files;
        stats.merge(&child_stats);
        node.children.push(child_node);
    }

    // 대용량 파일을 노드로 섞는다. 폴더 크기만 보여 주면 '40GB짜리 ISO 하나'와
    // '40GB어치 잡파일'이 화면에서 구분되지 않는다.
    let mut shown_files: u64 = 0;
    let mut shown_bytes: u64 = 0;
    for cand in candidates.iter() {
        shown_files += 1;
        shown_bytes += cand.0;
        node.children.push(Node::file(
            cand.2.clone(),
            cand.1.clone(),
            cand.0,
            cand.4,
            cand.3,
        ));
    }

    // 노드로 싣지 못한 파일도 개수·바이트를 남긴다. "생략한 것은 개수·크기·사유를
    // 남긴다"는 불변식이 디렉터리에만 적용되면, 파일 5,000개짜리 폴더에서
    // 사용자는 자식 10줄과 부모 크기의 차액을 아무 설명 없이 마주한다.
    let hidden_files = local_files - shown_files;
    note_truncated(
        &mut node,
        "count",
        hidden_files.min(u32::MAX as u64) as u32,
        local_bytes - shown_bytes,
    );

    // 큰 것부터. 가지치기와 화면 표시 모두 이 순서를 전제한다.
    node.children.sort_unstable_by_key(|c| Reverse(c.size));

    prune_in_place(&mut node, progress.bytes.load(Ordering::Relaxed));

    (node, stats)
}

/// 순회 도중에 자식을 잘라 트리가 커지는 것 자체를 막는다.
///
/// 최종 가지치기 임계는 `전체/2000`이다. 여기서 쓰는 임계는 `부모/2000`과
/// `지금까지 센 바이트/2000` 중 큰 쪽인데, **둘 다 전체 크기를 넘지 않으므로**
/// 여기서 버린 노드는 최종 가지치기에서도 반드시 버려진다 — 결과는 같고
/// 메모리 피크만 사라진다. 크기는 이미 부모에 합산된 뒤라 집계도 온전하다.
///
/// `scanned_bytes`는 스캔이 진행될수록 최종 총량에 가까워지므로, 초반에는
/// 느슨하고 후반에는 최종 임계와 거의 같은 강도로 잘라낸다.
fn prune_in_place(node: &mut Node, scanned_bytes: u64) {
    let floor = node.size.max(scanned_bytes) / SIZE_DIVISOR;
    if node.children.len() <= IN_SCAN_MAX_CHILDREN && floor == 0 {
        return;
    }

    let mut kept: Vec<Node> = Vec::with_capacity(node.children.len().min(IN_SCAN_MAX_CHILDREN));
    let (mut small_n, mut small_b) = (0u32, 0u64);
    let (mut cap_n, mut cap_b) = (0u32, 0u64);

    for child in node.children.drain(..) {
        if child.size < floor {
            small_n += 1;
            small_b += child.size;
        } else if kept.len() >= IN_SCAN_MAX_CHILDREN {
            cap_n += 1;
            cap_b += child.size;
        } else {
            kept.push(child);
        }
    }

    node.children = kept;
    note_truncated(node, "size", small_n, small_b);
    note_truncated(node, "count", cap_n, cap_b);
}

/// 트리를 화면에 실을 만한 크기로 줄인다.
///
/// 전체를 그대로 직렬화하면 드라이브 하나에 수십만 노드가 나와 IPC에서 막힌다.
/// 눈에 보이지도 않을 작은 노드를 버리되, 버린 개수·크기·사유를 남겨
/// 사용자가 "왜 자식 합이 부모에 못 미치는가"를 확인할 수 있게 한다.
fn prune(node: &mut Node, min_size: u64, depth: u32, max_depth: u32, max_children: usize) {
    if depth >= max_depth {
        if !node.children.is_empty() {
            let count = node.children.len() as u32;
            let bytes: u64 = node.children.iter().map(|c| c.size).sum();
            node.children.clear();
            note_truncated(node, "depth", count, bytes);
        }
        return;
    }

    let mut kept: Vec<Node> = Vec::with_capacity(node.children.len().min(max_children));
    let (mut small_n, mut small_b) = (0u32, 0u64);
    let (mut cap_n, mut cap_b) = (0u32, 0u64);

    for child in node.children.drain(..) {
        if child.size < min_size {
            small_n += 1;
            small_b += child.size;
        } else if kept.len() >= max_children {
            cap_n += 1;
            cap_b += child.size;
        } else {
            kept.push(child);
        }
    }

    node.children = kept;
    note_truncated(node, "size", small_n, small_b);
    note_truncated(node, "count", cap_n, cap_b);

    for child in node.children.iter_mut() {
        prune(child, min_size, depth + 1, max_depth, max_children);
    }
}

/// 1970-01-01 기준 일수를 (년, 월, 일)로. Howard Hinnant의 civil_from_days.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 스캔 시각을 RFC3339(UTC)로. 크레이트를 하나 더 끌어들일 값어치는 없다.
fn rfc3339_utc(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 확장자 키가 떨어지는 분야. 센티널 키는 여러 분야가 섞인 잔여 항목이므로 `other`다.
fn ext_category(ext: &str) -> &'static str {
    if ext == EXT_OVERFLOW_KEY || ext == EXT_NONE_KEY {
        return Category::Other.key();
    }
    classify_ext(ext).key()
}

/// 상위 `limit`개만 남기고 나머지를 잔여 항목 **한 줄**로 접는다.
///
/// 그냥 자르면 목록의 합이 총량과 어긋나 '기타'를 분해하려던 목적이 무너진다.
/// 접은 줄에는 종수를 함께 실어, 그 덩어리가 '소수 대형'인지 '롱테일'인지
/// 판별할 수 있게 한다.
///
/// 입력에 이미 있는 `EXT_OVERFLOW_KEY` 행(맵 키 상한에 걸려 접힌 것)은 **먼저 빼서**
/// 잔여 줄에 합친다. 그러지 않으면 같은 키를 가진 행이 목록에 두 번 나와, 그것을
/// React key 나 조인 키로 쓰는 화면이 조용히 깨진다. 그 행이 대표하던 종수는 알 수
/// 없으므로 1로 세며, 결과적으로 `kinds`는 **하한값**이다.
fn fold_extensions(list: Vec<ExtStat>, limit: usize) -> Vec<ExtStat> {
    let mut folded: Option<ExtStat> = None;
    let mut kept: Vec<ExtStat> = Vec::with_capacity(list.len().min(limit));

    for stat in list {
        let is_overflow = stat.ext == EXT_OVERFLOW_KEY;
        if !is_overflow && kept.len() < limit {
            kept.push(stat);
            continue;
        }
        let slot = folded.get_or_insert_with(|| ExtStat {
            ext: EXT_OVERFLOW_KEY.to_string(),
            size: 0,
            files: 0,
            category: Category::Other.key(),
            kinds: 0,
        });
        slot.size += stat.size;
        slot.files += stat.files;
        slot.kinds += stat.kinds;
    }

    if let Some(rest) = folded {
        kept.push(rest);
    }
    kept
}

fn category_stats(acc: &[CatAcc; CATEGORY_COUNT]) -> Vec<CategoryStat> {
    let mut out: Vec<CategoryStat> = ALL_CATEGORIES
        .iter()
        .map(|c| CategoryStat {
            key: c.key().to_string(),
            label: c.label().to_string(),
            color: c.color(),
            size: acc[c.index()].size,
            files: acc[c.index()].files,
        })
        .filter(|s| s.files > 0)
        .collect();
    out.sort_unstable_by_key(|c| Reverse(c.size));
    out
}

/// 스캔 시작 시점에 확정되는 실행 조건.
///
/// 결과가 나중에 증거로 쓰이려면 "어떤 볼륨을 어떤 권한으로 읽었는가"가 함께
/// 남아야 한다. 순회가 끝난 뒤에 붙이면 조회 시점이 스캔과 어긋나므로 입력으로 받는다.
///
/// 파일시스템 이름·볼륨 시리얼·세대 번호도 여기로 옮겼다. 예전에는 `scan()`이 그 셋을
/// 자리표시자(`0`·`String::new()`)로 채워 돌려주고 호출자가 나중에 덮어썼는데,
/// 타입이 '아직 유효하지 않은 상태'를 표현하지 못해 그 필드를 읽는 코드가 언제부터
/// 신뢰 가능한지 시그니처만으로는 알 수 없었다. 게다가 파일시스템 이름은 순회 **중**
/// (하드 링크 중복 제거 가부) 필요한 값이라 나중에 붙일 수 없다.
#[derive(Clone, Default)]
pub struct ScanOptions {
    /// 볼륨 클러스터 크기(바이트). 0이면 미상이고 할당 누적을 생략한다.
    pub cluster_bytes: u64,
    /// 상승된(관리자) 토큰으로 실행 중인지.
    pub elevated: bool,
    /// 경로를 검증한 시점의 루트 신원. 순회 진입에서 다시 읽어 대조한다.
    /// `None`이면 대조를 생략한다(신원을 못 읽는 볼륨·비 Windows).
    pub root_identity: Option<FileIdentity>,
    /// 볼륨 파일시스템 이름(`NTFS`·`exFAT` …). 하드 링크 중복 제거 가부를 여기서 가른다.
    pub file_system: String,
    /// 표시용 볼륨 시리얼(`XXXX-XXXX`).
    pub volume_serial: String,
    /// 하드 링크 판정 키의 앞쪽 절반. 0이면 미상이다.
    pub volume_serial_num: u32,
    /// 이 스캔의 세대 번호.
    pub scan_id: u64,
    /// 하드 링크 판정 집합에 넣을 최소 크기. 0이면 전부 추적한다.
    pub hardlink_min_bytes: u64,
}

/// 트리를 순회해 결과를 만든다.
///
/// `progress`는 **호출자가 초기화해서 넘긴다**. 여기서 다시 초기화하면
/// 커맨드 진입과 이 함수 사이에 들어온 취소 요청이 덮여 사라진다.
pub fn scan(root: &Path, progress: &Progress, options: ScanOptions) -> ScanResult {
    let started_at = rfc3339_utc(std::time::SystemTime::now());
    let start = std::time::Instant::now();

    let root_hint = root
        .file_name()
        .and_then(|s| hint_from_dir(&s.to_string_lossy(), None));

    let ctx = ScanCtx::new(progress, &options);
    // 최상위 호출까지 전용 풀 안에서 돌린다. 커맨드 계층의 blocking 스레드도
    // 기본 스택이라, 거기서 시작하면 깊은 트리에서 첫 프레임부터 위태롭다.
    let (mut node, stats) = match rayon::ThreadPoolBuilder::new()
        .stack_size(SCAN_STACK_BYTES)
        // 순회 스레드마다 오류 대화상자를 스레드 단위로 끈다. 프로세스 전역 모드는
        // run() 최상단에서 이미 한 번 걸지만, 그 read-modify-write 는 순간적으로
        // 모드를 0으로 떨어뜨리는 창을 만든다(MS 가 비권장하는 패턴이다).
        // 실제로 "디스크를 넣으십시오"를 유발하는 stat 은 전부 이 스레드들에서
        // 일어나므로, 여기서 스레드 모드를 세우면 그 창과 무관해진다.
        .start_handler(|_| suppress_error_dialogs_on_this_thread())
        .build()
    {
        Ok(pool) => pool.install(|| scan_dir(root, root_hint, &ctx, 0)),
        // 스레드 생성 실패는 시스템이 이미 한계라는 뜻이다. 그래도 스캔은 해준다.
        Err(_) => scan_dir(root, root_hint, &ctx, 0),
    };

    // 드라이브 루트는 `file_name()`이 비어 `C:\` 같은 표시가 사라진다. 되살려 준다.
    if node.name.is_empty() {
        node.name = root.to_string_lossy().into_owned();
    }

    let total_size = node.size;
    let total_files = node.files;
    // 전체의 0.05% 미만은 버린다. 100GB 스캔이면 50MB가 경계선이 된다.
    let min_size = (total_size / SIZE_DIVISOR).max(1);
    prune(&mut node, min_size, 0, MAX_DEPTH, MAX_CHILDREN);

    let mut all_exts: Vec<ExtStat> = ctx
        .exts
        .into_inner()
        .unwrap_or_default()
        .into_iter()
        .map(|(ext, (size, files))| ExtStat {
            category: ext_category(&ext),
            ext,
            size,
            files,
            kinds: 1,
        })
        .collect();
    all_exts.sort_unstable_by_key(|e| Reverse(e.size));

    // '기타'로 떨어진 확장자만 따로 뽑는다. 전역 목록만으로는 미분류 덩어리를
    // 되짚을 수 없다(전역 상위 30은 대개 mp4·iso 같은 이미 분류된 것들로 찬다).
    let other_extensions = fold_extensions(
        all_exts
            .iter()
            .filter(|e| e.category == Category::Other.key())
            .cloned()
            .collect(),
        EXT_LIST_LIMIT,
    );
    let extensions = fold_extensions(all_exts, EXT_LIST_LIMIT);

    let mut largest_files: Vec<FileEntry> = ctx
        .top
        .into_inner()
        .unwrap_or_default()
        .into_iter()
        .map(
            |Reverse((size, path, name, category, lossy_path))| FileEntry {
                name,
                path,
                size,
                category,
                lossy_path,
            },
        )
        .collect();
    largest_files.sort_unstable_by_key(|f| Reverse(f.size));

    let dir_errors = progress.dir_errors.load(Ordering::Relaxed);
    let file_errors = progress.file_errors.load(Ordering::Relaxed);
    let failed_paths_total = ctx.failed_total.load(Ordering::Relaxed);
    // 중복을 접은 것과 상한에 걸려 버린 것은 다른 사건이다. 후자만 '잘렸다'로 알린다.
    let failed_paths_truncated = ctx.failed_dropped.load(Ordering::Relaxed);
    let failed_paths = ctx.failed.into_inner().unwrap_or_default().list;

    // 중복 제거를 켤 수 있었는지. 이유를 함께 남겨야 사용자가 '껐다'를 버그로 읽지 않는다.
    let dedup_disabled = dedup_disabled_reason(&options.file_system);

    ScanResult {
        root: node,
        categories: category_stats(&stats.cats),
        content_categories: category_stats(&stats.content),
        extensions,
        other_extensions,
        largest_files,
        total_size,
        // 공유 카운터가 아니라 자기 트리에서 산출한다.
        total_files,
        total_dirs: stats.dirs,
        errors: dir_errors + file_errors,
        dir_errors,
        file_errors,
        failed_paths,
        failed_paths_total,
        failed_paths_truncated,
        skipped_links: progress.skipped_links.load(Ordering::Relaxed),
        skipped_cloud: progress.skipped_cloud.load(Ordering::Relaxed),
        skipped_cloud_bytes: progress.skipped_cloud_bytes.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        cancelled: progress.is_cancelled(),
        root_path: root.to_string_lossy().into_owned(),
        started_at,
        app_version: env!("CARGO_PKG_VERSION"),
        // 크기 축은 여전히 논리 크기다(점유량은 allocated_estimate 가 따로 답한다).
        size_basis: "logical",
        dedup: if dedup_disabled.is_empty() {
            "hardlink"
        } else {
            "none"
        },
        dedup_disabled_reason: dedup_disabled,
        dedup_min_bytes: if dedup_disabled.is_empty() {
            options.hardlink_min_bytes
        } else {
            0
        },
        hardlink_deduped_files: ctx.deduped_files.load(Ordering::Relaxed),
        hardlink_deduped_bytes: ctx.deduped_bytes.load(Ordering::Relaxed),
        alloc_uncertain_files: ctx.alloc_uncertain_files.load(Ordering::Relaxed),
        alloc_uncertain_bytes: ctx.alloc_uncertain_bytes.load(Ordering::Relaxed),
        cluster_bytes: options.cluster_bytes,
        file_system: options.file_system.clone(),
        volume_serial: options.volume_serial.clone(),
        allocated_estimate: ctx.allocated.load(Ordering::Relaxed),
        // 파일시스템이 항목마다 할당 바이트를 보고하는 플랫폼에서는 그것이 정답이다.
        alloc_basis: if cfg!(windows) {
            "allocationSize"
        } else if options.cluster_bytes > 0 {
            "clusterRoundUp"
        } else {
            "unknown"
        },
        elevated: options.elevated,
        prune_params: PruneParams {
            min_size,
            max_depth: MAX_DEPTH,
            max_children: MAX_CHILDREN,
        },
        scan_id: options.scan_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 테스트가 끝나면(assert 실패로 패닉해도) 픽스처를 지운다.
    struct Fixture(PathBuf);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 알려진 크기의 파일로 작은 트리를 만든다.
    /// 이름에 프로세스 id를 섞는다 — 두 테스트 프로세스가 겹치면 서로를 지운다.
    fn fixture(name: &str) -> Fixture {
        let root =
            std::env::temp_dir().join(format!("discan_test_{}_{}", name, std::process::id()));
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

        Fixture(root)
    }

    fn node(name: &str, size: u64) -> Node {
        Node::dir(name.to_string(), format!("/{}", name)).tap_size(size)
    }

    impl Node {
        fn tap_size(mut self, size: u64) -> Node {
            self.size = size;
            self
        }
    }

    #[test]
    fn aggregates_sizes_and_counts() {
        let fx = fixture("agg");
        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        assert_eq!(result.total_size, 7200);
        assert_eq!(result.total_files, 5);
        // src, node_modules, node_modules/dep
        assert_eq!(result.total_dirs, 3);
        assert_eq!(result.errors, 0);
        assert!(!result.cancelled);
        assert_eq!(result.size_basis, "logical");
        assert_eq!(result.prune_params.max_depth, MAX_DEPTH);
    }

    #[test]
    fn classifies_by_extension_and_directory_hint() {
        let fx = fixture("classify");
        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        let by_key = |list: &Vec<CategoryStat>, key: &str| {
            list.iter()
                .find(|c| c.key == key)
                .map(|c| c.size)
                .unwrap_or(0)
        };

        assert_eq!(by_key(&result.categories, "video"), 5000);
        assert_eq!(by_key(&result.categories, "document"), 1000);
        // .rs 두 개만 코드다. node_modules 의 .js 는 여기 포함되면 안 된다.
        assert_eq!(by_key(&result.categories, "code"), 500);
        assert_eq!(by_key(&result.categories, "cache"), 700);

        // 힌트를 무시한 축에서는 그 .js 가 코드로 돌아와야 캐시 내부를 분해할 수 있다.
        assert_eq!(by_key(&result.content_categories, "code"), 1200);
        assert_eq!(by_key(&result.content_categories, "cache"), 0);
    }

    #[test]
    fn reports_largest_files_and_extensions() {
        let fx = fixture("largest");
        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        assert_eq!(result.largest_files.len(), 5);
        assert_eq!(result.largest_files[0].name, "movie.mp4");
        assert_eq!(result.largest_files[0].size, 5000);

        let mp4 = result.extensions.iter().find(|e| e.ext == "mp4").unwrap();
        assert_eq!(mp4.size, 5000);
        assert_eq!(mp4.files, 1);
        // 확장자 축이 분야와 교차되어야 '기타 1.65GiB'를 눌러 분해할 수 있다.
        assert_eq!(mp4.category, "video");
        let rs = result.extensions.iter().find(|e| e.ext == "rs").unwrap();
        assert_eq!(rs.category, "code");
    }

    /// 확장자 키는 데이터 열이지 표시 문구가 아니다. 한국어 문자열이 실리면
    /// 하류 스크립트가 잔여 항목을 찾으려고 그 문자열을 하드코딩하게 되고,
    /// 라벨을 다듬는 순간 파이프라인이 조용히 깨진다.
    #[test]
    fn extension_keys_are_locale_independent_sentinels() {
        let root = std::env::temp_dir().join(format!("discan_extkey_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Makefile"), vec![b'x'; 100]).unwrap();
        let fx = Fixture(root);

        let result = scan(&fx.0, &Progress::new(), ScanOptions::default());
        let none = result
            .extensions
            .iter()
            .find(|e| e.ext == EXT_NONE_KEY)
            .expect("확장자 없는 파일이 센티널 키로 잡혀야 한다");
        assert_eq!(none.files, 1);
        assert_eq!(none.category, "other");
        // ASCII 센티널이어야 로케일·언어와 무관하다.
        assert!(EXT_NONE_KEY.is_ascii() && EXT_OVERFLOW_KEY.is_ascii());
    }

    /// 클러스터 올림은 **폴백**이다. 파일시스템이 항목마다 할당 바이트를 보고하는
    /// 플랫폼에서는 그것을 그대로 쓰고, 산출 방식을 결과가 스스로 밝혀야 한다 —
    /// 두 값은 MFT 상주 파일에서 체계적으로 갈리므로 어느 쪽인지 모르면 탐색기와의
    /// 차액을 설명할 수 없다.
    #[test]
    fn allocated_size_reports_which_basis_it_used() {
        let fx = fixture("alloc");
        let opts = ScanOptions {
            cluster_bytes: 4096,
            ..Default::default()
        };
        let result = scan(&fx.0, &Progress::new(), opts);
        assert_eq!(result.cluster_bytes, 4096);

        if cfg!(windows) {
            // 파일시스템이 보고한 값이라 클러스터 올림과 같을 이유가 없다.
            // 단정할 수 있는 것은 '0이 아니고 산출 방식이 정확히 표기된다'까지다.
            assert_eq!(result.alloc_basis, "allocationSize");
            assert!(result.allocated_estimate > 0);
        } else {
            // 5000→8192, 나머지 네 개(1000·300·200·700)→각 4096.
            assert_eq!(result.alloc_basis, "clusterRoundUp");
            assert_eq!(result.allocated_estimate, 8192 + 4096 * 4);
            // 옛 추정 모델(total + files*cluster/2 = 7200 + 5*2048)과는 다른 값이다.
            assert_ne!(result.allocated_estimate, result.total_size + 5 * 2048);

            // 클러스터를 못 읽은 볼륨에서는 0을 '점유 없음'으로 오해하지 않도록
            // 산출 방식을 미상으로 표기한다.
            let unknown = scan(&fx.0, &Progress::new(), ScanOptions::default());
            assert_eq!(unknown.allocated_estimate, 0);
            assert_eq!(unknown.alloc_basis, "unknown");
        }
    }

    /// 클러스터 올림 자체는 폴백 경로에서만 도는데, 그 경로가 Windows 개발 머신에서
    /// 한 줄도 실행되지 않으면 계산이 조용히 틀어져도 아무도 모른다. 순수 함수로 잠근다.
    #[test]
    fn cluster_round_up_is_exact_per_file() {
        let progress = Progress::new();
        let ctx = ScanCtx::new(
            &progress,
            &ScanOptions {
                cluster_bytes: 4096,
                ..Default::default()
            },
        );
        assert_eq!(ctx.allocated_of(1), 4096);
        assert_eq!(ctx.allocated_of(4096), 4096);
        assert_eq!(ctx.allocated_of(4097), 8192);
        assert_eq!(ctx.allocated_of(0), 0);

        // 클러스터를 모르면 0을 돌려 누적을 통째로 생략한다(alloc_basis 가 미상이 된다).
        let unknown = ScanCtx::new(&progress, &ScanOptions::default());
        assert_eq!(unknown.allocated_of(5000), 0);
    }

    #[test]
    fn tree_contains_file_nodes() {
        let fx = fixture("filenodes");
        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        let movie = result
            .root
            .children
            .iter()
            .find(|c| c.name == "movie.mp4")
            .expect("대용량 파일이 트리에 노드로 있어야 한다");
        assert!(!movie.is_dir);
        assert_eq!(movie.files, 1);
        assert!(movie.children.is_empty());
    }

    #[test]
    fn cancelled_scan_yields_empty_tree_and_flag() {
        let fx = fixture("cancel");
        let progress = Progress::new();
        progress.cancel.store(true, Ordering::Relaxed);
        let result = scan(&fx.0, &progress, ScanOptions::default());

        assert!(result.cancelled);
        assert_eq!(result.total_size, 0);
        assert_eq!(result.total_files, 0);
        assert!(result.root.children.is_empty());
        assert!(result.root.incomplete);
    }

    /// 진입부 가드가 아니라 **파일 루프 도중** 취소되는 갈래. 사용자가 실제로
    /// 겪는 것은 이쪽인데(중단 버튼은 순회 중에 눌린다) 지금까지 한 줄도 실행되지
    /// 않았다. 확인 횟수 seam 을 쓰면 중단 지점과 그때의 부분 집계를 스레드 경합
    /// 없이 같은 자리에서 반복 검증할 수 있다.
    #[test]
    fn cancelling_mid_traversal_breaks_the_file_loop_and_keeps_partial_counts() {
        let root = std::env::temp_dir().join(format!("discan_midcancel_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 취소 확인 주기(테스트 8)의 몇 배가 되도록 넉넉히 만든다.
        for i in 0..64 {
            fs::write(root.join(format!("f{:02}.bin", i)), vec![b'x'; 100]).unwrap();
        }
        let fx = Fixture(root);

        let progress = Progress::new();
        // 1회차는 루트 진입부 가드가 쓴다. 그 뒤 두 번째 확인 = 루프 안이다.
        progress.cancel_after(2);
        let result = scan(&fx.0, &progress, ScanOptions::default());

        assert!(result.cancelled);
        // 진입부에서 끊겼다면 0이고, 끝까지 돌았다면 64다. 둘 다 이 갈래가 아니다.
        assert!(
            result.total_files > 0 && result.total_files < 64,
            "루프 도중 중단이 아니다: {}",
            result.total_files
        );
        // 부분 집계임을 노드가 스스로 말해야 한다 — 표시 용량은 하한값이다.
        assert!(result.root.incomplete);
        assert_eq!(result.total_size, result.total_files * 100);
        // 중단해도 지금까지 센 것은 결과에 남는다(빈 결과는 '디스크가 비었다'로 읽힌다).
        assert!(!result.root.children.is_empty());
    }

    /// 수집기 세 개는 rayon 워커 수만큼의 스레드가 동시에 두드린다. 단일 스레드
    /// 호출만 검증하면 이 프로젝트가 가장 조심스럽게 설계한 축이 검증 공백으로 남는다.
    #[test]
    fn collectors_hold_their_invariants_under_concurrent_writers() {
        const THREADS: u64 = 8;
        const PER_THREAD: u64 = 200;

        let progress = Progress::new();
        let ctx = ScanCtx::new(
            &progress,
            &ScanOptions {
                cluster_bytes: 4096,
                ..ScanOptions::default()
            },
        );

        // 참조를 복사해 넘긴다. `move` 클로저가 ctx 자체를 가져가면 두 번째 스레드가
        // 쓸 것이 남지 않는다.
        let shared = &ctx;
        std::thread::scope(|s| {
            for t in 0..THREADS {
                s.spawn(move || {
                    let cands: Vec<FileCand> = (0..PER_THREAD)
                        .map(|i| {
                            let size = t * PER_THREAD + i + 1;
                            (
                                size,
                                format!("/f{}", size),
                                format!("f{}", size),
                                "other",
                                false,
                            )
                        })
                        .collect();
                    // 디렉터리 하나가 여러 번에 나눠 던지는 실제 형태를 흉내낸다.
                    for chunk in cands.chunks(37) {
                        shared.offer_files(chunk);
                    }
                    let mut local: HashMap<String, (u64, u64)> = HashMap::new();
                    bump_ext(&mut local, "mp4", 10, 1);
                    shared.merge_exts(local);
                    shared.add_allocated(4096);
                });
            }
        });

        let total = THREADS * PER_THREAD;
        // 하한은 전역 상위 200의 최솟값이어야 한다. 경합으로 하한이 과하게 오르면
        // 이후 디렉터리가 자격 있는 파일을 락도 잡지 않고 버린다.
        assert_eq!(
            ctx.top_floor.load(Ordering::Relaxed),
            total - TOP_FILES as u64 + 1
        );
        assert_eq!(ctx.allocated.load(Ordering::Relaxed), 4096 * THREADS);
        let exts = ctx.exts.into_inner().unwrap();
        assert_eq!(exts.get("mp4"), Some(&(10 * THREADS, THREADS)));

        let heap = ctx.top.into_inner().unwrap();
        assert_eq!(heap.len(), TOP_FILES);
        let mut sizes: Vec<u64> = heap.into_iter().map(|Reverse((s, ..))| s).collect();
        sizes.sort_unstable();
        // 상위 200개 '집합'이 정확해야 한다. 하나라도 새면 목록의 이름이 거짓이 된다.
        let expected: Vec<u64> = ((total - TOP_FILES as u64 + 1)..=total).collect();
        assert_eq!(sizes, expected);
    }

    #[test]
    fn missing_root_counts_as_directory_error() {
        let root = std::env::temp_dir().join(format!("discan_missing_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let progress = Progress::new();
        let result = scan(&root, &progress, ScanOptions::default());

        assert_eq!(result.dir_errors, 1);
        assert_eq!(result.file_errors, 0);
        assert_eq!(result.failed_paths.len(), 1);
        assert_eq!(result.failed_paths[0].kind, "notFound");
        assert!(result.root.incomplete);
    }

    /// 디렉터리 링크를 만든다. 심볼릭 링크는 개발자 모드나 관리자 권한이 필요하지만
    /// 정션(`mklink /J`)은 권한이 필요 없다 — 둘 다 시도해야 CI·개발 머신 어디서든
    /// 검증이 실제로 평가된다. 조용히 통과하는 테스트는 없는 테스트보다 나쁘다.
    #[cfg(windows)]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    #[test]
    fn does_not_follow_directory_links() {
        let fx = fixture("reparse");
        let link = fx.0.join("loop");
        assert!(
            make_dir_link(&fx.0, &link),
            "심볼릭 링크와 정션 생성이 모두 실패했다 — 링크 회피 동작이 검증되지 않았다"
        );

        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        // 링크를 따라갔다면 값이 커지거나 아예 돌아오지 못한다.
        assert_eq!(result.total_size, 7200);
        // 카운터가 0이면 링크는 '조용히' 빠진 것이다 — 그게 이 프로젝트가 가장 경계하는 실패다.
        assert_eq!(result.skipped_links, 1);

        let _ = fs::remove_dir(&link);
    }

    /// 검증(resolve_root)과 첫 read_dir 사이에 루트가 링크로 바뀌는 창(TOCTOU)을
    /// 순회 진입에서 한 번 더 막는다. 여기가 뚫리면 '검증한 대상'과 '읽는 대상'이
    /// 달라지고, 바뀐 대상이 원격 형태면 자격증명 노출로 이어진다.
    #[cfg(windows)]
    #[test]
    fn a_linked_root_is_refused_at_traversal_entry() {
        let fx = fixture("rootswap");
        let link =
            std::env::temp_dir().join(format!("discan_rootswap_link_{}", std::process::id()));
        let _ = fs::remove_dir(&link);
        assert!(
            make_dir_link(&fx.0, &link),
            "심볼릭 링크와 정션 생성이 모두 실패했다 — 루트 바꿔치기 방어가 검증되지 않았다"
        );

        // 링크를 루트로 직접 넘긴다(resolve_root 를 거치지 않은, 바꿔치기 이후 상태).
        let result = scan(&link, &Progress::new(), ScanOptions::default());

        assert_eq!(result.total_size, 0);
        assert!(result.root.incomplete);
        assert_eq!(result.dir_errors, 1);
        // 조용히 빈 결과를 내면 사용자는 '디스크가 비었다'고 읽는다.
        assert_eq!(result.failed_paths.len(), 1);

        let _ = fs::remove_dir(&link);
    }

    #[cfg(windows)]
    #[test]
    fn cloud_placeholder_needs_both_reparse_and_recall_bits() {
        // 상수 자체가 오타로 어긋나면 아래 조합 검증이 통째로 무의미해진다.
        // MSDN 값을 십진수로 한 번 더 못 박아 자릿수 실수를 잡는다.
        assert_eq!(FILE_ATTRIBUTE_REPARSE_POINT, 1024);
        assert_eq!(FILE_ATTRIBUTE_OFFLINE, 4096);
        assert_eq!(FILE_ATTRIBUTE_RECALL_ON_OPEN, 262_144);
        assert_eq!(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, 4_194_304);

        // 재해석 지점 단독은 정션·중복제거·WOF 압축일 수 있다. 빼면 실제 용량이 사라진다.
        assert!(!is_cloud_placeholder_attrs(FILE_ATTRIBUTE_REPARSE_POINT));
        // OFFLINE 단독은 테이프 백업 등 옛 의미로도 서므로 단독으로는 믿지 않는다.
        assert!(!is_cloud_placeholder_attrs(FILE_ATTRIBUTE_OFFLINE));
        assert!(!is_cloud_placeholder_attrs(0));
        assert!(!is_cloud_placeholder_attrs(0x20)); // ARCHIVE

        assert!(is_cloud_placeholder_attrs(
            FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_OFFLINE
        ));
        assert!(is_cloud_placeholder_attrs(
            FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_RECALL_ON_OPEN
        ));
        assert!(is_cloud_placeholder_attrs(
            FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
        ));
    }

    /// 압축·희소 판정은 '점유를 얼마나 단정할 수 있는가'를 화면에 알리는 근거다
    /// (`allocUncertainFiles`/`Bytes`). 마스크를 하나 잘못 쓰면 정상 파일이 '불확실'로
    /// 잡혀 화면이 근거 없이 물러서거나, 압축·희소 파일이 '확실'로 잡혀 근거 없이
    /// 단정한다. `is_cloud_placeholder_attrs` 처럼 순수 함수 표 테스트로 마스크 오타를
    /// 조기에 잠근다 — 압축·희소 파일 픽스처는 만들기 까다로워 카운터 누적까지의
    /// 통합 검증은 두지 않지만, 오차가 실제로 들어오는 지점은 이 비트 판정이다.
    #[test]
    fn alloc_uncertain_tracks_only_compressed_or_sparse() {
        // 상수가 오타로 어긋나면 판정이 통째로 무의미해진다. MSDN 값을 십진수로
        // 한 번 더 못 박아 자릿수 실수를 잡는다.
        assert_eq!(FILE_ATTRIBUTE_COMPRESSED, 2048);
        assert_eq!(FILE_ATTRIBUTE_SPARSE_FILE, 512);

        // 둘 중 하나라도 서면 불확실이다.
        assert!(is_alloc_uncertain(FILE_ATTRIBUTE_COMPRESSED));
        assert!(is_alloc_uncertain(FILE_ATTRIBUTE_SPARSE_FILE));
        assert!(is_alloc_uncertain(
            FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE
        ));
        // 다른 속성과 섞여도 판정은 유지된다.
        assert!(is_alloc_uncertain(FILE_ATTRIBUTE_COMPRESSED | 0x20)); // + ARCHIVE
        assert!(is_alloc_uncertain(
            FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_REPARSE_POINT
        ));

        // 둘 다 없으면 확실이다 — 정상 파일을 '불확실'로 적으면 화면이 근거 없이 물러선다.
        assert!(!is_alloc_uncertain(0));
        assert!(!is_alloc_uncertain(0x20)); // ARCHIVE
        assert!(!is_alloc_uncertain(FILE_ATTRIBUTE_REPARSE_POINT)); // 재해석 지점 단독
        assert!(!is_alloc_uncertain(FILE_ATTRIBUTE_OFFLINE));
    }

    #[test]
    fn error_kind_maps_os_codes_users_will_act_on() {
        use std::io::Error;
        let short = Path::new(r"C:\temp");
        // 경로 길이 초과를 '권한 문제'로 안내하면 사용자는 엉뚱한 곳을 뒤진다.
        assert_eq!(error_kind(&Error::from_raw_os_error(5), short), "denied");
        assert_eq!(error_kind(&Error::from_raw_os_error(2), short), "notFound");
        assert_eq!(error_kind(&Error::from_raw_os_error(3), short), "notFound");
        assert_eq!(error_kind(&Error::from_raw_os_error(206), short), "tooLong");
        assert_eq!(error_kind(&Error::from_raw_os_error(111), short), "tooLong");
        assert_eq!(error_kind(&Error::from_raw_os_error(123), short), "tooLong");
        // 미디어 없는 드라이브와 잠긴 파일은 'other'로 뭉치면 '원인을 특정하지
        // 못했습니다'가 되어 사유별 분류를 도입한 목적이 사라진다.
        assert_eq!(error_kind(&Error::from_raw_os_error(21), short), "notReady");
        assert_eq!(error_kind(&Error::from_raw_os_error(32), short), "locked");
        assert_eq!(error_kind(&Error::from_raw_os_error(33), short), "locked");
        assert_eq!(error_kind(&Error::from_raw_os_error(1920), short), "locked");
        assert_eq!(error_kind(&Error::from_raw_os_error(1921), short), "locked");
        assert_eq!(
            error_kind(
                &Error::new(std::io::ErrorKind::PermissionDenied, "x"),
                short
            ),
            "denied"
        );
        assert_eq!(error_kind(&Error::other("x"), short), "other");
    }

    /// LongPathsEnabled 가 꺼진 시스템에서 260자 초과 디렉터리는 206이 아니라
    /// ERROR_PATH_NOT_FOUND(3)로 실패한다. 그것을 '스캔 중 사라짐'으로 적으면
    /// "다시 스캔하면 사라집니다"라는 정반대의 처방이 나간다.
    #[test]
    fn error_kind_prefers_too_long_for_long_paths() {
        use std::io::Error;
        let long = PathBuf::from(format!(r"C:\{}", "a".repeat(300)));
        assert_eq!(error_kind(&Error::from_raw_os_error(3), &long), "tooLong");
        assert_eq!(error_kind(&Error::from_raw_os_error(2), &long), "tooLong");
        assert_eq!(error_kind(&Error::other("x"), &long), "tooLong");
        // 관측된 길이가 근거이므로, 길이와 무관한 갈래까지 덮어서는 안 된다.
        assert_eq!(error_kind(&Error::from_raw_os_error(5), &long), "denied");
        assert_eq!(error_kind(&Error::from_raw_os_error(32), &long), "locked");
        // 경계 바로 아래는 그대로 둔다.
        let just_under = PathBuf::from("b".repeat(LONG_PATH_HINT_LEN - 1));
        assert_eq!(
            error_kind(&Error::from_raw_os_error(3), &just_under),
            "notFound"
        );
    }

    /// 길이 판정의 단위는 **UTF-16 코드 단위**다. Windows 의 MAX_PATH 260 이 그
    /// 단위이기 때문이다. 바이트로 세면 한글 경로는 93자(WTF-8 로 273바이트)만으로
    /// 'tooLong'이 되어, 실제로는 삭제되어 사라진 경로에 "상위 폴더 이름을
    /// 줄이십시오"라는 엉뚱한 처방이 나간다 — 한국어 UI 인 이 앱에서는 ASCII 오탐보다
    /// 이쪽이 훨씬 흔하다.
    #[cfg(windows)]
    #[test]
    fn error_kind_counts_path_length_in_utf16_units() {
        use std::io::Error;

        let korean = PathBuf::from(format!(r"C:\{}", "가".repeat(90)));
        // 전제: 바이트 길이는 이미 상한을 넘는다(고쳐야 할 지점이 바로 여기였다).
        assert!(korean.as_os_str().len() > LONG_PATH_HINT_LEN);
        assert_eq!(path_len(&korean), 93);
        assert_eq!(
            error_kind(&Error::from_raw_os_error(3), &korean),
            "notFound"
        );
        assert_eq!(error_kind(&Error::other("x"), &korean), "other");

        // 한글이라도 실제로 길면 걸려야 한다 — 방향만 고친 것이지 판정을 끈 것이 아니다.
        let korean_long = PathBuf::from(format!(r"C:\{}", "가".repeat(300)));
        assert_eq!(
            error_kind(&Error::from_raw_os_error(3), &korean_long),
            "tooLong"
        );
    }

    /// 같은 (경로, 갈래)가 여러 줄 쌓이면 상한 500건이 반복으로 소진되고, 화면에서도
    /// 같은 경로가 사유만 달리해 되풀이된다(React key 중복까지 따라온다).
    #[test]
    fn repeated_failures_of_the_same_path_and_kind_fold_into_one_row() {
        let progress = Progress::new();
        let ctx = ScanCtx::new(&progress, &ScanOptions::default());
        let path = Path::new(r"C:\locked");

        for _ in 0..50 {
            ctx.record_failure(path, "locked");
        }
        // 갈래가 다르면 별개의 사건이므로 접지 않는다.
        ctx.record_failure(path, "denied");
        ctx.record_failure(Path::new(r"C:\other"), "locked");

        let failed = ctx.failed.into_inner().unwrap();
        assert_eq!(failed.list.len(), 3);
        // 규모는 총수 축이 그대로 보존한다 — 접었다고 사라지면 감사 결론이 바뀐다.
        assert_eq!(ctx.failed_total.load(Ordering::Relaxed), 52);
        // 중복을 접은 것은 '목록이 잘렸다'가 아니다. 전량이 실린 결과를 부분 목록으로
        // 오인시키면 안 된다.
        assert!(!ctx.failed_dropped.load(Ordering::Relaxed));
    }

    #[test]
    fn failed_list_reports_truncation_only_when_it_actually_drops() {
        let progress = Progress::new();
        let ctx = ScanCtx::new(&progress, &ScanOptions::default());
        for i in 0..(MAX_FAILED_PATHS + 10) {
            ctx.record_failure(&PathBuf::from(format!(r"C:\p{}", i)), "denied");
        }
        assert!(ctx.failed_dropped.load(Ordering::Relaxed));
        assert_eq!(
            ctx.failed.into_inner().unwrap().list.len(),
            MAX_FAILED_PATHS
        );
    }

    /// 목록이 가득 찬 **뒤에** 도착한 중복은 손실이 아니다.
    ///
    /// 상한 검사가 중복 접기보다 앞에 있던 시절에는, 이미 목록에 있는 (경로, 갈래)가
    /// 다시 와도 '상한에 걸려 실제로 버렸다'로 기록됐다. C: 전체 스캔처럼 목록이
    /// 실제로 차는 상황에서 이후 실패가 모두 기존 경로의 반복이면, 화면은 없는 손실을
    /// '실패 N건 중 500건만 기록되었습니다'로 보고하게 된다.
    #[test]
    fn duplicates_after_the_list_is_full_do_not_count_as_dropped() {
        let progress = Progress::new();
        let ctx = ScanCtx::new(&progress, &ScanOptions::default());
        for i in 0..MAX_FAILED_PATHS {
            ctx.record_failure(&PathBuf::from(format!(r"C:\p{}", i)), "denied");
        }
        assert!(!ctx.failed_dropped.load(Ordering::Relaxed));

        // 목록은 가득 찼지만, 오는 것이 전부 이미 실린 조합이면 버린 것이 없다.
        for _ in 0..100 {
            ctx.record_failure(Path::new(r"C:\p0"), "denied");
        }
        assert!(
            !ctx.failed_dropped.load(Ordering::Relaxed),
            "중복 접기를 '상한에 걸려 버림'으로 보고했다"
        );
        assert_eq!(ctx.failed_total.load(Ordering::Relaxed), 600);

        // 새 키는 실제로 자리가 없어 버려지므로, 그때는 정직하게 세워야 한다.
        ctx.record_failure(Path::new(r"C:\new"), "denied");
        assert!(ctx.failed_dropped.load(Ordering::Relaxed));

        // 목록에 실린 것만 기억한다 — `seen`이 목록과 무관하게 자라면 그 자체가 메모리 축이다.
        let failed = ctx.failed.into_inner().unwrap();
        assert_eq!(failed.list.len(), MAX_FAILED_PATHS);
        assert_eq!(failed.seen.len(), MAX_FAILED_PATHS);
    }

    #[test]
    fn conditional_cache_hint_requires_a_build_fingerprint() {
        let root = std::env::temp_dir().join(format!("discan_hint_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("photos").join("target")).unwrap();
        fs::create_dir_all(root.join("proj").join("target")).unwrap();
        fs::create_dir_all(root.join("tagged").join("target")).unwrap();
        fs::write(
            root.join("tagged").join("target").join("CACHEDIR.TAG"),
            b"x",
        )
        .unwrap();
        let fx = Fixture(root.clone());

        // `D:\Photos\target`을 캐시로 적으면 정리하러 온 사용자가 RAW 파일을 지운다.
        assert_eq!(
            child_hint("target", &fx.0.join("photos").join("target"), None, false),
            None
        );
        // 부모에 빌드 지문이 있으면 같은 이름이 캐시가 된다.
        assert_eq!(
            child_hint("target", &fx.0.join("proj").join("target"), None, true),
            Some(Category::Cache)
        );
        // CACHEDIR.TAG 는 디렉터리 스스로가 붙인 표식이라 지문 없이도 믿는다.
        assert_eq!(
            child_hint("target", &fx.0.join("tagged").join("target"), None, false),
            Some(Category::Cache)
        );
        // 이름만으로 확정되는 디렉터리는 지문과 무관하다.
        assert_eq!(
            child_hint("node_modules", &fx.0, None, false),
            Some(Category::Cache)
        );
        // 상속된 힌트는 자식 이름보다 우선한다.
        assert_eq!(
            child_hint("photos", &fx.0, Some(Category::Game), false),
            Some(Category::Game)
        );
    }

    #[test]
    fn offer_files_keeps_the_global_top_and_raises_the_floor() {
        let progress = Progress::new();
        let ctx = ScanCtx::new(&progress, &ScanOptions::default());

        // 250개를 100바이트 단위로 넣으면 상위 200개의 하한은 51*100 이다.
        let cands: Vec<FileCand> = (1..=250)
            .map(|i| {
                (
                    i as u64 * 100,
                    format!("/f{}", i),
                    format!("f{}", i),
                    "other",
                    false,
                )
            })
            .collect();
        for chunk in cands.chunks(37) {
            ctx.offer_files(chunk);
        }

        // 하한이 갱신되어야 이후 디렉터리가 락을 잡지 않고 후보를 버릴 수 있다.
        assert_eq!(ctx.top_floor.load(Ordering::Relaxed), 5100);

        let heap = ctx.top.into_inner().unwrap();
        assert_eq!(heap.len(), TOP_FILES);
        let mut sizes: Vec<u64> = heap.into_iter().map(|Reverse((s, ..))| s).collect();
        sizes.sort_unstable();
        assert_eq!(sizes[0], 5100);
        assert_eq!(sizes[TOP_FILES - 1], 25_000);
    }

    #[test]
    fn hidden_file_nodes_are_counted_as_truncated() {
        let root = std::env::temp_dir().join(format!("discan_manyfiles_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 같은 크기 파일 40개. 노드로는 10개만 실린다.
        for i in 0..40 {
            fs::write(root.join(format!("f{:02}.bin", i)), vec![b'x'; 100]).unwrap();
        }
        let fx = Fixture(root);

        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        assert_eq!(result.total_files, 40);
        assert_eq!(result.total_size, 4000);
        // 노드로 싣지 못한 30개가 개수·바이트로 남아야 부모와 자식 합의 차액이 설명된다.
        assert_eq!(result.root.children.len(), FILE_NODES_PER_DIR);
        assert_eq!(result.root.truncated, 30);
        assert_eq!(result.root.truncated_bytes, 3000);
    }

    #[test]
    fn extension_map_folds_overflow_instead_of_growing() {
        let mut map: HashMap<String, (u64, u64)> = HashMap::new();
        for i in 0..(MAX_EXT_KEYS + 500) {
            bump_ext(&mut map, &format!("e{}", i), 10, 1);
        }
        // 상한 + 잔여 키 하나. 파일 수에 비례해 자라지 않는다.
        assert_eq!(map.len(), MAX_EXT_KEYS + 1);
        let rest = map.get(EXT_OVERFLOW_KEY).expect("잔여 항목이 있어야 한다");
        assert_eq!(rest.1, 500);
        // 접어 넣은 바이트가 사라지지 않아야 목록이 총량을 설명한다.
        let total: u64 = map.values().map(|v| v.0).sum();
        assert_eq!(total, (MAX_EXT_KEYS as u64 + 500) * 10);
    }

    #[test]
    fn extension_parsing_ignores_dotfiles() {
        assert_eq!(extension_of("archive.tar.GZ"), "gz");
        assert_eq!(extension_of(".gitignore"), "");
        assert_eq!(extension_of("Makefile"), "");
        assert_eq!(extension_of("trailing."), "");
        // 실제로 쓰이는 가장 긴 확장자는 살아남아야 한다.
        assert_eq!(extension_of("model.safetensors"), "safetensors");
        // 해시·날짜 접미사는 확장자가 아니다. 키로 삼으면 맵이 파일 수만큼 자란다.
        assert_eq!(extension_of("dump.a3f9c1e2b4d6a8c0f1"), "");
        assert_eq!(extension_of("backup.2024-01-17T10-15-30Z"), "");
    }

    #[test]
    fn prune_drops_small_children_and_counts_them() {
        let mut root = node("root", 1000);
        for i in 0..30 {
            root.children.push(node(&format!("small{}", i), 5));
        }
        for i in 0..5 {
            root.children.push(node(&format!("big{}", i), 100));
        }
        root.children.sort_unstable_by_key(|c| Reverse(c.size));

        prune(&mut root, 10, 0, 12, 80);

        assert_eq!(root.children.len(), 5);
        assert_eq!(root.truncated, 30);
        assert_eq!(root.truncated_small, 30);
        assert_eq!(root.truncated_bytes, 150);
        assert_eq!(root.truncated_reason, Some("size"));
    }

    #[test]
    fn prune_keeps_children_exactly_at_threshold() {
        let mut root = node("root", 100);
        root.children.push(node("exact", 10));
        root.children.push(node("below", 9));

        prune(&mut root, 10, 0, 12, 80);

        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].name, "exact");
        assert_eq!(root.truncated, 1);
    }

    #[test]
    fn prune_reports_child_cap_separately_from_small_share() {
        let mut root = node("root", 10_000);
        for i in 0..30 {
            root.children.push(node(&format!("small{}", i), 1));
        }
        for i in 0..100 {
            root.children.push(node(&format!("big{}", i), 50));
        }
        root.children.sort_unstable_by_key(|c| Reverse(c.size));

        prune(&mut root, 10, 0, 12, 80);

        assert_eq!(root.children.len(), 80);
        assert_eq!(root.truncated_small, 30);
        assert_eq!(root.truncated_capped, 20);
        assert_eq!(root.truncated, 50);
        assert_eq!(root.truncated_bytes, 30 + 20 * 50);
        // 표시 한도가 비중 과소보다 오도 위험이 크다.
        assert_eq!(root.truncated_reason, Some("count"));

        // 사유가 둘 이상인 것이 표준적인 경우다. 바이트를 합계 하나로만 보내면
        // 화면은 어느 줄에 붙일지 정하지 못해 차액을 아예 설명하지 못한다.
        assert_eq!(root.truncated_bytes_small, 30);
        assert_eq!(root.truncated_bytes_capped, 20 * 50);
        assert_eq!(root.truncated_bytes_deep, 0);
        assert_eq!(
            root.truncated_bytes_small + root.truncated_bytes_capped + root.truncated_bytes_deep,
            root.truncated_bytes
        );
    }

    #[test]
    fn prune_marks_depth_cut_with_its_own_reason() {
        let mut root = node("root", 1000);
        let mut deep = node("deep", 900);
        deep.children.push(node("hidden_a", 500));
        deep.children.push(node("hidden_b", 400));
        root.children.push(deep);

        // max_depth=1 이면 자식(depth 1)의 자식이 통째로 잘린다.
        prune(&mut root, 1, 0, 1, 80);

        let child = &root.children[0];
        assert!(child.children.is_empty());
        assert_eq!(child.truncated, 2);
        assert_eq!(child.truncated_deep, 2);
        assert_eq!(child.truncated_bytes, 900);
        assert_eq!(child.truncated_bytes_deep, 900);
        assert_eq!(child.truncated_reason, Some("depth"));
    }

    #[test]
    fn in_scan_prune_drops_only_what_final_prune_would_drop() {
        let mut root = node("root", 10_000);
        // 최종 임계(전체/2000)와 같은 규칙이므로 경계값은 살아남아야 한다.
        root.children.push(node("keep", 5));
        root.children.push(node("drop", 4));

        prune_in_place(&mut root, 0);

        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].name, "keep");
        assert_eq!(root.truncated_small, 1);
        assert_eq!(root.truncated_bytes, 4);
        // 자식을 버려도 부모 크기는 그대로다 — 집계 정확성은 보존된다.
        assert_eq!(root.size, 10_000);
    }

    #[test]
    fn in_scan_floor_follows_the_running_total() {
        let mut root = node("root", 100);
        root.children.push(node("child", 10));

        // 스캔이 진행돼 총량이 4만이면 임계가 20으로 올라간다.
        prune_in_place(&mut root, 40_000);

        assert!(root.children.is_empty());
        assert_eq!(root.truncated_small, 1);
    }

    #[test]
    fn recursion_stops_at_the_depth_limit() {
        let root = std::env::temp_dir().join(format!("discan_deep_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut path = root.clone();
        for _ in 0..(MAX_SCAN_DEPTH + 2) {
            path = path.join("d");
        }
        fs::create_dir_all(&path).unwrap();
        let fx = Fixture(root.clone());

        let progress = Progress::new();
        let result = scan(&fx.0, &progress, ScanOptions::default());

        // 스택 오버플로로 프로세스가 죽는 대신 오류로 계상되어야 한다.
        assert!(result.dir_errors >= 1);
        assert!(result.failed_paths.iter().any(|f| f.kind == "tooDeep"));
    }

    /// 하드 링크는 같은 실체를 링크 수만큼 계수한다 — `C:\Windows\WinSxS` 가 실제보다
    /// 몇 배 크게 잡히던 원인이다. 중복 제거를 켜면 두 번째 링크의 크기는 0이 되고,
    /// 개수는 그대로 남으며, 얼마를 뺐는지가 결과에 남아야 한다.
    #[cfg(windows)]
    #[test]
    fn hard_links_are_counted_once_and_the_difference_is_reported() {
        let root = std::env::temp_dir().join(format!("discan_hardlink_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("original.bin"), vec![b'x'; 8000]).unwrap();
        let linked = fs::hard_link(root.join("original.bin"), root.join("alias.bin")).is_ok();
        let fx = Fixture(root);

        if !linked {
            eprintln!(
                "[skip] hard_links_are_counted_once_and_the_difference_is_reported: \
                 임시 볼륨에서 하드 링크를 만들 수 없다"
            );
            return;
        }

        // 중복 제거를 끈 기준선. 파일시스템 이름이 비면 끄는 것이 기본 동작이다.
        let plain = scan(&fx.0, &Progress::new(), ScanOptions::default());
        assert_eq!(plain.dedup, "none");
        assert_eq!(plain.dedup_disabled_reason, "unstableFileIds");
        assert_eq!(
            plain.total_size, 16_000,
            "링크가 두 번 계수되어야 기준선이다"
        );
        assert_eq!(plain.hardlink_deduped_files, 0);

        let deduped = scan(
            &fx.0,
            &Progress::new(),
            ScanOptions {
                file_system: "NTFS".to_string(),
                volume_serial_num: 0x1234_5678,
                // 하한을 0으로 두어 픽스처 크기와 무관하게 판정이 실제로 돈다.
                hardlink_min_bytes: 0,
                ..Default::default()
            },
        );
        assert_eq!(deduped.dedup, "hardlink");
        assert_eq!(deduped.dedup_disabled_reason, "");
        assert_eq!(deduped.total_size, 8000, "같은 실체가 두 번 계수됐다");
        // 개수는 줄지 않는다 — 항목은 실재하므로 없는 것으로 만들면 안 된다.
        assert_eq!(deduped.total_files, 2);
        // 왜 탐색기와 숫자가 다른지 결과가 스스로 말해야 한다.
        assert_eq!(deduped.hardlink_deduped_files, 1);
        assert_eq!(deduped.hardlink_deduped_bytes, 8000);
        assert_eq!(deduped.dedup_min_bytes, 0);

        // 하한을 넘지 못하는 파일은 추적하지 않으므로 중복이 그대로 남는다.
        // 그 사실이 결과의 `dedupMinBytes` 로 나가야 '전량 제거'로 오인되지 않는다.
        let above_threshold = scan(
            &fx.0,
            &Progress::new(),
            ScanOptions {
                file_system: "NTFS".to_string(),
                hardlink_min_bytes: 1 << 20,
                ..Default::default()
            },
        );
        assert_eq!(above_threshold.total_size, 16_000);
        assert_eq!(above_threshold.hardlink_deduped_files, 0);
        assert_eq!(above_threshold.dedup_min_bytes, 1 << 20);
    }

    /// 디렉터리 열거는 커널 버퍼 하나로 끝나지 않는다 — 항목이 많으면
    /// `GetFileInformationByHandleEx` 를 여러 번 부르며 이어 붙인다. 픽스처가 전부
    /// 수십 개짜리면 그 이어 붙이기(재시작 클래스 오용·경계에서 항목 유실)는 한 줄도
    /// 검증되지 않은 채 남고, 실사용 디렉터리에서만 조용히 항목이 사라진다.
    #[test]
    fn enumeration_spans_multiple_kernel_buffers_without_losing_entries() {
        const FILES: usize = 700;
        // 이름을 길게 잡아 항목 하나가 차지하는 바이트를 늘린다(고정부 + 이름 × 2바이트).
        const PAD: &str = "n123456789n123456789n123456789n123456789n123456789n123456789";

        let root = std::env::temp_dir().join(format!("discan_manybuf_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        for i in 0..FILES {
            fs::write(root.join(format!("{}_{:04}.bin", PAD, i)), b"xyz").unwrap();
        }
        let fx = Fixture(root);

        let result = scan(&fx.0, &Progress::new(), ScanOptions::default());

        assert_eq!(result.total_files, FILES as u64, "열거에서 항목이 유실됐다");
        assert_eq!(result.total_size, FILES as u64 * 3);
        assert_eq!(result.errors, 0);
    }

    /// FAT32·exFAT 은 파일 ID 가 안정적이지 않다. 그 위에서 중복 제거를 켜면
    /// 서로 다른 파일이 한 실체로 뭉쳐 실재하는 용량이 조용히 사라진다.
    #[test]
    fn dedup_is_disabled_where_file_ids_are_not_stable() {
        assert_eq!(dedup_disabled_reason("FAT32"), "unstableFileIds");
        assert_eq!(dedup_disabled_reason("exFAT"), "unstableFileIds");
        // 파일시스템을 못 읽었을 때도 끈다. 과다 계수는 알려진 한계지만,
        // 잘못된 중복 제거는 없는 사실을 단정하는 것이라 더 나쁘다.
        assert_eq!(dedup_disabled_reason(""), "unstableFileIds");

        if cfg!(windows) {
            assert_eq!(dedup_disabled_reason("NTFS"), "");
            assert_eq!(dedup_disabled_reason("ntfs"), "");
            assert_eq!(dedup_disabled_reason("ReFS"), "");
        } else {
            // 디렉터리 열거가 파일 ID 를 주지 않는 플랫폼에서는 이유가 다르다.
            assert_eq!(dedup_disabled_reason("NTFS"), "unsupportedPlatform");
        }
    }

    /// 하드 링크 판정 색인은 무한히 자라지 않는다. 다른 모든 축이 자기-DoS 를 막으려
    /// 상한을 둔 것과 같은 방어다. 상한에 닿으면 새 실체는 담지 않되, **이미 담긴
    /// 실체의 중복 판정은 그대로 유지**되어야 한다 — 그러지 않으면 상한 도달이 곧
    /// '없는 용량 삭제'가 된다.
    #[test]
    fn seen_id_index_is_bounded_and_still_dedups_known_ids() {
        let progress = Progress::new();
        let ctx = ScanCtx::new(&progress, &ScanOptions::default());

        // 32 의 배수 ID 는 모두 샤드 0 이라, 한 샤드만으로 상한을 실제로 관측한다.
        let early = 32u64; // 상한에 닿기 전에 담기는 실체
        assert!(ctx.mark_file_id(early), "처음 본 실체는 true 여야 한다");
        // 상한이 찰 때까지 서로 다른 실체로 채운다(early 포함 정확히 상한만큼).
        for i in 1..MAX_IDS_PER_SHARD {
            ctx.mark_file_id((i as u64 + 1) * 32);
        }
        assert_eq!(
            ctx.seen_ids[0].lock().unwrap().len(),
            MAX_IDS_PER_SHARD,
            "샤드가 상한까지 찼어야 한다"
        );

        // 상한에 닿은 뒤 **새** 실체는 담기지 않고 '처음 본 것'으로 취급된다
        // (과다 계수 방향 — 없는 용량을 지우지 않는다).
        let over = 12_345_678u64 * 32;
        assert!(
            ctx.mark_file_id(over),
            "상한 뒤 새 실체는 처음 본 것으로 취급"
        );
        assert_eq!(
            ctx.seen_ids[0].lock().unwrap().len(),
            MAX_IDS_PER_SHARD,
            "상한 뒤에는 색인이 더 자라지 않아야 한다"
        );

        // 그러나 이미 담긴 실체의 중복 판정은 상한 뒤에도 유지된다.
        assert!(
            !ctx.mark_file_id(early),
            "이미 본 실체는 상한 뒤에도 중복(false)으로 판정되어야 한다"
        );
    }

    /// 전역 상위 30개만으로는 '기타'를 분해할 수 없다. 미분류의 전형은 중간 크기
    /// 확장자 수백 종의 롱테일이라 개별 확장자가 전역 상위에 하나도 들지 못한다.
    #[test]
    fn other_extensions_are_listed_separately_from_the_global_top() {
        let root = std::env::temp_dir().join(format!("discan_otherext_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 전역 상위를 독식하는 분류된 파일 하나.
        fs::write(root.join("big.mp4"), vec![b'x'; 100_000]).unwrap();
        // 미분류 롱테일.
        for i in 0..5 {
            fs::write(root.join(format!("f{}.zzz{}", i, i)), vec![b'x'; 100 + i]).unwrap();
        }
        let fx = Fixture(root);

        let result = scan(&fx.0, &Progress::new(), ScanOptions::default());

        // 전역 목록의 1위는 여전히 mp4 다.
        assert_eq!(result.extensions[0].ext, "mp4");
        // 그런데 '기타' 축은 그것과 무관하게 자기 목록을 가진다.
        assert!(!result.other_extensions.is_empty());
        assert!(
            result
                .other_extensions
                .iter()
                .all(|e| e.category == Category::Other.key()),
            "'기타' 목록에 이미 분류된 확장자가 섞였다"
        );
        assert!(result.other_extensions.iter().any(|e| e.ext == "zzz0"));
        // 합계는 미분류 전량을 설명해야 한다(5개 × 100..104 바이트).
        let total: u64 = result.other_extensions.iter().map(|e| e.size).sum();
        assert_eq!(total, 100 + 101 + 102 + 103 + 104);
    }

    /// 잔여 항목 줄은 **하나**여야 하고, 접어 넣은 종수를 함께 실어야 그 덩어리가
    /// '소수 대형'인지 '롱테일'인지 판별할 수 있다.
    #[test]
    fn folding_yields_one_overflow_row_carrying_the_folded_kind_count() {
        let stat = |ext: &str, size: u64| ExtStat {
            ext: ext.to_string(),
            size,
            files: 1,
            category: Category::Other.key(),
            kinds: 1,
        };

        let folded = fold_extensions(
            vec![stat("a", 100), stat("b", 90), stat("c", 80), stat("d", 70)],
            2,
        );
        assert_eq!(folded.len(), 3);
        assert_eq!(folded[2].ext, EXT_OVERFLOW_KEY);
        assert_eq!(folded[2].size, 150);
        assert_eq!(folded[2].files, 2);
        assert_eq!(folded[2].kinds, 2, "접어 넣은 종수를 잃었다");

        // 맵 키 상한에 걸려 이미 접힌 행이 섞여 있어도 잔여 줄은 하나여야 한다 —
        // 같은 키가 두 번 나오면 그것을 조인 키로 쓰는 화면이 조용히 깨진다.
        let with_existing = fold_extensions(
            vec![
                stat("a", 100),
                ExtStat {
                    kinds: 7,
                    ..stat(EXT_OVERFLOW_KEY, 90)
                },
                stat("c", 80),
            ],
            1,
        );
        assert_eq!(
            with_existing
                .iter()
                .filter(|e| e.ext == EXT_OVERFLOW_KEY)
                .count(),
            1
        );
        let rest = with_existing.last().unwrap();
        assert_eq!(rest.size, 170);
        assert_eq!(rest.kinds, 8);

        // 접을 것이 없으면 잔여 줄을 만들지 않는다(빈 줄은 '나머지가 있다'는 거짓말이다).
        assert_eq!(fold_extensions(vec![stat("a", 1)], 30).len(), 1);
    }

    /// 표시 경로가 원본과 다르면 그 문자열로는 파일을 다시 열 수 없다.
    /// 프런트가 실패가 예정된 어포던스를 주지 않으려면 사실이 실려 와야 한다.
    #[test]
    fn lossy_paths_are_flagged() {
        assert!(!is_lossy(std::ffi::OsStr::new(r"C:\정상\경로.txt")));

        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            // 짝 없는 상위 서로게이트. NTFS 에서 생성 가능하고 일부 도구가 실제로 만든다.
            let broken = std::ffi::OsString::from_wide(&[0x0044, 0xD800, 0x005C]);
            assert!(is_lossy(&broken));
            assert!(broken.to_string_lossy().contains('\u{FFFD}'));
        }
    }

    /// 정상 경로에서는 이 플래그가 서면 안 된다 — 서면 프런트가 모든 행의
    /// 열기·복사를 잠가 버린다.
    #[test]
    fn normal_paths_are_not_flagged_as_lossy() {
        let fx = fixture("lossyflag");
        let result = scan(&fx.0, &Progress::new(), ScanOptions::default());
        assert!(!result.root.lossy_path);
        assert!(result.largest_files.iter().all(|f| !f.lossy_path));
        assert!(result.root.children.iter().all(|c| !c.lossy_path));
    }

    /// 볼륨 메타데이터와 세대 번호는 **입력**이다. 자리표시자로 채워 돌려주고
    /// 호출자가 나중에 덮어쓰면, 그 필드를 읽는 코드가 언제부터 신뢰 가능한지
    /// 시그니처만으로는 알 수 없다.
    #[test]
    fn volume_metadata_and_scan_id_come_from_the_options() {
        let fx = fixture("volmeta");
        let result = scan(
            &fx.0,
            &Progress::new(),
            ScanOptions {
                file_system: "NTFS".to_string(),
                volume_serial: "DEAD-BEEF".to_string(),
                scan_id: 42,
                ..Default::default()
            },
        );
        assert_eq!(result.file_system, "NTFS");
        assert_eq!(result.volume_serial, "DEAD-BEEF");
        assert_eq!(result.scan_id, 42);
    }

    /// 폭이 넓고 깊은 트리.
    ///
    /// `scan_dir` 은 `par_iter().collect()` 안에서 자기를 다시 부르고, 그 collect 를
    /// 기다리는 워커는 무관한 작업을 훔쳐 **같은 스택 위에서** 실행한다. 따라서 한
    /// 워커의 스택에는 독립적인 재귀 사슬이 여러 개 겹쳐 쌓일 수 있고, 최악은
    /// `훔친 횟수 × MAX_SCAN_DEPTH` 다 — `SCAN_STACK_BYTES` 예약과 깊이 상한은 완화이지
    /// 상한이 아니다(모듈 상단 주석 참조). 스택 오버플로는 Windows 에서 언와인딩 없이
    /// 프로세스를 죽이므로, 겹침을 실제로 유발하는 형태를 한 번은 돌려 둔다.
    /// 디버그 빌드 프레임이 가장 크므로 `cargo test` 경로가 가장 얇다.
    ///
    /// 근본 해결(자식 디렉터리를 명시적 워크리스트로 돌려 재귀 자체를 없애기)은
    /// 별개 과제다. 이 테스트는 그것을 대신하지 못하며, 회귀를 조기에 드러낼 뿐이다.
    #[test]
    fn a_wide_and_deep_tree_survives_stolen_work_stacking() {
        const CHAINS: usize = 16;
        const DEPTH: usize = 100;

        let root = std::env::temp_dir().join(format!("discan_widedeep_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // 사슬 하나하나가 깊고, 사슬이 여러 개라 워커가 서로의 작업을 훔친다.
        for c in 0..CHAINS {
            let mut path = root.join(format!("c{:02}", c));
            for d in 0..DEPTH {
                path = path.join(format!("d{:02}", d));
            }
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("leaf.bin"), b"x").unwrap();
        }
        let fx = Fixture(root);

        let result = scan(&fx.0, &Progress::new(), ScanOptions::default());

        // 깊이 상한(128) 안이므로 전부 도달해야 한다. 하나라도 빠지면 상한·스택
        // 어느 쪽이 걸렸는지부터 확인할 것.
        assert_eq!(result.total_files, CHAINS as u64);
        assert_eq!(result.total_dirs, (CHAINS * (DEPTH + 1)) as u64);
        assert_eq!(result.errors, 0);
    }

    #[test]
    fn timestamp_is_rfc3339_utc() {
        let epoch = std::time::UNIX_EPOCH;
        assert_eq!(rfc3339_utc(epoch), "1970-01-01T00:00:00Z");
        let later = epoch + std::time::Duration::from_secs(1_700_000_000);
        assert_eq!(rfc3339_utc(later), "2023-11-14T22:13:20Z");
    }
}
