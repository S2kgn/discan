/**
 * 커맨드 오류. Rust `CommandError` 와 1:1.
 *
 * Tauri 2 의 invoke 는 `Err(E)` 를 **직렬화된 객체 그대로** reject 한다. 예전에는
 * 이것을 `String(e)` 로 받아 모든 오류가 "[object Object]" 가 되었고, 백엔드가
 * 문구 드리프트를 막으려고 도입한 `code` 축이 한 곳에서도 읽히지 않았다.
 */
export interface CommandError {
  /** 안정 식별자. 화면 문구는 이 값으로만 고른다(errors.ts). */
  code: string;
  /** 문제가 된 경로 등 코드만으로는 알 수 없는 보조 정보. */
  detail: string;
  /** 프런트 사전에 없는 코드가 왔을 때의 최후 폴백. */
  message: string;
}

/**
 * IPC 경계에서 오류를 정규화한다.
 *
 * 문자열로 reject 하는 구버전 백엔드·플러그인 오류도 같은 모양으로 만들어,
 * 화면 코드가 `typeof` 분기를 다시 하지 않아도 되게 한다.
 */
export function toCommandError(e: unknown): CommandError {
  if (e && typeof e === "object") {
    const o = e as Partial<CommandError>;
    if (typeof o.code === "string" && o.code !== "") {
      return {
        code: o.code,
        detail: typeof o.detail === "string" ? o.detail : "",
        message: typeof o.message === "string" ? o.message : "",
      };
    }
    // code 가 없는 객체를 String() 하면 "[object Object]" 가 된다. 원문을 살린다.
    if (typeof o.message === "string" && o.message !== "") {
      return { code: "unknown", detail: "", message: o.message };
    }
    try {
      return { code: "unknown", detail: "", message: JSON.stringify(e) };
    } catch {
      return { code: "unknown", detail: "", message: "알 수 없는 오류" };
    }
  }
  return { code: "unknown", detail: "", message: String(e ?? "") };
}

export interface ScanNode {
  name: string;
  path: string;
  size: number;
  files: number;
  /**
   * 디렉터리면 true. 백엔드 `Node.is_dir` 과 1:1이며 늘 실려 온다 —
   * 프런트와 백엔드가 같은 번들로 배포되므로 '필드가 없는 구버전'은 존재하지 않는다.
   */
  isDir: boolean;
  children: ScanNode[];
  /** 가지치기로 잘려나간 자식 수. 0보다 크면 트리가 일부 생략되었다. */
  truncated: number;
  /** 잘려나간 자식들의 합계 크기(백엔드 `truncatedBytes`). */
  truncatedBytes?: number;
  /** 생략 사유. 백엔드가 보내는 값은 "depth" | "count" | "size" 셋뿐이다. */
  truncatedReason?: string;
  /**
   * 사유별 생략 개수. 대표 사유 하나에 총합을 붙이면 'small 30 + capped 20' 노드가
   * '표시 한도로 50개 생략'이 되어 사실과 다른 문장이 된다.
   */
  truncatedSmall?: number;
  truncatedCapped?: number;
  truncatedDeep?: number;
  /**
   * 사유별 생략 바이트. 백엔드가 아직 나눠 보내지 않으면 없다 — 그 경우
   * 사유가 둘 이상인 노드에서는 합계를 마지막 줄에 따로 적는다(TreeView).
   */
  truncatedBytesSmall?: number;
  truncatedBytesCapped?: number;
  truncatedBytesDeep?: number;
  /** 취소·오류·깊이 상한으로 하위 집계가 끝나지 못한 노드. 표시 용량은 하한값이다. */
  incomplete?: boolean;
  /**
   * 표시 경로가 원본과 다르다(백엔드 `Node::lossy_path`).
   *
   * UTF-16 으로 유효하지 않은 이름(짝 없는 서로게이트)은 NTFS 에서 생성 가능하고
   * `to_string_lossy()` 가 U+FFFD 로 치환한다. 그 문자열로 탐색기를 열면 실패하고,
   * 폴백이 '경로를 복사했습니다'를 알려도 복사된 것은 원본과 다른 경로라 붙여
   * 넣어도 열리지 않는다 — 조용한 오차가 남는 유일한 데이터 경로였다.
   */
  lossyPath?: boolean;
}

/** 생략 사유를 세 갈래로 정규화한 값. */
export type TruncateReason = "smallShare" | "depthLimit" | "childCap";

/**
 * 백엔드 `note_truncated` 가 쓰는 세 값만 매핑한다.
 *
 * 예전에는 "depth"/"depthLimit"/"max_depth" 세 표기를 모두 받아들이는 느슨한
 * 정규화였는데, 계약이 하나로 확정된 뒤에도 그대로 두면 다음 드리프트(백엔드가
 * 넷째 사유를 추가하는 경우)가 조용히 smallShare 로 떨어져 '용량이 작아 생략'이라는
 * 거짓 문장이 된다. 모르는 값은 개발 모드에서 소리를 내게 한다.
 */
export function truncateReasonOf(node: ScanNode): TruncateReason {
  switch (node.truncatedReason) {
    case "depth":
      return "depthLimit";
    case "count":
      return "childCap";
    case "size":
    case undefined:
      return "smallShare";
    default:
      if (import.meta.env.DEV) {
        console.warn(
          `[discan] 알 수 없는 생략 사유: ${node.truncatedReason} — types.ts 를 갱신하십시오.`,
        );
      }
      return "smallShare";
  }
}

export function truncatedBytesOf(node: ScanNode): number {
  return node.truncatedBytes ?? 0;
}

/** 생략 사유 한 갈래. 화면에 한 줄씩 따로 그린다. */
export interface TruncatePart {
  reason: TruncateReason;
  count: number;
  /** 이 사유로 빠진 바이트. 백엔드가 사유별로 나눠 보내지 않으면 0. */
  bytes: number;
}

/**
 * 사유별 생략 개수를 분해한다.
 *
 * 바이트는 백엔드가 사유별로 실어 보낼 때만 나눈다 — 합계 바이트를 세 갈래에
 * 임의로 나눠 붙이면 근사치도 아닌 오기가 된다. 사유별 필드가 없는 구버전
 * 페이로드에서는 대표 사유 하나에 총합을 싣던 기존 동작으로 떨어진다.
 */
export function truncateParts(node: ScanNode): TruncatePart[] {
  const small = node.truncatedSmall ?? 0;
  const capped = node.truncatedCapped ?? 0;
  const deep = node.truncatedDeep ?? 0;
  if (small + capped + deep === 0) {
    return node.truncated > 0
      ? [{ reason: truncateReasonOf(node), count: node.truncated, bytes: truncatedBytesOf(node) }]
      : [];
  }
  // 깊이 절단이 정보 손실이 가장 크므로 먼저 읽히게 둔다.
  const parts: TruncatePart[] = [
    { reason: "depthLimit" as const, count: deep, bytes: node.truncatedBytesDeep ?? 0 },
    { reason: "childCap" as const, count: capped, bytes: node.truncatedBytesCapped ?? 0 },
    { reason: "smallShare" as const, count: small, bytes: node.truncatedBytesSmall ?? 0 },
  ];
  const filtered = parts.filter((p) => p.count > 0);
  // 사유가 하나뿐이면 사유별 바이트가 없어도 총합이 곧 그 사유의 몫이다.
  if (filtered.length === 1 && filtered[0].bytes === 0) {
    filtered[0] = { ...filtered[0], bytes: truncatedBytesOf(node) };
  }
  return filtered;
}

/** 사유별 바이트 합계가 총합을 설명하지 못하고 남긴 차액. 0이면 설명이 완결됐다. */
export function unexplainedTruncatedBytes(node: ScanNode): number {
  const total = truncatedBytesOf(node);
  const explained = truncateParts(node).reduce((sum, p) => sum + p.bytes, 0);
  return Math.max(0, total - explained);
}

/** 파일 노드인지. 계약이 `isDir: boolean` 로 확정되어 판정이 한 줄로 끝난다. */
export function isFileNode(node: ScanNode): boolean {
  return !node.isDir;
}

export interface LargeFile {
  name: string;
  path: string;
  size: number;
  /** 분야 키. 목록을 분야 색으로 칠하거나 시스템 파일을 가려낼 때 쓴다. */
  category?: string;
  /** `ScanNode.lossyPath` 와 같은 의미. 열기·복사가 원본과 다른 경로를 쓰게 된다. */
  lossyPath?: boolean;
}

export interface CategoryStat {
  key: string;
  /** 백엔드가 주는 표시 문자열. 프런트 사전(CATEGORY_LABELS)이 우선한다. */
  label?: string;
  size: number;
  files: number;
  /** 백엔드가 색을 실어 보내면 그것을 쓴다(팔레트 드리프트 방지). */
  color?: string;
}

/** 확장자 단위 집계. '기타'가 무엇으로 채워졌는지 분해하는 유일한 근거다. */
export interface ExtStat {
  /** 확장자(점 없음). 특수 행은 아래 센티널 두 개 중 하나다. */
  ext: string;
  size: number;
  files: number;
  /**
   * 이 확장자가 속한 분야 키. 백엔드가 실어 보내면 분야 ↔ 확장자 교차가 가능해진다
   * (없으면 확장자 축은 전체 집합에 대한 독립 집계로만 동작한다).
   */
  category?: string;
  /**
   * 이 행이 대표하는 서로 다른 확장자 종수. 보통 1이고 `__overflow` 행에서만 커진다.
   *
   * 종수가 없으면 '그 밖의 확장자 1.5 GiB' 한 줄이 소수의 대형 파일인지 롱테일인지
   * 구분되지 않아, 분해하려던 사용자가 같은 자리에서 다시 막힌다.
   */
  kinds?: number;
}

/**
 * 백엔드가 쓰는 특수 확장자 행(scan.rs 의 `EXT_OVERFLOW_KEY`·`EXT_NONE_KEY`).
 *
 * ASCII 센티널 하나씩만 둔다 — 표시 문구는 `extLabel()` 이 고르고, 데이터 열(내보내기
 * CSV 의 ext)에는 이 값이 그대로 나가야 하류 파이프라인이 한국어 리터럴을
 * 하드코딩하지 않는다. 예전에는 한국어 표기도 함께 받아들여, 어느 쪽이 계약인지
 * 다음 사람이 판단할 근거가 없었다.
 */
export const EXT_OVERFLOW_KEY = "__overflow";
export const EXT_NONE_KEY = "__none";
/** 상위 목록에 없는 나머지를 내보내기에서 가리키는 키. 화면에는 쓰지 않는다. */
export const EXT_RESIDUAL_KEY = "__residual";

/** 상위 목록에 실린 개별 확장자인지. 잔여 합산 행은 개수에서 빼야 문구가 맞는다. */
export function isExtOverflowRow(ext: string): boolean {
  return ext === EXT_OVERFLOW_KEY;
}

/** 확장자 행의 표시 이름. 센티널은 프런트 문구로 바꿔 준다. */
export function extLabel(ext: string): string {
  if (ext === EXT_OVERFLOW_KEY) return "그 밖의 확장자";
  if (ext === EXT_NONE_KEY) return "확장자 없음";
  if (ext === EXT_RESIDUAL_KEY) return "상위 목록 외 나머지";
  return ext;
}

/**
 * 읽기 실패 사유. '권한 등'으로 뭉치면 tooLong·tooDeep 사용자가 헛수고를 한다.
 *
 * scan.rs 의 `error_kind`·`record_failure` 가 만드는 값 집합과 같아야 한다 —
 * 어긋나면 한국어 UI 한복판에 영문 키가 찍히고 처방이 '원인을 특정하지 못했습니다'로
 * 되돌아간다. contract.test.ts 가 Rust 원본과 이 유니온을 대조한다.
 */
export type FailedKind =
  | "denied"
  | "notFound"
  | "tooLong"
  | "tooDeep"
  | "notReady"
  | "locked"
  | "other";

export interface FailedPath {
  path: string;
  kind: FailedKind;
}

export interface PruneParams {
  minSize: number;
  maxDepth: number;
  maxChildren: number;
}

/**
 * 백엔드 `scan::ScanResult` 의 직렬화 필드와 1:1로 맞춘다.
 *
 * 손으로 미러링하는 구조라 드리프트가 컴파일 오류로 잡히지 않는다. 그래서
 * 새 필드는 모두 optional 로 두고(구버전 백엔드와도 붙는다), 키 집합이 어긋나면
 * 테스트(types.test.ts)에서 드러나게 했다. 근본 해결은 ts-rs/specta 도입이지만
 * 그것은 Rust 쪽 빌드 파이프라인을 건드려야 한다.
 */
export interface ScanResult {
  root: ScanNode;
  categories: CategoryStat[];
  /** 디렉터리 힌트를 무시한 순수 확장자 기반 분류. '캐시 7GB'의 내부를 되돌려 본다. */
  contentCategories?: CategoryStat[];
  /** 용량 상위 확장자(백엔드가 30개로 자른다). */
  extensions?: ExtStat[];
  /**
   * 분야가 `other` 인 확장자만 따로 뽑은 상위 목록.
   *
   * 전역 상위 30개만 있으면 '기타'로 좁혔을 때 남는 것이 `__none`·`__overflow` 뿐이라
   * '기타 1.65 GiB → 그 밖의 확장자 1.5 GiB' 라는 동어반복에 도달한다. 미분류가 큰
   * 디스크는 '중간 크기 확장자 수백 종의 롱테일'이라 개별 확장자가 전역 상위 30에
   * 하나도 들지 못하기 때문이다.
   */
  otherExtensions?: ExtStat[];
  totalSize: number;
  totalFiles: number;
  totalDirs: number;
  errors: number;
  /** 디렉터리 단위 실패. 하나당 서브트리가 통째로 빠진다. */
  dirErrors?: number;
  /** 파일 하나 단위 실패. */
  fileErrors?: number;
  /** 실패 경로 표본(백엔드 상한 500건). 감사 추적의 근거다. */
  failedPaths?: FailedPath[];
  /** 기록을 시도한 실패 경로 총수. failedPaths.length 와 다르면 목록이 잘렸다. */
  failedPathsTotal?: number;
  /** 잘린 목록을 전량으로 오인하면 감사 결론이 뒤집힌다. */
  failedPathsTruncated?: boolean;
  elapsedMs: number;
  cancelled: boolean;
  /** 용량 상위 파일. 백엔드가 수집하면 채워진다. */
  largestFiles?: LargeFile[];
  /** 순환·중복 계수를 피해 건너뛴 정션·심볼릭 링크 수. */
  skippedLinks?: number;
  /** 로컬에 내용이 없는 클라우드 자리표시자 수와 그 논리 크기. */
  skippedCloud?: number;
  skippedCloudBytes?: number;
  /** 볼륨 클러스터 크기. 0이면 미상. */
  clusterBytes?: number;
  fileSystem?: string;
  /** 볼륨 고유 식별자. 화면에는 쓰지 않고 감사 옵션에만 싣는다. */
  volumeSerial?: string;
  /**
   * 디스크 점유량. 산출 방식은 allocBasis 가 말한다 — Windows 에서는 파일시스템이
   * 항목마다 보고한 할당 바이트의 합이고, 그 밖에서는 클러스터 올림의 누적이다.
   * 어느 쪽도 산출하지 못하면 0이고 그때 allocBasis 는 "unknown".
   */
  allocatedEstimate?: number;
  /**
   * 위 값의 산출 방식. "allocationSize" | "clusterRoundUp" | "unknown".
   *
   * Windows 에서는 **항상 "allocationSize"** 다(파일시스템의 셈 그대로라 근사가
   * 아니다). "clusterRoundUp" 은 비 Windows 폴백이다. 이 값을 화면에서 직접
   * 비교하지 말고 notice.ts 의 `allocBasisOf()` 를 쓸 것 — 값이 하나 늘었을 때
   * 세 곳의 `=== "clusterRoundUp"` 비교가 동시에 거짓이 되어 할당량 안내가
   * 조용히 사라진 전례가 있다.
   */
  allocBasis?: string;
  /**
   * 상승된(관리자) 토큰으로 스캔했는지. 같은 볼륨도 권한에 따라 총량이 GB 단위로
   * 달라지므로, 두 스냅샷의 차이를 소명할 1차 설명 변수로 화면·내보내기에 싣는다.
   */
  elevated?: boolean;
  /** 집계 기준. 지금은 "logical" 뿐이라 화면에 그대로 고지한다. */
  sizeBasis?: string;
  /**
   * 중복 제거 수준. "hardlink" | "none".
   *
   * NTFS·ReFS 에서는 "hardlink" 가 기본이며, (볼륨 시리얼, 파일 ID)가 같은 두 번째
   * 이후 항목의 크기를 0으로 계산한다. "none" 이면 하드링크 공유 파일이 각각 계수된다.
   * dedupMinBytes 미만 파일은 추적하지 않으므로 "hardlink" 도 '전량 제거'가 아니다.
   */
  dedup?: string;
  /**
   * `dedup === "none"` 인 이유. "" | "unstableFileIds" | "unsupportedPlatform".
   * 껐다는 사실만 남기고 이유를 남기지 않으면 사용자는 그것을 버그로 읽는다.
   */
  dedupDisabledReason?: string;
  /**
   * 하드링크 추적 하한(바이트). 이 값 미만 파일의 중복은 잡히지 않으므로,
   * 없으면 '중복 제거했다'가 전량으로 오인된다. 0이면 전부 추적했다는 뜻이다.
   */
  dedupMinBytes?: number;
  /** 하드링크 중복으로 판정해 크기를 0으로 센 파일 수와 그 논리 바이트. */
  hardlinkDedupedFiles?: number;
  hardlinkDedupedBytes?: number;
  /**
   * 할당 크기를 단정할 수 없는 파일 수와 그 할당 바이트(NTFS 압축·희소 파일).
   * 화면이 '점유는 +N' 을 얼마나 강하게 말해도 되는지의 근거다.
   */
  allocUncertainFiles?: number;
  allocUncertainBytes?: number;
  /** 스냅샷 시각(RFC3339, UTC). */
  startedAt?: string;
  appVersion?: string;
  rootPath?: string;
  /** 이 결과를 만든 스캔의 세대 번호. 취소 명령이 대상을 지목할 때 쓴다. */
  scanId?: number;
  /** 적용된 가지치기 임계값. 감사 가능하도록 화면에 노출한다. */
  pruneParams?: PruneParams;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  /** 지금 읽고 있는 디렉터리. 백엔드가 실어 보내면 표시한다. */
  currentPath?: string;
  skippedLinks?: number;
  /** 스캔 세대. 취소 지목과 이전 스캔의 잔여 이벤트 필터링에 쓴다. */
  scanId?: number;
}

/** `GetDriveTypeW` 의 결과를 그대로 받는다. */
export type DriveType = "fixed" | "removable" | "remote" | "cdrom" | "ram" | "unknown";

export interface DriveInfo {
  path: string;
  label: string;
  total: number;
  free: number;
  /** 쿼터가 걸린 볼륨에서는 free 보다 작다. */
  availableToCaller?: number;
  driveType?: DriveType;
  /** 용량 조회 실패 시 GetLastError 값. 0이면 정상. */
  errorCode?: number;
}

/**
 * 백엔드가 스캔을 거부하는 드라이브인지. 실패가 예정된 어포던스를 주지 않기 위해
 * 카드 단계에서 먼저 막는다(원격 드라이브는 stat 한 번이 곧 자격증명 전송이다).
 */
export function driveBlockedReason(drive: DriveInfo): string | null {
  if (drive.driveType === "remote") return "네트워크 드라이브 — 분석 대상이 아닙니다";
  if (drive.driveType === "cdrom" && drive.total === 0) return "디스크 없음";
  if (drive.driveType === "removable" && drive.total === 0) return "미디어 없음";
  if ((drive.errorCode ?? 0) !== 0) return `용량을 읽지 못했습니다 (코드 ${drive.errorCode})`;
  if (drive.total === 0) return "용량을 확인할 수 없습니다";
  return null;
}

/**
 * Rust `Category::ALL` 과 같은 키 목록.
 *
 * 색·라벨 사전이 이 목록을 빠짐없이 덮는지 테스트가 확인한다. 예전에는 개수를
 * 손으로 적어 두었는데(`toHaveLength(13)`), 백엔드에 dataset 이 추가됐을 때
 * 그 단언이 오히려 누락 상태를 고정했다.
 */
export const CATEGORY_KEYS = [
  "video",
  "image",
  "audio",
  "document",
  "archive",
  "code",
  "executable",
  "game",
  "cache",
  "database",
  "dataset",
  "font",
  "diskimage",
  "other",
] as const;

/**
 * 분야별 색. Rust 쪽 Category::key() 와 키가 일치해야 한다.
 *
 * 인접 색 대비를 기준으로 골랐다 — 정렬이 크기 내림차순이라 어느 두 색이 붙을지
 * 예측할 수 없고, 실사용 디스크에서는 cache 와 other 가 거의 항상 1·2위로 붙는다.
 * 그래서 other 만 무채색으로 남기고 cache 에는 유채색을 줬다(지워도 되는 것이라는
 * 행동 의미도 함께 실린다). 같은 계열끼리는 명도를 한 단계씩 벌려 둔다.
 *
 * 다만 전체 쌍이 3:1 을 넘지는 않는다(세그먼트 사이 1px 분리선이 그 몫을 한다).
 * 실제 미달 쌍 수는 color.test.ts 가 기록해 두므로 팔레트를 손볼 때 확인할 것.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  video: "#ff6b7a",
  diskimage: "#77380f",
  image: "#f2994a",
  audio: "#6b5400",
  document: "#7fc0ff",
  executable: "#2a4fae",
  archive: "#c49bf5",
  font: "#6b3fa0",
  code: "#4fe0a5",
  database: "#0d6b66",
  dataset: "#8fb339",
  cache: "#4ec9d4",
  other: "#4a5464",
  game: "#eb5fc0",
};

/**
 * 표시 이름은 프런트에서 관리한다. 백엔드 label 에 의존하면 언어를 추가할 때마다
 * Rust 재빌드가 필요해진다(key 는 안정 식별자이므로 그것만 받으면 충분하다).
 */
export const CATEGORY_LABELS: Record<string, string> = {
  video: "영상",
  image: "이미지",
  audio: "음악",
  document: "문서",
  executable: "실행 파일",
  archive: "압축",
  font: "글꼴",
  game: "게임",
  code: "코드",
  database: "데이터베이스",
  dataset: "모델·데이터셋",
  diskimage: "디스크 이미지",
  cache: "캐시·빌드 산출물",
  other: "기타",
};

/** 지워도 되는지 오해를 부르는 분야에 다는 주의 문구. */
export const CATEGORY_WARNINGS: Record<string, string> = {
  cache:
    ".git 이력·가상환경·시스템 캐시가 함께 잡힙니다. 캐시라고 모두 지워도 되는 것은 아닙니다.",
};

export function categoryLabel(stat: CategoryStat): string {
  const known = CATEGORY_LABELS[stat.key];
  if (known) return known;
  // 사전에 없으면 Rust 한국어 문자열이 UI로 새어 나온다. 색과 같은 방어를 건다.
  if (import.meta.env.DEV) {
    console.warn(`[discan] 라벨이 정의되지 않은 분야 키: ${stat.key} — types.ts 를 갱신하십시오.`);
  }
  return stat.label ?? stat.key;
}

export function categoryColor(stat: CategoryStat): string {
  if (stat.color) return stat.color;
  const known = CATEGORY_COLORS[stat.key];
  if (known) return known;
  // 새 분야가 조용히 '기타'와 같은 회색으로 떨어지는 것을 개발 중에 잡는다.
  if (import.meta.env.DEV) {
    console.warn(`[discan] 색이 정의되지 않은 분야 키: ${stat.key} — types.ts 를 갱신하십시오.`);
  }
  return CATEGORY_COLORS.other;
}
