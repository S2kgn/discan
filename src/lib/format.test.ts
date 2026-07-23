import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatBytesParts,
  formatClock,
  formatCount,
  formatDuration,
  formatPercent,
  percent,
  truncatePath,
  middlePath,
  baseName,
} from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [-1, "0 B"],
    [NaN, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1.00 KiB"],
    [1536, "1.50 KiB"],
    [10 * 1024, "10.0 KiB"],
    [100 * 1024, "100 KiB"],
    [1024 ** 3, "1.00 GiB"],
    [1024 ** 5, "1.00 PiB"],
    // PiB 를 넘어도 단위는 더 올라가지 않는다.
    [1024 ** 6, "1024 PiB"],
  ])("%s → %s", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it("값과 단위를 분리해 반환한다", () => {
    expect(formatBytesParts(1024 ** 3 * 7.34)).toEqual({ value: "7.34", unit: "GiB" });
  });

  // 목록 열에서 소수점이 세로로 맞으려면 자릿수가 값이 아니라 열에 따라 정해져야 한다.
  it("fixedDigits 를 주면 값과 무관하게 자릿수를 고정한다", () => {
    expect(formatBytesParts(933 * 1024 ** 3, { fixedDigits: 1 }).value).toBe("933.0");
    expect(formatBytesParts(12.83 * 1024 ** 3, { fixedDigits: 1 }).value).toBe("12.8");
    expect(formatBytesParts(1.68 * 1024 ** 3, { fixedDigits: 1 }).value).toBe("1.7");
    // 0 도 같은 자릿수여야 열이 어긋나지 않는다.
    expect(formatBytesParts(0, { fixedDigits: 1 }).value).toBe("0.0");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "1초 미만"],
    [999, "1초 미만"],
    [1000, "1초"],
    [59_499, "59초"],
    [60_000, "1분 0초"],
    [3_599_000, "59분 59초"],
    [3_600_000, "1시간 0분"],
    [7_260_000, "2시간 1분"],
    [-5, "0초"],
  ])("%s → %s", (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it.each([
    // 자릿수를 한 자리로 고정한다 — 같은 열의 '100%'와 '87.0%'는 소수점이 어긋난다.
    [0, "0.0%"],
    [-1, "0.0%"],
    // 0이 아닌데 0.0%로 뭉개지면 순위 정보가 사라진다.
    [0.001, "<0.1%"],
    [0.049, "<0.1%"],
    [0.05, "0.1%"],
    [17.94, "17.9%"],
    [100, "100.0%"],
  ])("%s → %s", (input, expected) => {
    expect(formatPercent(input)).toBe(expected);
  });
});

describe("percent", () => {
  it("분모가 0이면 0", () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(5, -1)).toBe(0);
  });

  it("비율을 백분율로", () => {
    expect(percent(1, 4)).toBe(25);
  });
});

describe("기타", () => {
  it("formatCount 는 천 단위 구분자를 넣는다", () => {
    expect(formatCount(33484).replace(/\u00a0/g, " ")).toContain("33");
    expect(formatCount(NaN)).toBe("0");
  });

  it("formatClock 은 mm:ss", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(61_000)).toBe("01:01");
  });

  it("truncatePath 는 꼬리를 남긴다", () => {
    expect(truncatePath("C:\\a\\b", 10)).toBe("C:\\a\\b");
    expect(truncatePath("C:\\very\\long\\path\\file.txt", 10)).toBe("…\\file.txt");
  });

  it("middlePath 는 드라이브와 마지막 폴더를 동시에 남긴다", () => {
    expect(middlePath("D:\\10_Dev\\Discan", 40)).toBe("D:\\10_Dev\\Discan");
    const short = middlePath("D:\\10_Dev\\Discan\\src-tauri\\target\\debug\\deps", 30);
    expect(short.startsWith("D:")).toBe(true);
    expect(short.endsWith("deps")).toBe(true);
    expect(short).toContain("…");
    expect(short.length).toBeLessThanOrEqual(30);
  });

  it("baseName 은 마지막 구성요소만 돌려준다", () => {
    expect(baseName("D:\\a\\b\\target")).toBe("target");
    expect(baseName("C:\\")).toBe("C:");
  });
});
