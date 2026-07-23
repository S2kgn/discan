import { formatBytes, formatCount } from "./format";

export interface HistoryEntry {
  size: number;
  /** ISO 문자열. 표시할 때만 로케일로 바꾼다. */
  at: string;
  /**
   * 스냅샷의 성립 조건. 총량만 저장하면 관리자 권한으로 한 번, 일반 권한으로 한 번
   * 스캔했을 때 접근 실패로 생긴 차이가 정리 성과로 보고된다.
   */
  errors?: number;
  totalFiles?: number;
  appVersion?: string;
  sizeBasis?: string;
  /**
   * 관리자 권한으로 스캔했는지. errors 차이가 상한 안이면서도 큰 폴더 몇 개가
   * 통째로 막히면 수 GB 가 달라지는데, 그때 화면은 '↑ 1.10 GiB 늘었습니다'를
   * 정리 성과처럼 보고한다. 그 오독을 직접 판정할 수 있는 유일한 필드다.
   */
  elevated?: boolean;
  /**
   * 같은 경로의 최근 실행들(최신 우선, 상한 HISTORY_RUNS_MAX).
   *
   * 경로별 최신 1건만 두면 compareMessage 가 '직전 스캔 대비'밖에 말할 수 없어,
   * 정리 작업의 효과를 몇 주에 걸쳐 추적하는 일이 앱 안에서 끊긴다. 최상위 필드는
   * 비교용으로 그대로 두고(구버전 저장값과도 붙는다) 시계열은 여기에 쌓는다.
   * 이 배열의 원소에는 runs 를 다시 담지 않는다.
   */
  runs?: HistoryEntry[];
}

export type History = Record<string, HistoryEntry>;

const KEY = "discan.history";
export const RECENT_KEY = "discan.recent";
/** 이보다 작은 차이는 정리 성과가 아니라 잡음이다. */
const MIN_DELTA = 1024 * 1024;
/** 절대 경로가 사용 기간에 비례해 무한히 쌓이지 않도록 상한을 둔다. */
export const HISTORY_MAX = 20;
/** 오래된 항목은 비교 기준으로서의 값도 없다. 90일이면 충분히 길다. */
export const HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 경로 하나가 보관하는 실행 수. 추세를 보기에 충분하고 저장 용량은 수 KB 다. */
export const HISTORY_RUNS_MAX = 10;
/** 접근 실패 건수가 이만큼 벌어지면 총량 비교가 성립하지 않는다. */
const ERROR_DRIFT = 50;

export function readHistory(): History {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as History) : {};
  } catch {
    return {};
  }
}

/** 만료·상한을 적용한다. 저장 시점마다 돌므로 별도 청소 시점이 필요 없다. */
export function pruneHistory(history: History, now = Date.now()): History {
  const entries = Object.entries(history).filter(([, e]) => {
    const t = new Date(e?.at ?? "").getTime();
    return Number.isFinite(t) && now - t < HISTORY_TTL_MS;
  });
  entries.sort((a, b) => new Date(b[1].at).getTime() - new Date(a[1].at).getTime());
  return Object.fromEntries(entries.slice(0, HISTORY_MAX));
}

export function writeHistory(
  history: History,
  path: string,
  entry: Omit<HistoryEntry, "at" | "runs">,
  at = new Date(),
): History {
  const current: HistoryEntry = { ...entry, at: at.toISOString() };
  const prev = history[path];
  // 구버전 저장값에는 runs 가 없다. 그때는 최상위 항목 하나가 첫 이력이 된다.
  const previousRuns = prev ? (prev.runs ?? [{ ...prev, runs: undefined }]) : [];
  const runs = [current, ...previousRuns.map((r) => ({ ...r, runs: undefined }))]
    .filter((r) => typeof r.at === "string")
    .slice(0, HISTORY_RUNS_MAX);
  const next = pruneHistory({ ...history, [path]: { ...current, runs } }, at.getTime());
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장 실패는 기능에 영향이 없다.
  }
  return next;
}

/**
 * 이력과 최근 경로를 함께 지운다.
 *
 * 두 키 모두 WebView2 프로필의 평문 저장소에 남고, 최근 스캔 칩은 빈 화면에 그대로
 * 노출된다. 공용 PC·화면 공유에서 프로젝트명이 담긴 절대 경로가 드러나므로
 * 지울 수단이 화면에 있어야 한다.
 */
export function clearStoredPaths(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // 저장소가 막힌 환경이면 애초에 남은 것도 없다.
  }
}

/**
 * 비교 결과. 방향을 문자열에 묻어 두면 화면이 색으로 구분할 수 없다 —
 * 정리 도구에서 '줄었다'와 '늘었다'는 정반대의 행동을 유도해야 한다.
 */
export interface Comparison {
  text: string;
  direction: "decrease" | "increase" | "unknown";
}

const EMPTY: Comparison = { text: "", direction: "unknown" };

/**
 * 기준 시각 표기.
 *
 * 같은 날 재스캔하면 `toLocaleDateString()` 은 오늘 날짜를 찍어 '오늘 대비 오늘'이
 * 된다. 24시간 안이면 시각으로, 그 밖에는 날짜로 적는다(로케일은 다른 곳과 같이
 * navigator.language 를 따른다).
 */
function stampOf(prev: string, now: Date, locale: string): string {
  const when = new Date(prev);
  if (Number.isNaN(when.getTime())) return "지난 스캔";
  const sameDay = now.getTime() - when.getTime() < 24 * 60 * 60 * 1000
    && now.toDateString() === when.toDateString();
  return sameDay
    ? `오늘 ${when.toLocaleTimeString(locale)}`
    : when.toLocaleDateString(locale);
}

/** 이번 스냅샷의 성립 조건. 저장해 둔 필드가 실제로 비교에 쓰여야 의미가 있다. */
export interface Snapshot {
  size: number;
  errors?: number;
  elevated?: boolean;
  sizeBasis?: string;
  appVersion?: string;
}

/** 정리한 보람은 숫자로 보여야 한다. 같은 경로의 직전 스캔과 비교한다. */
export function compareMessage(
  prev: HistoryEntry | undefined,
  current: Snapshot,
  now = new Date(),
  locale = typeof navigator !== "undefined" ? navigator.language || "ko-KR" : "ko-KR",
): Comparison {
  if (!prev) return EMPTY;

  const { size, errors = 0 } = current;
  const stamp = stampOf(prev.at, now, locale);

  /*
   * 성립 조건이 달라졌으면 총량 차이는 정리 성과가 아니다.
   *
   * 예전에는 errors 드리프트만 봤고 sizeBasis·appVersion·elevated 는 저장만 되고
   * 아무도 읽지 않는 메타데이터였다. 특히 권한 차이는 errors 가 50건 이내로 같아도
   * (큰 폴더 몇 개만 막히면 그렇다) 수 GB 를 만들어 내는데, 그 경우 화면은
   * '↑ 1.10 GiB 늘었습니다'를 정리 성과처럼 보고했다.
   */
  if (
    prev.elevated !== undefined &&
    current.elevated !== undefined &&
    prev.elevated !== current.elevated
  ) {
    return {
      text: `${stamp}와 실행 권한이 달라(${prev.elevated ? "관리자" : "일반"} → ${current.elevated ? "관리자" : "일반"}) 총량 비교가 성립하지 않습니다.`,
      direction: "unknown",
    };
  }
  if (prev.sizeBasis !== undefined && current.sizeBasis !== undefined && prev.sizeBasis !== current.sizeBasis) {
    return {
      text: `${stamp}와 집계 기준이 달라(${prev.sizeBasis} → ${current.sizeBasis}) 총량 비교가 성립하지 않습니다.`,
      direction: "unknown",
    };
  }
  if (prev.appVersion !== undefined && current.appVersion !== undefined && prev.appVersion !== current.appVersion) {
    return {
      text: `${stamp} 이후 앱이 갱신되어(${prev.appVersion} → ${current.appVersion}) 집계 방식이 달라졌을 수 있습니다.`,
      direction: "unknown",
    };
  }

  // 접근 실패 건수가 크게 달라졌으면 총량 차이는 정리 성과가 아니라 커버리지 차이다.
  const prevErrors = prev.errors;
  if (prevErrors !== undefined && Math.abs(prevErrors - errors) > ERROR_DRIFT) {
    return {
      text: `${stamp} 대비 접근 실패 건수가 ${formatCount(Math.abs(prevErrors - errors))}건 달라 총량 비교가 어렵습니다.`,
      direction: "unknown",
    };
  }

  const diff = prev.size - size;
  if (Math.abs(diff) < MIN_DELTA) return EMPTY;

  return diff > 0
    ? { text: `${stamp} 대비 ↓ ${formatBytes(diff)} 줄었습니다.`, direction: "decrease" }
    : { text: `${stamp} 대비 ↑ ${formatBytes(-diff)} 늘었습니다.`, direction: "increase" };
}
