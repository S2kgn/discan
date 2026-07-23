import { FailedKind, FailedPath, ScanResult } from "../types";
import { formatBytes, formatCount, formatPercent, percent } from "./format";

/**
 * 결과 안내 문구를 만드는 순수 함수들.
 *
 * 컴포넌트 안에 두면 '오류 0건 + 클라우드 자리표시자 4만 건' 같은 조합을 검증할
 * 방법이 없다. 이전 라운드에서 지적된 문구·데이터 불일치가 전부 조건 분기에서
 * 나왔으므로, 분기를 렌더에서 떼어 테스트로 잠근다.
 */

export const FAILED_KIND_LABELS: Record<FailedKind, string> = {
  denied: "권한 거부",
  notFound: "스캔 중 사라짐",
  tooLong: "경로 길이 초과",
  tooDeep: "깊이 상한 초과",
  notReady: "드라이브 준비 안 됨",
  locked: "다른 프로그램이 사용 중",
  other: "기타 오류",
};

/**
 * 사유별 처방. 관리자 권한 재실행이 소용없는 갈래에는 그 안내를 붙이지 않는다.
 *
 * denied 에는 상승 실행의 조건을 함께 적는다 — 기본 빌드 산출물은 서명되지 않으므로,
 * 이 안내를 그대로 따르면 사용자의 행동 순서가 '알 수 없는 게시자 경고를 무시하고
 * 설치 → 디스크 전체를 읽는 도구를 관리자 권한으로 실행'이 된다. 서명 파이프라인이
 * 릴리스에 편입되기 전까지, 앱이 요구하는 권한 상승에는 그 전제를 함께 밝힌다.
 */
export const FAILED_KIND_HINTS: Record<FailedKind, string> = {
  denied:
    "관리자 권한으로 다시 실행하면 보입니다 — 다만 상승 실행 전에 이 설치본이 " +
    "배포자가 만든 것과 같은지(게시자 서명 또는 공개된 SHA256) 먼저 확인하십시오.",
  notFound: "스캔 도중 삭제·이동된 항목입니다. 다시 스캔하면 사라집니다.",
  tooLong: "경로가 260자를 넘습니다. 상위 폴더 이름을 줄이거나 그 폴더를 직접 스캔하십시오.",
  tooDeep: "폴더 중첩이 상한을 넘습니다. 해당 경로를 대상으로 다시 스캔하십시오.",
  notReady:
    "이동식·광학 드라이브에 디스크가 들어 있는지 확인하십시오. 관리자 권한으로도 달라지지 않습니다.",
  locked:
    "다른 프로그램이 그 파일을 열어 두고 있습니다. 해당 프로그램을 닫고 다시 스캔하면 포함됩니다.",
  other: "원인을 특정하지 못했습니다.",
};

/**
 * 요약 문장의 나열 순서이자 '아는 갈래' 집합.
 *
 * 백엔드가 새 갈래를 추가하면 여기에 없어 other 로 합산되고, 원인을 정확히 아는
 * 실패가 '원인을 특정하지 못했습니다'로 안내된다. contract.test.ts 가 Rust 원본과
 * 이 집합을 대조해 그 드리프트를 CI 실패로 만든다.
 */
const KIND_ORDER: FailedKind[] = [
  "denied",
  "locked",
  "notReady",
  "tooLong",
  "tooDeep",
  "notFound",
  "other",
];

export interface ErrorBreakdown {
  /**
   * failedPaths 표본 기준 사유별 **고유 위치 수**.
   *
   * 백엔드 `record_failure` 는 (경로, 갈래) 조합을 HashSet 으로 접으므로 이 값은
   * 발생 건수가 아니다 — 한 디렉터리에서 엔트리 순회가 수십 번 실패해도 목록에는
   * 한 줄만 남는다. 그래서 화면 문구도 '건'이 아니라 '곳'으로 적는다.
   */
  counts: Record<FailedKind, number>;
  /** result.errors — 실패 총 건수(접기 전). 표본 합계보다 크면 두 축이 다른 것이다. */
  total: number;
  /** 목록 잘림이나 중복 접기로 표본이 총 건수를 다 설명하지 못하는지. */
  sampled: boolean;
  /** 표본에 실제로 실린 고유 위치 수. sampled 문장의 분모다. */
  sampleTotal: number;
  /** 관리자 권한 재실행이 실제로 도움이 되는 경우에만 참. */
  suggestElevation: boolean;
}

export function breakdownErrors(result: ScanResult): ErrorBreakdown | null {
  if (result.errors <= 0) return null;
  const paths: FailedPath[] = result.failedPaths ?? [];
  const counts: Record<FailedKind, number> = {
    denied: 0,
    notFound: 0,
    tooLong: 0,
    tooDeep: 0,
    notReady: 0,
    locked: 0,
    other: 0,
  };
  for (const p of paths) {
    // 백엔드가 새 갈래를 추가해도 조용히 사라지지 않도록 미지의 값은 other 로 모은다.
    const kind = (KIND_ORDER.includes(p.kind) ? p.kind : "other") as FailedKind;
    counts[kind] += 1;
  }
  const sampleTotal = paths.length;
  return {
    counts,
    total: result.errors,
    sampleTotal,
    /*
     * 잘림 플래그만 보면 거의 언제나 false 가 된다.
     *
     * 백엔드는 failedPathsTruncated 를 항상 실어 보내고 500건 상한에 걸리지 않는 한
     * false 다. 그런데 (경로, 갈래) 중복 접기 때문에 상한과 무관하게 '총 50건 · 목록
     * 4행'이 정상 동작으로 나온다 — 그때 완결형 문장을 쓰면 '50건인데 사유별 합이 4'
     * 라는 산수가 맞지 않는 문장이 되고, 남은 46건의 행방을 읽을 근거가 화면에 없다.
     * 잘렸든 접혔든 표본이 총수를 설명하지 못하면 같은 관용으로 다룬다.
     */
    sampled: (result.failedPathsTruncated ?? false) || (sampleTotal > 0 && sampleTotal < result.errors),
    // 표본이 없으면 사유를 모르므로 단정하지 않는다.
    suggestElevation: counts.denied > 0,
  };
}

/**
 * '권한 거부 12곳 · 경로 길이 초과 3곳' 형태. 표본이 없으면 총 건수만 말한다.
 *
 * 발생 건수(errors)와 고유 위치 수(counts)는 다른 축이므로 다른 명사로 적는다 —
 * 같은 '건'으로 나란히 놓으면 합계가 맞지 않는 문장이 된다.
 */
export function describeErrors(b: ErrorBreakdown): string {
  const parts = KIND_ORDER.filter((k) => b.counts[k] > 0).map(
    (k) => `${FAILED_KIND_LABELS[k]} ${formatCount(b.counts[k])}곳`,
  );
  if (parts.length === 0) {
    return `${formatCount(b.total)}개 항목을 읽지 못했습니다 — 사유는 기록되지 않았습니다.`;
  }
  const head = `${formatCount(b.total)}개 항목을 읽지 못했습니다`;
  const tail = b.sampled
    ? ` — 기록된 위치 ${formatCount(b.sampleTotal)}곳 기준: ${parts.join(" · ")}`
    : ` — ${parts.join(" · ")}`;
  return `${head}${tail}.`;
}

/** 정션·심볼릭 링크. 클라우드 자리표시자와 섞어 적으면 둘 다 틀린 문장이 된다. */
export function describeSkippedLinks(result: ScanResult): string | null {
  const n = result.skippedLinks ?? 0;
  if (n <= 0) return null;
  return `정션·심볼릭 링크 ${formatCount(n)}건은 같은 실체를 두 번 세지 않으려고 제외했습니다.`;
}

/** 클라우드 자리표시자. 논리 바이트를 함께 적지 않으면 '조용한 누락'이 그대로다. */
export function describeSkippedCloud(result: ScanResult): string | null {
  const n = result.skippedCloud ?? 0;
  if (n <= 0) return null;
  const bytes = result.skippedCloudBytes ?? 0;
  const size = bytes > 0 ? ` (원래 크기 ${formatBytes(bytes)})` : "";
  return (
    `OneDrive 등 온라인 전용 파일 ${formatCount(n)}건${size}은 ` +
    `이 PC의 공간을 쓰지 않아 총계에서 제외했습니다.`
  );
}

export interface Coverage {
  /** 경보 피로를 막으려고 중립 정보와 실제 경고를 나눈다. */
  tone: "info" | "warn";
  text: string;
}

/**
 * 드라이브 사용량과의 대조.
 *
 * 드라이브 값은 할당 점유량이고 우리 합계는 논리 크기라 정의가 다르다. 차액을
 * 전부 '권한'으로 돌리면 클라우드 자리표시자·클러스터 슬랙·하드링크가 모두
 * 권한 문제로 둔갑한다. 합계가 사용량을 넘는 경우(WinSxS 하드링크)도 따로 짚는다.
 */
export function describeCoverage(result: ScanResult, driveUsed: number): Coverage | null {
  if (driveUsed <= 0) return null;

  if (result.totalSize > driveUsed) {
    /*
     * 초과분의 설명이 중복 제거 여부에 따라 정반대가 된다.
     *
     * 하드링크 중복 제거가 꺼져 있으면 WinSxS 가 링크 수만큼 계수된 것이 1차 원인이다.
     * 그러나 켜져 있는 볼륨(NTFS·ReFS 기본)에서 같은 문장을 쓰면, 이미 뺀 몫을 원인으로
     * 지목하는 셈이라 사용자는 존재하지 않는 문제를 찾게 된다 — 그때는 얼마를 뺐는지
     * 정량으로 말할 수 있다.
     */
    const cause = dedupEnabled(result)
      ? `하드링크로 공유된 파일 ${formatCount(result.hardlinkDedupedFiles ?? 0)}건` +
        `(${formatBytes(result.hardlinkDedupedBytes ?? 0)})은 이미 한 번만 셌으므로, ` +
        `남은 차이는 추적 하한 미만의 하드링크·NTFS 압축·스냅샷 등입니다.`
      : `하드링크로 공유된 파일이 각각 계수되고(Windows\\WinSxS 등), ` +
        `NTFS 압축은 반영되지 않기 때문입니다.`;
    return {
      tone: "info",
      text:
        `논리 합계 ${formatBytes(result.totalSize)} 가 드라이브 사용량 ` +
        `${formatBytes(driveUsed)} 보다 큽니다 — ${cause}`,
    };
  }

  const covered = percent(result.totalSize, driveUsed);
  const reasons = ["권한이 없거나 시스템이 감춘 영역"];
  if ((result.skippedCloud ?? 0) > 0) reasons.push("온라인 전용 파일");
  if ((result.skippedLinks ?? 0) > 0) reasons.push("건너뛴 링크");
  reasons.push("논리 크기와 할당 크기의 차이");

  return {
    // 대부분의 정상 스캔에서 90%대가 나온다. 그것까지 경고색으로 칠하면 경보 피로가 된다.
    tone: covered < 70 ? "warn" : "info",
    text:
      `드라이브 사용량 ${formatBytes(driveUsed)} 중 ${formatBytes(result.totalSize)}` +
      `(${formatPercent(covered)})를 확인했습니다. 나머지는 ${reasons.join(" · ")}입니다.`,
  };
}

/** 논리 합계와 할당 추정치의 차액이 이 비율 미만이면 두 줄이 같은 말을 반복하게 된다. */
const ALLOC_DIFF_MIN_RATIO = 0.01;

/**
 * 할당량 산출 방식. 백엔드 `ScanResult::alloc_basis` 의 값 집합과 같다.
 *
 * `"other"` 만 프런트가 만든 갈래다 — 백엔드가 값을 하나 더 늘렸을 때
 * '모르는 값 = 산출 못 함'으로 접으면 실재하는 숫자가 화면에서 통째로 사라진다.
 */
export type AllocBasis = "allocationSize" | "clusterRoundUp" | "unknown" | "other";

/**
 * `allocBasis` 를 화면이 아는 갈래로 좁힌다.
 *
 * 예전에는 세 곳이 `allocBasis === "clusterRoundUp"` 로 직접 비교했다. 백엔드가
 * Windows 에서 값을 `"allocationSize"`(파일시스템이 항목마다 보고한 실제 할당
 * 바이트)로 바꾼 순간, 그 비교는 **실사용 전량에서** 거짓이 되어 할당량 안내가
 * 조용히 사라졌다 — 컴파일러도 `tsc` 도 잡지 못하는 갈래라 비교를 여기 한 곳으로
 * 모으고 contract.test.ts 가 Rust 원본의 값 집합과 대조한다.
 */
export function allocBasisOf(result: ScanResult): AllocBasis {
  switch (result.allocBasis) {
    case "allocationSize":
    case "clusterRoundUp":
    case "unknown":
      return result.allocBasis;
    // 이 필드가 없던 시절의 백엔드는 클러스터 올림만 했다.
    case undefined:
      return "clusterRoundUp";
    default:
      if (import.meta.env.DEV) {
        console.warn(
          `[discan] 알 수 없는 할당량 산출 방식: ${result.allocBasis} — notice.ts 를 갱신하십시오.`,
        );
      }
      // 값 자체는 실재하므로 감추지 않는다. 산출 방식만 단정하지 않는다.
      return "other";
  }
}

/** 하드링크 중복 제거를 실제로 켠 결과인지. `dedup` 값 비교를 한 곳에 모은다. */
export function dedupEnabled(result: ScanResult): boolean {
  return (result.dedup ?? "none") !== "none";
}

/**
 * 할당량의 산출 **범위** 한 줄. 방식마다 무엇이 빠졌는지가 다르다.
 *
 * `"allocationSize"` 는 파일시스템의 셈을 그대로 누적한 값이라 근사가 아니다.
 * 그래도 디렉터리 자체가 쓰는 공간은 세지 않고(파일 항목만 더한다), NTFS 압축·
 * 희소 파일은 어긋날 수 있다 — 그 규모는 allocUncertain* 가 말한다.
 */
function allocScope(result: ScanResult, basis: AllocBasis): string {
  if (basis === "clusterRoundUp") {
    return (
      "파일만 올림해 더한 값이라 디렉터리 자체가 쓰는 공간은 세지 않았고, NTFS 압축·" +
      "희소 파일·아주 작은 파일(MFT 상주)과 하드링크 중복도 반영되지 않아 탐색기 값과 " +
      "다를 수 있습니다."
    );
  }
  if (basis === "allocationSize") {
    const uncertain =
      (result.allocUncertainFiles ?? 0) > 0
        ? "NTFS 압축·희소 파일이 섞여 있어 그만큼은 어긋날 수 있습니다."
        : "";
    const links = dedupEnabled(result)
      ? ""
      : "하드링크로 공유된 파일은 링크 수만큼 세었습니다.";
    return [
      "파일시스템이 항목마다 보고한 할당 크기를 그대로 더한 값이라 근사가 아닙니다.",
      "다만 디렉터리 자체가 쓰는 공간은 세지 않았습니다.",
      uncertain,
      links,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return `산출 방식(${result.allocBasis})을 이 화면이 아직 해석하지 못해 범위를 단정하지 않습니다.`;
}

/**
 * 할당 크기 안내.
 *
 * 산출 방식에 따라 이 값의 성격이 다르다 — `"allocationSize"` 는 파일시스템의 셈
 * 그대로라 단정할 수 있고, `"clusterRoundUp"` 은 파일마다 ceil(size/cluster)×cluster
 * 를 누적한 폴백이라 '추정'이다. 압축·희소 파일이 섞였으면(allocUncertainFiles>0)
 * 전자도 단정하지 않는다.
 *
 * 예전에는 차액이 1% 미만이면 이 줄을 통째로 감췄다. 그런데 총 용량 각주는 바로
 * 그 조건에서 '디스크가 차지하는 공간과 거의 같습니다'를 단정했다 — 근사 주장이
 * 가장 강하게 나가는 순간에 그 주장의 한계가 화면 어디에도 없었던 셈이다. 차액이
 * 작으면 숫자를 반복하지 않되(그것이 원래 의도였다) 산출 범위 한 줄은 남긴다.
 */
export function allocatedNote(result: ScanResult): string | null {
  const allocated = result.allocatedEstimate ?? 0;
  if (allocated <= 0 || result.totalSize <= 0) return null;
  const basis = allocBasisOf(result);
  // 산출하지 못한 값에 산출 범위를 붙이면 없는 근거를 만드는 것이 된다.
  if (basis === "unknown") return null;
  const diff = allocated - result.totalSize;

  const cluster = result.clusterBytes ?? 0;
  // 파일시스템이 셈한 값이라도 압축·희소 파일이 섞였으면 그만큼은 단정하지 않는다.
  const measured = basis === "allocationSize" && (result.allocUncertainFiles ?? 0) === 0;
  const detail =
    cluster > 0
      ? `클러스터 ${formatBytes(cluster)}${result.fileSystem ? `, ${result.fileSystem}` : ""} 기준`
      : basis === "allocationSize"
        ? `파일시스템 보고 기준${result.fileSystem ? `, ${result.fileSystem}` : ""}`
        : "클러스터 크기 미상";
  const scope = allocScope(result, basis);

  /*
   * 점유가 논리 합계보다 **작은** 경우도 실제로 나온다.
   *
   * 클러스터 올림만 하던 시절에는 구조적으로 diff >= 0 이라 이 갈래를 '거의 같다'로
   * 접어도 무해했다. 파일시스템 보고 값에서는 NTFS 압축·희소 파일·MFT 상주 소형
   * 파일이 실제로 점유를 논리 크기 아래로 끌어내리므로, 30% 작은 값을 '거의 같다'로
   * 적으면 그것이 곧 오기다.
   */
  if (diff < 0 && -diff / result.totalSize >= ALLOC_DIFF_MIN_RATIO) {
    return (
      `디스크 점유는 ${formatBytes(allocated)}(-${formatBytes(-diff)})로 논리 합계보다 작습니다` +
      `(${detail}) — ${scope}`
    );
  }

  // 차액이 표시 단위에서 사라질 정도면 숫자를 두 번 적지 않는다('12.8 은 12.8 입니다').
  if (diff <= 0 || diff / result.totalSize < ALLOC_DIFF_MIN_RATIO) {
    return `디스크 점유는 논리 합계와 거의 같습니다(${detail}) — ${scope}`;
  }

  const head = measured
    ? `디스크 점유는 ${formatBytes(allocated)}(+${formatBytes(diff)})입니다`
    : `디스크 점유는 약 ${formatBytes(allocated)}(+${formatBytes(diff)})로 추정됩니다`;
  return `${head} — ${detail}으로 ${scope}`;
}

/**
 * 총 용량 타일의 각주. 값의 해석을 바꾸는 경우에만 문자열을 돌려준다.
 *
 * 첫 화면에는 같은 시각 가중치(11px·--text-dim)의 해석 단서가 다섯 갈래 일곱 줄
 * 있었다. 그래서 결정을 바꾸는 단서(하한 표기·부분 집계)와 스캔마다 변하지 않는
 * 상수('클러스터 크기를 못 읽었다', '점유가 논리 합계와 거의 같다')가 구분되지
 * 않았고, 결과적으로 둘 다 읽히지 않았다. 상수 갈래는 null 로 떨어뜨려 접히는
 * '집계 조건'(basisLines)으로 내리고, 타일에는 차액이 유의미한 경우만 남긴다.
 *
 * (allocBasis 판정 자체는 유지한다 — 백엔드가 그 필드를 만든 이유가 0을 '점유
 *  없음'으로 오해시키지 않기 위해서인데, 표시 단계에서 그것을 뒤집으면 안 된다.)
 */
export function totalFootnote(result: ScanResult): string | null {
  const allocated = result.allocatedEstimate ?? 0;
  // 산출 방식을 값으로 직접 비교하지 않는다 — 백엔드가 Windows 기본값을
  // "allocationSize" 로 바꾼 순간 그 비교가 실사용 전량에서 거짓이 되어
  // 각주가 조용히 사라졌다. 산출하지 못한 경우(unknown)만 비운다.
  if (allocBasisOf(result) === "unknown" || allocated <= 0) return null;
  const diff = allocated - result.totalSize;
  if (diff > 0 && result.totalSize > 0 && diff / result.totalSize >= ALLOC_DIFF_MIN_RATIO) {
    return `파일 크기의 합계입니다 (디스크 점유는 +${formatBytes(diff)}).`;
  }
  return null;
}

/**
 * 접힌 상태에서 보일 한 줄 요약.
 *
 * 상세 네 줄을 항상 펼쳐 두면 결과 화면에서 가장 값비싼 세로 대역을 11px 회색
 * 문장이 점유한다. 대비 5:1 회색 네 줄은 실제로 아무도 읽지 않아 고지 목적도
 * 달성되지 않는다. 요약 한 줄을 남기고 나머지는 접는다.
 */
export function conditionsSummary(result: ScanResult): string {
  // 접힌 줄은 사람 말로 쓴다 — '하드링크 미중복제거'·'7.09 MiB 미만'은 뜻을 짐작할
  // 수조차 없어, 접었는데도 읽히지 않는 줄이 그대로 남았다. 정확한 용어와 임계값은
  // 펼친 본문(basisLines)에 그대로 있으므로 감사 목적도 함께 지켜진다.
  const bits: string[] = [];
  /*
   * 발생하지 않은 제외를 과거형으로 단정하지 않는다.
   *
   * 예전에는 skippedCloud 를 보지 않고 늘 '온라인 전용 파일은 뺐습니다'를 넣어,
   * 자리표시자가 0건인 대상에서도 그 문장이 접힌 줄의 유일한 요약 — 곧 사용자가
   * 얻는 1차 정보 — 이 되었다. 같은 사실을 다루는 describeSkippedCloud 는 0건이면
   * null 을 돌려주므로, 접힌 줄과 펼친 본문이 서로 다른 사실을 말하는 상태였다.
   */
  if ((result.skippedCloud ?? 0) > 0) {
    bits.push(`온라인 전용 파일 ${formatCount(result.skippedCloud ?? 0)}건은 뺐습니다`);
  }
  if (result.pruneParams) bits.push("아주 작은 폴더는 목록에서 생략했습니다");
  if (bits.length === 0) return "이 숫자는 어떻게 셌나요 — 집계 기준·가지치기 조건";
  return `이 숫자는 어떻게 셌나요 — ${bits.join(" · ")}`;
}

/**
 * '집계 조건' — 결과가 성립한 전제. 오류 유무와 무관하게 늘 보여야 한다.
 * 예전에는 notice 블록 안에 있어서 깨끗하게 끝난 폴더 스캔에서는 한 번도 안 나왔다.
 */
export function basisLines(result: ScanResult): string[] {
  const lines: string[] = [];

  const basis = result.sizeBasis === "logical" || !result.sizeBasis ? "파일 논리 크기 합계" : result.sizeBasis;
  /*
   * 하드링크 미중복제거는 C:\Windows\WinSxS 에서 수 GB를 부풀린다. 알려진 한계는
   * 고지해야 한다. 반대로 켜져 있을 때 백엔드 키를 그대로 노출하면(`중복 제거:
   * hardlink`) 한국어 화면 한복판에 영문 식별자가 찍힌다 — 아는 값은 우리말로 적고,
   * 모르는 값일 때만 키를 그대로 남겨 어느 값이 왔는지 알 수 있게 한다.
   */
  const dedupKey = result.dedup ?? "none";
  const dedup =
    dedupKey === "none"
      ? "하드링크 중복 제거 없음"
      : dedupKey === "hardlink"
        ? "하드링크 중복 제거함"
        : `중복 제거: ${dedupKey}`;
  // 단위 정의는 결과 화면에도 있어야 한다 — 대상 패널이 접히면 그 고지가 함께 사라진다.
  lines.push(
    `집계 기준: ${basis} · ${dedup} · 온라인 전용 파일 제외 · 클러스터 슬랙 미반영 · ` +
      `용량 표기 1 KiB = 1024 B`,
  );

  /*
   * 중복 제거의 실제 범위.
   *
   * '중복 제거함/안 함' 한 마디는 두 방향으로 오해된다 — 껐다면 왜 껐는지(FAT32 는
   * 파일 ID 가 불안정해 끌 수밖에 없다), 켰다면 어디까지 봤는지(추적 하한 미만의
   * 중복은 잡히지 않는다)를 적지 않으면 사용자는 각각 버그와 전량 제거로 읽는다.
   * 백엔드가 그 두 축을 실어 보내는데 화면에는 한 번도 나오지 않았다.
   */
  if (!dedupEnabled(result)) {
    const why =
      result.dedupDisabledReason === "unstableFileIds"
        ? " (이 파일 시스템은 파일 식별자가 안정적이지 않아 판정할 수 없습니다)"
        : result.dedupDisabledReason === "unsupportedPlatform"
          ? " (이 플랫폼에서는 지원되지 않습니다)"
          : "";
    if (why) lines.push(`하드링크 중복 제거를 하지 않았습니다${why}.`);
  } else if ((result.hardlinkDedupedFiles ?? 0) > 0) {
    const floor =
      (result.dedupMinBytes ?? 0) > 0
        ? ` ${formatBytes(result.dedupMinBytes ?? 0)} 미만 파일은 추적하지 않았으므로 그 구간의 중복은 남아 있습니다.`
        : "";
    lines.push(
      `하드링크로 공유된 파일 ${formatCount(result.hardlinkDedupedFiles ?? 0)}건` +
        `(${formatBytes(result.hardlinkDedupedBytes ?? 0)})을 한 번만 셌습니다.${floor}`,
    );
  }

  const alloc = allocatedNote(result);
  if (alloc) {
    lines.push(alloc);
  } else {
    /*
     * 총 용량 타일에서 강등된 갈래를 여기서 받는다.
     *
     * '클러스터 크기를 못 읽어 점유를 산출하지 못했다'는 스캔마다 변하지 않는 조건이라
     * 첫 화면의 11px 회색 줄을 차지할 이유가 없다. 그러나 사라져서도 안 된다 —
     * allocatedEstimate 가 0인 것을 '점유 없음'으로 읽으면 결론이 뒤집힌다.
     *
     * 사유는 산출 방식에 따라 다르다. 파일시스템이 할당 크기를 보고하는 볼륨에서
     * 점유가 0이라면 그것은 클러스터 크기와 무관한 일(빈 대상)이므로, 두 경우에
     * 같은 문장을 쓰면 둘 중 하나는 반드시 거짓이 된다.
     */
    lines.push(
      allocBasisOf(result) === "unknown"
        ? "이 볼륨의 클러스터 크기를 읽지 못해 디스크 점유량은 산출하지 못했습니다 — " +
            "총 용량은 파일 크기의 합계입니다."
        : "디스크 점유량으로 집계된 바이트가 없습니다 — 총 용량은 파일 크기의 합계입니다.",
    );
  }
  // 점유 추정이 얼마나 강하게 말해도 되는지의 근거. 값이 있는데 화면에 없으면
  // '탐색기와 왜 다른가'에 답할 수 있는 유일한 축이 산출물에서만 보인다.
  if ((result.allocUncertainFiles ?? 0) > 0) {
    lines.push(
      `NTFS 압축·희소 파일 ${formatCount(result.allocUncertainFiles ?? 0)}건` +
        `(${formatBytes(result.allocUncertainBytes ?? 0)})은 실제 점유를 단정할 수 없습니다.`,
    );
  }

  if (result.pruneParams) {
    lines.push(
      `가지치기 기준: 용량이 아주 작은 폴더(${formatBytes(result.pruneParams.minSize)} 미만)는 ` +
        `목록에서 생략했습니다 · 최대 깊이 ${result.pruneParams.maxDepth} · ` +
        `폴더당 상위 ${result.pruneParams.maxChildren}개.`,
    );
  }

  const stamp = formatStartedAt(result.startedAt);
  const meta = [
    result.appVersion ? `discan ${result.appVersion}` : null,
    stamp,
    // 같은 볼륨도 권한에 따라 총량이 GB 단위로 달라진다. 두 스냅샷을 비교할 때
    // 가장 먼저 확인해야 할 조건이라 함께 남긴다.
    result.elevated === undefined ? null : result.elevated ? "관리자 권한" : "일반 권한",
  ].filter(Boolean);
  if (meta.length > 0) lines.push(meta.join(" · "));

  return lines;
}

/** RFC3339(UTC) 를 로케일 표기로. 깨진 값은 조용히 버린다. */
export function formatStartedAt(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(typeof navigator !== "undefined" ? navigator.language || "ko-KR" : "ko-KR");
}
