import { CommandError, toCommandError } from "../types";

/**
 * 백엔드 오류를 화면 문구로 옮긴다.
 *
 * 1차 경로는 `code` 다 — 백엔드가 `CommandError { code, detail, message }` 를
 * 내려 주므로 한국어 부분 문자열을 뒤질 이유가 없다. 문구 매칭은 문자열로
 * reject 하는 경로(플러그인 오류·구버전 백엔드)를 위한 폴백으로만 남긴다.
 *
 * 원칙은 그대로다 — 백엔드가 이미 정확한 문장을 만들어 줬다면 열화시키지 않는다.
 * 사전에 없는 코드는 `message` 를 그대로 보여 준다(모르는 오류를 아는 척하지 않는다).
 */
export type ErrorCode =
  | "emptyPath"
  | "uncRejected"
  | "deviceNamespace"
  | "notFound"
  | "notADirectory"
  | "linkUnresolved"
  | "remoteDrive"
  | "unsupportedPath"
  | "busy"
  | "joinError"
  | "unknown";

/**
 * 백엔드가 실제로 내보내는 코드 목록(lib.rs `CommandError` 주석과 같은 집합).
 * contract.test.ts 가 Rust 원본과 이 목록을 대조한다.
 */
export const BACKEND_ERROR_CODES: Exclude<ErrorCode, "unknown">[] = [
  "emptyPath",
  "uncRejected",
  "deviceNamespace",
  "notFound",
  "notADirectory",
  "linkUnresolved",
  "remoteDrive",
  "unsupportedPath",
  "busy",
  "joinError",
];

interface Rule {
  code: ErrorCode;
  /** 백엔드 문자열의 특징적인 조각. 영어 변종도 함께 받는다. */
  patterns: string[];
}

/** 문자열로만 오는 오류를 위한 폴백 표. code 가 있으면 여기까지 오지 않는다. */
const RULES: Rule[] = [
  { code: "uncRejected", patterns: ["네트워크(UNC)", "UNC"] },
  { code: "deviceNamespace", patterns: ["장치 네임스페이스"] },
  { code: "remoteDrive", patterns: ["네트워크 드라이브"] },
  { code: "notADirectory", patterns: ["디렉터리가 아닙니다", "NotADirectory"] },
  { code: "notFound", patterns: ["경로를 찾을 수 없습니다", "NotFound"] },
  { code: "linkUnresolved", patterns: ["링크 대상을 확인할 수 없습니다"] },
  { code: "unsupportedPath", patterns: ["드라이브 문자로 지정된 로컬 경로만"] },
  { code: "busy", patterns: ["이미 스캔이 진행 중"] },
  { code: "joinError", patterns: ["중단되었습니다", "예기치 않게 끝났습니다", "JoinError"] },
  { code: "emptyPath", patterns: ["경로가 비어 있습니다"] },
];

/** 표시 문구는 프런트 사전에서만 고른다(언어 추가에 Rust 재빌드가 필요 없어야 한다). */
const MESSAGES: Record<Exclude<ErrorCode, "unknown">, string> = {
  emptyPath: "분석할 경로를 입력해 주십시오.",
  uncRejected:
    "네트워크(UNC) 경로는 분석할 수 없습니다 — 이 PC에 연결된 디스크만 분석합니다.",
  deviceNamespace:
    "장치 네임스페이스 경로는 분석할 수 없습니다 — 드라이브 문자로 지정해 주십시오.",
  notFound: "그 경로를 찾을 수 없습니다. 드라이브가 연결되어 있는지 확인해 주십시오.",
  notADirectory: "폴더가 아닙니다. 폴더 경로를 지정해 주십시오.",
  linkUnresolved:
    "링크가 가리키는 대상을 확인할 수 없습니다. 원본 경로를 직접 지정해 주십시오.",
  remoteDrive:
    "네트워크 드라이브는 분석할 수 없습니다 — 이 PC에 연결된 디스크만 분석합니다. 관리자 권한으로도 달라지지 않습니다.",
  unsupportedPath:
    "드라이브 문자로 지정된 로컬 경로만 분석할 수 있습니다 — 예: C:\\Users\\...",
  busy: "이미 스캔이 진행 중입니다. 끝나거나 중단된 뒤에 다시 시도해 주십시오.",
  joinError: "스캔 작업이 예기치 않게 끝났습니다. 다시 시도해 주십시오.",
};

function isKnown(code: string): code is Exclude<ErrorCode, "unknown"> {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code);
}

/** 문자열 오류에서 코드를 복원한다. 객체 오류에는 쓰이지 않는다. */
export function classifyError(raw: string): ErrorCode {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => raw.includes(p))) return rule.code;
  }
  return "unknown";
}

/** 객체·문자열 어느 쪽이 와도 코드 하나로 모은다. */
export function errorCodeOf(e: unknown): ErrorCode {
  const err = typeof e === "string" ? toCommandError(e) : (e as CommandError);
  const code = err?.code ?? "unknown";
  if (isKnown(code)) return code;
  // code 가 없거나 모르는 값이면 메시지 문구로 한 번 더 시도한다.
  return classifyError(err?.message ?? String(e ?? ""));
}

/**
 * 매핑된 코드에만 재작성 문구를 쓴다.
 *
 * 폴백에서 `err.message` 를 그대로 내보내면 그것은 lib.rs 가 만든 한국어 문자열이라,
 * 언어를 추가해도 미지 코드 경로에서는 백엔드 문구가 그대로 새어 나온다(사용자
 * 대면 문구의 단일 출처를 프런트에 두기로 한 결정이 여기서만 뚫린다). 원문은
 * errorDetail 이 '자세한 내용'에 그대로 싣고 있으므로 정보가 사라지지도 않는다.
 */
export function friendlyError(e: CommandError | string): string {
  // 입력을 언제나 정규화한다. 오류 처리 경로에서 던지는 예외는 원래 오류까지 함께
  // 삼켜, 사용자에게는 빈 화면만 남는다(null·형태가 어긋난 객체도 여기로 온다).
  const err = toCommandError(e);
  const code = errorCodeOf(err);
  if (code !== "unknown") return MESSAGES[code];
  const raw = typeof e === "string" ? "unknown" : err.code || "unknown";
  return `알 수 없는 오류로 실패했습니다 (code=${raw}) — 원문은 '자세한 내용'에 있습니다.`;
}

/** '자세한 내용'에 넣을 원문. 코드와 경로가 함께 있어야 감사 기록이 성립한다. */
export function errorDetail(e: CommandError | string): string {
  const err = toCommandError(e);
  const bits = [
    err.code && err.code !== "unknown" ? `code=${err.code}` : "",
    err.detail ? `경로: ${err.detail}` : "",
    err.message,
  ].filter(Boolean);
  return bits.join(" · ") || "(원문 없음)";
}

/** 정상적인 재진입 방어(busy)까지 빨간 오류 박스로 띄우면 겁을 준다. */
export function isBenignError(e: CommandError | string): boolean {
  return errorCodeOf(e) === "busy";
}

/**
 * 오류에 붙일 조치.
 *
 * 몇 번을 눌러도 결과가 같은 오류(원격·UNC·장치 경로)에 '다시 시도'를 주면
 * 사용자를 헛수고에 묶어 둔다. 드라이브 카드에서 이미 지킨 원칙을 여기에도 건다.
 */
export type ErrorAction = "retry" | "pick" | "none";

export function errorAction(e: CommandError | string): ErrorAction {
  switch (errorCodeOf(e)) {
    case "busy":
      // 스캔이 끝나야 풀린다. 버튼은 오히려 방해다.
      return "none";
    case "uncRejected":
    case "deviceNamespace":
    case "remoteDrive":
    case "unsupportedPath":
    case "notADirectory":
    case "emptyPath":
      return "pick";
    default:
      return "retry";
  }
}
