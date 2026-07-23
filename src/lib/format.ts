// 1024 기준이므로 IEC 접두사를 쓴다. 드라이브 카드(10진 광고 용량)와 나란히 놓이는
// 화면이라 "930 GB 디스크가 왜 866 GiB인가"를 표기 자체가 설명해 주어야 한다.
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export interface BytesParts {
  /** 숫자 부분. 우측 정렬 대상. */
  value: string;
  /** 단위 부분. 좌측 정렬 고정폭 칸에 넣어 소수점 자리를 맞춘다. */
  unit: string;
}

export interface BytesFormatOptions {
  /**
   * 소수 자릿수를 고정한다.
   *
   * 자릿수를 값에 맡기면 한 열에 '933'·'12.8'·'1.65'가 섞여, 우측 정렬과
   * tabular-nums 로 오른쪽 끝은 맞아도 소수점 위치가 세 자리로 흩어진다. 수치 비교가
   * 이 앱의 목적인데 열을 훑을 때 자릿수를 눈으로 다시 세게 만드는 셈이라, 목록
   * 컨텍스트(분야·트리·파일·정리 후보)는 1자리로 통일한다. 단독 지표 타일은 비교
   * 상대가 없으므로 지금의 가변 자릿수를 그대로 쓴다.
   */
  fixedDigits?: 0 | 1 | 2;
}

/** 1024 기준. 소수점은 크기가 작을수록 더 보여준다(목록에서는 fixedDigits 로 고정). */
export function formatBytesParts(bytes: number, options: BytesFormatOptions = {}): BytesParts {
  const fixed = options.fixedDigits;
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { value: fixed === undefined ? "0" : (0).toFixed(fixed), unit: "B" };
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = fixed ?? (unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return { value: value.toFixed(digits), unit: UNITS[unit] };
}

export function formatBytes(bytes: number, options: BytesFormatOptions = {}): string {
  const { value, unit } = formatBytesParts(bytes, options);
  return `${value} ${unit}`;
}

/** 로케일은 OS 설정을 따른다. 백엔드 재빌드 없이 언어가 바뀌어야 한다. */
function locale(): string {
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "ko-KR";
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(locale());
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0초";
  // 밀리초 표기는 일반 사용자에게 낯설다. 1초 미만은 말로 푼다.
  if (ms < 1000) return "1초 미만";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 초 단위 경과 시간을 mm:ss 로. 진행 표시에 쓴다. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return (part / whole) * 100;
}

/**
 * 0이 아닌데 0.0%로 찍히는 값을 구분한다.
 * 0.05% 미만을 '0.0%'로 뭉개면 순위 정보가 사라지고 '0'으로 오독된다.
 *
 * 자릿수는 한 자리로 고정한다 — 예전에는 '100%'·'0%'(소수 없음)와 '87.0%'가 같은
 * 열에 섞여, 바이트 열과 같은 이유로 소수점 축이 어긋났다.
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0%";
  if (value < 0.05) return "<0.1%";
  if (value >= 100) return "100.0%";
  return `${value.toFixed(1)}%`;
}

/** 경로가 길면 앞쪽을 줄인다. 꼬리(실제 폴더명)가 정보량이 크다. */
export function truncatePath(path: string, max = 64): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - max + 1)}`;
}

/**
 * 드라이브와 마지막 구성요소를 항상 남기고 가운데를 생략한다.
 *
 * 앞을 자르는 방식은 CSS 의 ellipsis 와 겹치면 앞뒤가 모두 잘려('…s\harness\net\r_new…')
 * 어느 폴더인지 판독이 불가능해진다. 판단에 필요한 두 정보는 '어느 드라이브'와
 * '무엇'이므로 그 둘을 고정하고 중간을 버린다.
 */
export function middlePath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter((p) => p.length > 0);
  if (parts.length <= 2) return truncatePath(path, max);

  const head = parts[0];
  // 꼬리는 가능한 한 두 단계까지 남긴다 — 'target' 하나만으로는 어느 프로젝트인지 모른다.
  for (const tailCount of [2, 1]) {
    const tail = parts.slice(-tailCount).join(sep);
    const candidate = `${head}${sep}…${sep}${tail}`;
    if (candidate.length <= max || tailCount === 1) return candidate;
  }
  return path;
}

/** 경로의 마지막 구성요소. 카드에서는 이것이 판단의 핵심이라 굵게 따로 낸다. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}
