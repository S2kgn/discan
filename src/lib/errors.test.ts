import { describe, expect, it } from "vitest";
import {
  BACKEND_ERROR_CODES,
  classifyError,
  errorAction,
  errorCodeOf,
  errorDetail,
  friendlyError,
  isBenignError,
} from "./errors";
import { toCommandError } from "../types";

describe("toCommandError", () => {
  it("Tauri 가 객체로 reject 한 오류를 문자열로 뭉개지 않는다", () => {
    const e = toCommandError({ code: "uncRejected", detail: "\\\\host\\share", message: "x" });
    expect(e.code).toBe("uncRejected");
    expect(e.detail).toBe("\\\\host\\share");
  });

  it("문자열 오류도 같은 모양으로 만든다", () => {
    expect(toCommandError("os error 1392")).toEqual({
      code: "unknown",
      detail: "",
      message: "os error 1392",
    });
  });

  it("code 없는 객체를 '[object Object]' 로 만들지 않는다", () => {
    const e = toCommandError({ foo: 1 });
    expect(e.message).not.toContain("[object Object]");
    expect(e.message).toContain("foo");
  });
});

describe("errorCodeOf", () => {
  it.each(BACKEND_ERROR_CODES)("백엔드 코드 %s 를 그대로 인식한다", (code) => {
    expect(errorCodeOf({ code, detail: "", message: "" })).toBe(code);
  });

  it("모르는 코드는 메시지 문구로 한 번 더 시도한다", () => {
    expect(
      errorCodeOf({ code: "someNewCode", detail: "", message: "이미 스캔이 진행 중입니다." }),
    ).toBe("busy");
  });
});

describe("classifyError (문자열 폴백)", () => {
  it.each([
    ["네트워크(UNC) 경로는 분석할 수 없습니다.", "uncRejected"],
    ["장치 네임스페이스 경로는 분석할 수 없습니다.", "deviceNamespace"],
    ["네트워크 드라이브는 분석할 수 없습니다.", "remoteDrive"],
    ["경로를 찾을 수 없습니다: E:\\", "notFound"],
    ["디렉터리가 아닙니다: C:\\a.txt", "notADirectory"],
    ["링크 대상을 확인할 수 없습니다: C:\\x", "linkUnresolved"],
    ["드라이브 문자로 지정된 로컬 경로만 분석할 수 있습니다.", "unsupportedPath"],
    ["이미 스캔이 진행 중입니다.", "busy"],
    ["스캔 작업이 중단되었습니다: panic", "joinError"],
    ["경로가 비어 있습니다.", "emptyPath"],
  ])("%s → %s", (raw, code) => {
    expect(classifyError(raw)).toBe(code);
  });

  it("모르는 오류는 unknown", () => {
    expect(classifyError("os error 1392")).toBe("unknown");
  });
});

describe("friendlyError", () => {
  it("객체 오류에서 '[object Object]' 가 나오지 않는다", () => {
    const msg = friendlyError({
      code: "remoteDrive",
      detail: "Z:\\",
      message: "네트워크 드라이브는 분석할 수 없습니다.",
    });
    expect(msg).not.toContain("[object Object]");
    expect(msg).toContain("연결된 디스크만");
  });

  it("모든 백엔드 코드에 문구가 있다", () => {
    for (const code of BACKEND_ERROR_CODES) {
      const msg = friendlyError({ code, detail: "", message: "" });
      expect(msg.length, `문구 누락: ${code}`).toBeGreaterThan(4);
    }
  });

  it("네트워크 경로에 권한 확인을 지시하지 않는다", () => {
    const msg = friendlyError("네트워크 드라이브는 분석할 수 없습니다.");
    expect(msg).toContain("연결된 디스크만");
    expect(msg).not.toContain("접근 권한을 확인");
  });

  it("모르는 오류에는 백엔드 원문 대신 코드를 낸다", () => {
    // 폴백에서 message 를 그대로 쓰면 그것은 lib.rs 가 만든 한국어 문자열이라,
    // 언어를 추가해도 미지 코드 경로에서만 백엔드 문구가 새어 나온다.
    const msg = friendlyError({ code: "brandNew", detail: "", message: "볼륨을 열지 못했습니다" });
    expect(msg).toContain("code=brandNew");
    expect(msg).not.toContain("볼륨을 열지 못했습니다");
    // 원문은 '자세한 내용'에 그대로 남으므로 정보가 사라지지는 않는다.
    expect(errorDetail({ code: "brandNew", detail: "", message: "볼륨을 열지 못했습니다" })).toContain(
      "볼륨을 열지 못했습니다",
    );
  });

  it("문자열로만 온 오류도 같은 형식으로 접는다", () => {
    expect(friendlyError("os error 1392")).toContain("code=unknown");
    expect(friendlyError("   ")).toContain("code=unknown");
  });
});

describe("errorDetail", () => {
  it("코드와 문제 경로를 함께 남긴다", () => {
    const text = errorDetail({
      code: "notFound",
      detail: "Z:\\없음",
      message: "경로를 찾을 수 없습니다.",
    });
    expect(text).toContain("code=notFound");
    expect(text).toContain("Z:\\없음");
  });
});

describe("isBenignError", () => {
  it("재진입 방어는 실패가 아니다", () => {
    expect(isBenignError({ code: "busy", detail: "", message: "" })).toBe(true);
    expect(isBenignError({ code: "notFound", detail: "", message: "" })).toBe(false);
    expect(isBenignError("이미 스캔이 진행 중입니다.")).toBe(true);
  });
});

describe("errorAction", () => {
  it("다시 눌러도 결과가 같은 오류에는 '다시 시도'를 주지 않는다", () => {
    expect(errorAction({ code: "remoteDrive", detail: "", message: "" })).toBe("pick");
    expect(errorAction({ code: "uncRejected", detail: "", message: "" })).toBe("pick");
    expect(errorAction({ code: "busy", detail: "", message: "" })).toBe("none");
    expect(errorAction({ code: "notFound", detail: "", message: "" })).toBe("retry");
    expect(errorAction("os error 1392")).toBe("retry");
  });
});
