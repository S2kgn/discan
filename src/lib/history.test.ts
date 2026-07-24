import { describe, expect, it } from "vitest";
import { HISTORY_MAX, History, compareMessage, pruneHistory } from "./history";

const GiB = 1024 ** 3;

describe("compareMessage", () => {
  const NOW = new Date("2026-07-23T09:00:00.000Z");

  it("직전 기록이 없으면 비교하지 않는다", () => {
    expect(compareMessage(undefined, { size: 10 * GiB }).text).toBe("");
  });

  it("1MiB 미만 차이는 잡음으로 본다", () => {
    expect(
      compareMessage({ size: 10 * GiB, at: "2026-07-20T00:00:00.000Z" }, { size: 10 * GiB - 1000 })
        .text,
    ).toBe("");
  });

  it("줄어든 만큼을 말하고 방향을 함께 낸다", () => {
    const c = compareMessage(
      { size: 42 * GiB, at: "2026-07-20T00:00:00.000Z" },
      { size: 10 * GiB },
      NOW,
    );
    expect(c.text).toContain("32.0 GiB 줄었습니다");
    expect(c.direction).toBe("decrease");
  });

  it("늘어난 경우는 방향이 반대다", () => {
    const c = compareMessage(
      { size: 10 * GiB, at: "2026-07-20T00:00:00.000Z" },
      { size: 12 * GiB },
      NOW,
    );
    expect(c.text).toContain("2.00 GiB 늘었습니다");
    expect(c.direction).toBe("increase");
  });

  it("같은 날 재스캔은 날짜가 아니라 시각으로 적는다", () => {
    const c = compareMessage(
      { size: 42 * GiB, at: "2026-07-23T08:00:00.000Z" },
      { size: 10 * GiB },
      NOW,
      "ko-KR",
    );
    expect(c.text).toContain("오늘");
    expect(c.text).not.toContain("2026.");
  });

  it("날짜가 깨져 있어도 문장은 만든다", () => {
    expect(compareMessage({ size: 4 * GiB, at: "쓰레기" }, { size: 1 * GiB }, NOW).text).toContain(
      "지난 스캔 대비",
    );
  });

  it("접근 실패 건수가 크게 다르면 총량 비교를 하지 않는다", () => {
    const c = compareMessage(
      { size: 42 * GiB, at: "2026-07-20T00:00:00.000Z", errors: 4000 },
      { size: 10 * GiB, errors: 3 },
      NOW,
    );
    expect(c.text).toContain("총량 비교가 어렵습니다");
    expect(c.text).not.toContain("줄었습니다");
    expect(c.direction).toBe("unknown");
  });

  /**
   * 권한 차이는 errors 드리프트 상한(50건) 안에서도 수 GB 를 만든다 —
   * 큰 폴더 몇 개만 막히면 그렇다. 그때 '늘었습니다'로 보고하면 정리 성과의 오독이다.
   */
  it("실행 권한이 달라지면 총량 비교를 하지 않는다", () => {
    const c = compareMessage(
      { size: 42 * GiB, at: "2026-07-20T00:00:00.000Z", errors: 10, elevated: true },
      { size: 41 * GiB, errors: 12, elevated: false },
      NOW,
    );
    expect(c.direction).toBe("unknown");
    expect(c.text).toContain("실행 권한이 달라");
    expect(c.text).not.toContain("줄었습니다");
  });

  it("집계 기준이 달라지면 총량 비교를 하지 않는다", () => {
    const c = compareMessage(
      { size: 42 * GiB, at: "2026-07-20T00:00:00.000Z", sizeBasis: "logical" },
      { size: 30 * GiB, sizeBasis: "allocated" },
      NOW,
    );
    expect(c.direction).toBe("unknown");
    expect(c.text).toContain("집계 기준이 달라");
  });

  /**
   * hardlink → none 은 errors 드리프트(50건)에 잡히지 않으면서도 WinSxS·패키지 캐시를
   * 링크 수만큼 재계수해 총량을 GB 단위로 부풀린다. elevated 와 같은 오독이므로 유보한다.
   */
  it("중복 제거 기준이 달라지면 총량 비교를 하지 않는다", () => {
    const c = compareMessage(
      { size: 30 * GiB, at: "2026-07-20T00:00:00.000Z", dedup: "hardlink" },
      { size: 42 * GiB, dedup: "none" },
      NOW,
    );
    expect(c.direction).toBe("unknown");
    expect(c.text).toContain("중복 제거 기준이 달라");
    expect(c.text).toContain("하드링크 중복 제거 → 중복 제거 없음");
    expect(c.text).not.toContain("늘었습니다");
  });

  it("권한이 같으면 평소대로 비교한다", () => {
    const c = compareMessage(
      { size: 42 * GiB, at: "2026-07-20T00:00:00.000Z", elevated: false },
      { size: 10 * GiB, elevated: false },
      NOW,
    );
    expect(c.direction).toBe("decrease");
  });
});

describe("pruneHistory", () => {
  const now = Date.parse("2026-07-23T00:00:00.000Z");

  it("만료된 항목을 버린다", () => {
    const h: History = {
      old: { size: 1, at: "2025-01-01T00:00:00.000Z" },
      fresh: { size: 1, at: "2026-07-22T00:00:00.000Z" },
    };
    expect(Object.keys(pruneHistory(h, now))).toEqual(["fresh"]);
  });

  it("최신 순으로 상한만큼만 남긴다", () => {
    const h: History = {};
    for (let i = 0; i < HISTORY_MAX + 7; i += 1) {
      h[`C:\\p${i}`] = { size: i, at: new Date(now - i * 60_000).toISOString() };
    }
    const kept = pruneHistory(h, now);
    expect(Object.keys(kept)).toHaveLength(HISTORY_MAX);
    expect(kept["C:\\p0"]).toBeDefined();
    expect(kept[`C:\\p${HISTORY_MAX + 6}`]).toBeUndefined();
  });

  it("깨진 시각은 버린다", () => {
    expect(pruneHistory({ bad: { size: 1, at: "쓰레기" } }, now)).toEqual({});
  });
});
