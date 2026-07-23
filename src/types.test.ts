import { describe, expect, it } from "vitest";
import {
  CATEGORY_KEYS,
  ScanNode,
  categoryColor,
  categoryLabel,
  driveBlockedReason,
  extLabel,
  isExtOverflowRow,
  truncateParts,
  unexplainedTruncatedBytes,
} from "./types";

function node(over: Partial<ScanNode> = {}): ScanNode {
  return {
    name: "n",
    path: "C:\\n",
    size: 0,
    files: 0,
    isDir: true,
    children: [],
    truncated: 0,
    ...over,
  };
}

describe("truncateParts", () => {
  it("사유가 하나면 총합이 그 사유의 몫이다", () => {
    const parts = truncateParts(node({ truncated: 5, truncatedBytes: 400, truncatedReason: "depth" }));
    expect(parts).toEqual([{ reason: "depthLimit", count: 5, bytes: 400 }]);
  });

  it("사유별 바이트가 오면 그대로 나눈다", () => {
    const parts = truncateParts(
      node({
        truncated: 50,
        truncatedBytes: 500,
        truncatedSmall: 30,
        truncatedCapped: 20,
        truncatedBytesSmall: 200,
        truncatedBytesCapped: 300,
      }),
    );
    expect(parts).toEqual([
      { reason: "childCap", count: 20, bytes: 300 },
      { reason: "smallShare", count: 30, bytes: 200 },
    ]);
    expect(unexplainedTruncatedBytes(node({ truncated: 0 }))).toBe(0);
  });

  it("사유가 둘인데 바이트 분해가 없으면 차액을 남긴다", () => {
    // 이 차액을 화면에 적지 않으면 '생략한 것은 개수·크기·사유를 남긴다'가 깨진다.
    const n = node({ truncated: 50, truncatedBytes: 500, truncatedSmall: 30, truncatedCapped: 20 });
    expect(truncateParts(n).every((p) => p.bytes === 0)).toBe(true);
    expect(unexplainedTruncatedBytes(n)).toBe(500);
  });

  it("생략이 없으면 빈 배열", () => {
    expect(truncateParts(node())).toEqual([]);
  });
});

describe("확장자 센티널", () => {
  it("ASCII 센티널만 표시 문구로 바꾼다", () => {
    // 한국어 리터럴도 함께 받아들이던 호환 잔재를 걷어냈다 — 계약은 백엔드의
    // EXT_OVERFLOW_KEY/EXT_NONE_KEY 하나뿐이고, 표시 문구는 여기서만 정한다.
    expect(extLabel("__overflow")).toBe("그 밖의 확장자");
    expect(extLabel("__none")).toBe("확장자 없음");
    expect(extLabel("__residual")).toBe("상위 목록 외 나머지");
    expect(extLabel("mp4")).toBe("mp4");
  });

  it("잔여 합산 행만 골라낼 수 있다", () => {
    expect(isExtOverflowRow("__overflow")).toBe(true);
    expect(isExtOverflowRow("zip")).toBe(false);
  });
});

describe("driveBlockedReason", () => {
  it("원격 드라이브는 카드 단계에서 막는다", () => {
    expect(driveBlockedReason({ path: "Z:\\", label: "z", total: 1, free: 1, driveType: "remote" }))
      .toContain("네트워크");
  });

  it("정상 고정 디스크는 막지 않는다", () => {
    expect(
      driveBlockedReason({ path: "C:\\", label: "c", total: 100, free: 10, driveType: "fixed" }),
    ).toBeNull();
  });
});

describe("분야 사전", () => {
  it("백엔드가 색·라벨을 실어 보내면 그것을 우선한다", () => {
    const stat = { key: "video", size: 1, files: 1, color: "#123456", label: "Video" };
    expect(categoryColor(stat)).toBe("#123456");
    // 라벨만은 프런트 사전이 이긴다(언어 추가에 Rust 재빌드가 필요 없어야 한다).
    expect(categoryLabel(stat)).toBe("영상");
  });

  it("모든 분야 키가 색으로 해석된다", () => {
    for (const key of CATEGORY_KEYS) {
      expect(categoryColor({ key, size: 0, files: 0 })).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
