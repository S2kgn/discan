import { describe, expect, it } from "vitest";
import { ScanResult } from "../types";
import {
  allocatedNote,
  basisLines,
  breakdownErrors,
  conditionsSummary,
  describeCoverage,
  describeErrors,
  describeSkippedCloud,
  describeSkippedLinks,
  totalFootnote,
} from "./notice";

const GiB = 1024 ** 3;

function make(over: Partial<ScanResult> = {}): ScanResult {
  return {
    root: { name: "C:\\", path: "C:\\", size: 0, files: 0, isDir: true, children: [], truncated: 0 },
    categories: [],
    totalSize: 100 * GiB,
    totalFiles: 10,
    totalDirs: 2,
    errors: 0,
    elapsedMs: 100,
    cancelled: false,
    ...over,
  };
}

describe("breakdownErrors / describeErrors", () => {
  it("오류가 없으면 문단 자체가 없다", () => {
    expect(breakdownErrors(make())).toBeNull();
  });

  it("사유별로 쪼개고, 권한 문제일 때만 관리자 권한을 권한다", () => {
    const b = breakdownErrors(
      make({
        errors: 3,
        failedPaths: [
          { path: "a", kind: "tooLong" },
          { path: "b", kind: "tooDeep" },
          { path: "c", kind: "tooLong" },
        ],
      }),
    )!;
    expect(b.suggestElevation).toBe(false);
    const text = describeErrors(b);
    // 백엔드가 (경로, 갈래) 를 접으므로 이 값은 발생 건수가 아니라 고유 위치 수다.
    expect(text).toContain("경로 길이 초과 2곳");
    expect(text).toContain("깊이 상한 초과 1곳");
    expect(text).not.toContain("권한 거부");
  });

  it("권한 거부가 섞이면 승격 안내를 켠다", () => {
    const b = breakdownErrors(
      make({ errors: 2, failedPaths: [{ path: "a", kind: "denied" }, { path: "b", kind: "tooLong" }] }),
    )!;
    expect(b.suggestElevation).toBe(true);
  });

  it("표본이 상한에 걸리면 표본 기준임을 밝힌다", () => {
    const b = breakdownErrors(
      make({ errors: 3214, failedPaths: [{ path: "a", kind: "denied" }] }),
    )!;
    expect(b.sampled).toBe(true);
    expect(describeErrors(b)).toContain("기준");
  });

  it("표본이 아예 없으면 사유를 지어내지 않는다", () => {
    const b = breakdownErrors(make({ errors: 5 }))!;
    expect(describeErrors(b)).toContain("사유는 기록되지 않았습니다");
  });

  it("중복이 접혀 합이 맞지 않으면 잘리지 않았어도 표본 표기를 쓴다", () => {
    // 백엔드는 (경로, 갈래) 를 HashSet 으로 접으므로 한 디렉터리에서 오류가 세 번
    // 나도 목록은 1행이다. 그때 완결형 문장을 쓰면 '3건인데 사유별 합은 1' 이 된다.
    const b = breakdownErrors(
      make({
        errors: 3,
        failedPaths: [{ path: "C:\\x", kind: "other" }],
        failedPathsTruncated: false,
      }),
    )!;
    expect(b.sampled).toBe(true);
    const text = describeErrors(b);
    expect(text).toContain("기록된 위치 1곳 기준");
    // 총 건수와 고유 위치 수를 같은 명사로 나란히 적으면 산수가 맞지 않는 문장이 된다.
    expect(text).not.toContain("— 기타 오류 1곳.");
  });

  it("총수와 표본이 같으면 완결형으로 적는다", () => {
    const b = breakdownErrors(
      make({
        errors: 2,
        failedPaths: [
          { path: "a", kind: "denied" },
          { path: "b", kind: "denied" },
        ],
        failedPathsTruncated: false,
      }),
    )!;
    expect(b.sampled).toBe(false);
    expect(describeErrors(b)).toContain("— 권한 거부 2곳.");
  });
});

describe("건너뛴 항목", () => {
  it("링크와 클라우드 자리표시자를 서로 다른 문장으로 낸다", () => {
    const r = make({ skippedLinks: 12, skippedCloud: 3481, skippedCloudBytes: 2.7 * GiB });
    expect(describeSkippedLinks(r)).toContain("12건");
    expect(describeSkippedLinks(r)).not.toContain("온라인");
    expect(describeSkippedCloud(r)).toContain("3,481건");
    expect(describeSkippedCloud(r)).toContain("2.70 GiB");
  });

  it("링크가 0건이어도 자리표시자 문장은 나온다 (OneDrive 중심 볼륨)", () => {
    const r = make({ skippedLinks: 0, skippedCloud: 40000, skippedCloudBytes: 12 * GiB });
    expect(describeSkippedLinks(r)).toBeNull();
    expect(describeSkippedCloud(r)).toContain("40,000건");
  });

  it("둘 다 0이면 아무 문장도 없다", () => {
    expect(describeSkippedLinks(make())).toBeNull();
    expect(describeSkippedCloud(make())).toBeNull();
  });
});

describe("describeCoverage", () => {
  it("드라이브 사용량을 모르면 대조하지 않는다", () => {
    expect(describeCoverage(make(), 0)).toBeNull();
  });

  it("합계가 사용량을 넘으면 하드링크 중복 계수를 짚는다", () => {
    const c = describeCoverage(make({ totalSize: 520 * GiB }), 499 * GiB)!;
    expect(c.text).toContain("하드링크");
    expect(c.text).not.toContain("확인했습니다");
  });

  it("미달분의 원인을 권한 하나로 단정하지 않는다", () => {
    const c = describeCoverage(make({ totalSize: 80 * GiB, skippedCloud: 10 }), 100 * GiB)!;
    expect(c.text).toContain("온라인 전용 파일");
    expect(c.text).toContain("논리 크기와 할당 크기의 차이");
  });

  it("커버리지가 높으면 경고색을 쓰지 않는다", () => {
    expect(describeCoverage(make({ totalSize: 95 * GiB }), 100 * GiB)!.tone).toBe("info");
    expect(describeCoverage(make({ totalSize: 20 * GiB }), 100 * GiB)!.tone).toBe("warn");
  });
});

describe("basisLines", () => {
  it("오류가 없어도 집계 조건은 늘 나온다", () => {
    const lines = basisLines(make());
    expect(lines[0]).toContain("하드링크 중복 제거 없음");
  });

  it("단위 정의를 결과 화면에서도 볼 수 있다", () => {
    // 대상 패널이 접히면 그쪽 안내는 사라진다. 여기가 유일한 상시 고지가 된다.
    expect(basisLines(make())[0]).toContain("1 KiB = 1024 B");
  });

  it("중복 제거의 실제 범위를 밝힌다", () => {
    // '중복 제거함/안 함' 한 마디는 두 방향으로 오해된다. 백엔드가 두 축을 실어
    // 보내는데 화면에는 한 번도 나오지 않았다.
    const off = basisLines(make({ dedup: "none", dedupDisabledReason: "unstableFileIds" })).join("\n");
    expect(off).toContain("파일 식별자가 안정적이지 않아");

    const on = basisLines(
      make({
        dedup: "hardlink",
        hardlinkDedupedFiles: 120,
        hardlinkDedupedBytes: 3 * GiB,
        dedupMinBytes: 64 * 1024,
      }),
    ).join("\n");
    expect(on).toContain("120건");
    expect(on).toContain("64.0 KiB 미만 파일은 추적하지 않았으므로");
  });

  it("점유를 단정할 수 없는 파일 수를 함께 적는다", () => {
    const lines = basisLines(
      make({ allocUncertainFiles: 42, allocUncertainBytes: 1024 * 1024 }),
    ).join("\n");
    expect(lines).toContain("NTFS 압축·희소 파일 42건");
  });

  it("할당 추정치와 가지치기 임계를 함께 적는다", () => {
    const lines = basisLines(
      make({
        totalSize: 12 * GiB,
        allocatedEstimate: 12.4 * GiB,
        clusterBytes: 4096,
        fileSystem: "NTFS",
        pruneParams: { minSize: 6 * 1024 * 1024, maxDepth: 12, maxChildren: 80 },
      }),
    ).join("\n");
    expect(lines).toContain("12.4 GiB");
    expect(lines).toContain("NTFS");
    expect(lines).toContain("최대 깊이 12");
  });
});

describe("allocatedNote", () => {
  it("차액이 1% 미만이면 숫자를 반복하지 않되 산출 범위는 남긴다", () => {
    // 같은 표시 문자열이 두 번 나오면 설명이 아니라 소음이다. 다만 근사 주장이 가장
    // 강하게 나가는 순간에 그 한계가 화면 어디에도 없으면 안 된다.
    const note = allocatedNote(
      make({ totalSize: 12.8 * GiB, allocatedEstimate: 12.8 * GiB + 40 * 1024 * 1024 }),
    )!;
    expect(note).toContain("거의 같습니다");
    expect(note).toContain("디렉터리 자체가 쓰는 공간은 세지 않았고");
    expect(note).toContain("하드링크 중복도 반영되지 않아");
  });

  it("차액이 크면 절대 차액을 함께 낸다", () => {
    const note = allocatedNote(
      make({ totalSize: 10 * GiB, allocatedEstimate: 11 * GiB, clusterBytes: 4096, fileSystem: "NTFS" }),
    )!;
    expect(note).toContain("11.0 GiB");
    expect(note).toContain("+1.00 GiB");
    // 탐색기 값과 '대응한다'고 단정하지 않는다.
    expect(note).toContain("탐색기 값과 다를 수 있습니다");
  });

  it("추정치가 없으면 아무 말도 하지 않는다", () => {
    expect(allocatedNote(make())).toBeNull();
  });

  it("파일시스템이 셈한 값(allocationSize)은 '추정'으로 낮춰 적지 않는다", () => {
    // Windows 실사용의 기본 갈래다. 파일시스템이 항목마다 보고한 할당 바이트를
    // 그대로 더한 값이라 근사가 아니고, 그것을 '추정'이라 적으면 값의 성격을 낮춘다.
    const note = allocatedNote(
      make({
        totalSize: 10 * GiB,
        allocatedEstimate: 11 * GiB,
        allocBasis: "allocationSize",
        clusterBytes: 4096,
        fileSystem: "NTFS",
      }),
    )!;
    expect(note).toContain("11.0 GiB");
    expect(note).not.toContain("추정");
    expect(note).toContain("근사가 아닙니다");
    // 파일만 더한 값이라는 산출 범위는 여전히 밝혀야 한다.
    expect(note).toContain("디렉터리 자체가 쓰는 공간은 세지 않았습니다");
  });

  it("압축·희소 파일이 섞여 있으면 그 값도 단정하지 않는다", () => {
    const note = allocatedNote(
      make({
        totalSize: 10 * GiB,
        allocatedEstimate: 11 * GiB,
        allocBasis: "allocationSize",
        allocUncertainFiles: 3,
        allocUncertainBytes: 512 * 1024 * 1024,
      }),
    )!;
    expect(note).toContain("추정");
    expect(note).toContain("NTFS 압축·희소 파일이 섞여 있어");
  });

  it("점유가 논리 합계보다 크게 작으면 '거의 같다'고 하지 않는다", () => {
    // 클러스터 올림만 하던 시절에는 구조적으로 diff>=0 이었다. 파일시스템 보고
    // 값에서는 압축·희소·MFT 상주 파일이 점유를 논리 크기 아래로 끌어내린다.
    const note = allocatedNote(
      make({ totalSize: 10 * GiB, allocatedEstimate: 6 * GiB, allocBasis: "allocationSize" }),
    )!;
    expect(note).toContain("논리 합계보다 작습니다");
    expect(note).toContain("-4.00 GiB");
    expect(note).not.toContain("거의 같습니다");
  });

  it("산출하지 못한 볼륨(unknown)에는 산출 범위를 붙이지 않는다", () => {
    expect(
      allocatedNote(make({ totalSize: 10 * GiB, allocatedEstimate: 11 * GiB, allocBasis: "unknown" })),
    ).toBeNull();
  });
});

describe("totalFootnote", () => {
  it("클러스터 크기를 못 읽은 볼륨에서는 타일 각주를 비우고 집계 조건으로 내린다", () => {
    // allocBasis="unknown" 은 GetDiskFreeSpaceW 실패·마운트 지점·비Windows 다.
    // 스캔마다 변하지 않는 조건이라 첫 화면의 11px 회색 줄을 차지할 이유가 없다.
    // 다만 사라져서도 안 된다 — 0을 '점유 없음'으로 읽으면 결론이 뒤집힌다.
    const r = make({ totalSize: 12 * GiB, allocBasis: "unknown" });
    expect(totalFootnote(r)).toBeNull();
    expect(basisLines(r).join("\n")).toContain("클러스터 크기를 읽지 못해");
  });

  it("Windows 기본값(allocationSize)에서도 각주가 사라지지 않는다", () => {
    // 이 비교가 `=== "clusterRoundUp"` 이던 시절, 백엔드가 Windows 기본값을 바꾸자
    // 실사용 전량에서 각주가 조용히 비었다. 컴파일러가 건너지 못한 경계다.
    const s = totalFootnote(
      make({ totalSize: 10 * GiB, allocatedEstimate: 11 * GiB, allocBasis: "allocationSize" }),
    );
    expect(s).toContain("+1.00 GiB");
  });

  it("클러스터 올림으로 산출했고 차액이 크면 그 차액을 낸다", () => {
    const s = totalFootnote(
      make({ totalSize: 10 * GiB, allocatedEstimate: 11 * GiB, allocBasis: "clusterRoundUp" }),
    );
    expect(s).toContain("+1.00 GiB");
  });

  it("차액이 1% 미만이면 타일에서는 아무 말도 하지 않는다", () => {
    const r = make({
      totalSize: 10 * GiB,
      allocatedEstimate: 10 * GiB + 1024,
      allocBasis: "clusterRoundUp",
    });
    expect(totalFootnote(r)).toBeNull();
    // 근사 주장과 그 한계는 접히는 '집계 조건' 안에 함께 있어야 한다.
    expect(basisLines(r).join("\n")).toContain("거의 같습니다");
  });
});

describe("conditionsSummary", () => {
  it("접힌 상태에서도 무엇이 빠졌는지는 보인다", () => {
    const s = conditionsSummary(
      make({
        skippedCloud: 12,
        pruneParams: { minSize: 6 * 1024 * 1024, maxDepth: 12, maxChildren: 80 },
      }),
    );
    // 접힌 줄은 사람 말로 쓴다 — '하드링크 미중복제거'·'7.09 MiB 미만'은 뜻을
    // 짐작할 수조차 없어, 접었는데도 읽히지 않는 줄이 그대로 남았다.
    expect(s).toContain("온라인 전용 파일 12건");
    expect(s).toContain("아주 작은 폴더");
    expect(s).not.toContain("하드링크");
  });

  it("온라인 전용 파일이 0건이면 뺐다고 단정하지 않는다", () => {
    // 접힌 줄은 사용자가 얻는 1차 정보다. 발생하지 않은 제외를 과거형으로 적으면
    // 펼친 본문(describeSkippedCloud 는 0건이면 null)과 서로 다른 사실을 말하게 된다.
    const s = conditionsSummary(
      make({ skippedCloud: 0, pruneParams: { minSize: 1, maxDepth: 12, maxChildren: 80 } }),
    );
    expect(s).not.toContain("온라인 전용");
    expect(s).toContain("아주 작은 폴더");
  });

  it("둘 다 없으면 중립 문구로 떨어진다", () => {
    expect(conditionsSummary(make())).toBe("이 숫자는 어떻게 셌나요 — 집계 기준·가지치기 조건");
  });
});
