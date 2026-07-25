import { describe, expect, it } from "vitest";
import { DuplicateGroup } from "../types";
import { autoSelect, groupsFullySelected, selectionStats } from "./dupeSelection";

const groups: DuplicateGroup[] = [
  { size: 1000, count: 3, reclaimable: 2000, paths: ["C:\\a", "C:\\b", "C:\\c"] },
  { size: 500, count: 2, reclaimable: 500, paths: ["C:\\x", "C:\\y"] },
];

describe("autoSelect", () => {
  it("그룹마다 첫 경로를 남기고 나머지를 고른다", () => {
    const sel = autoSelect(groups);
    expect(sel.has("C:\\a")).toBe(false); // 남김
    expect(sel.has("C:\\b")).toBe(true);
    expect(sel.has("C:\\c")).toBe(true);
    expect(sel.has("C:\\x")).toBe(false); // 남김
    expect(sel.has("C:\\y")).toBe(true);
    expect(sel.size).toBe(3);
  });
});

describe("selectionStats", () => {
  it("선택 파일 수와 회수 용량(그룹 크기 기준)을 센다", () => {
    const { count, bytes } = selectionStats(groups, autoSelect(groups));
    expect(count).toBe(3);
    expect(bytes).toBe(1000 * 2 + 500 * 1); // b,c(각 1000) + y(500)
  });
});

describe("groupsFullySelected", () => {
  it("모든 사본이 선택된 그룹(원본까지 지워질)을 잡아낸다", () => {
    const sel = new Set(["C:\\a", "C:\\b", "C:\\c"]); // 첫 그룹 전체
    const bad = groupsFullySelected(groups, sel);
    expect(bad).toHaveLength(1);
    expect(bad[0].paths).toContain("C:\\a");
  });
  it("하나라도 남기면 안전하다", () => {
    expect(groupsFullySelected(groups, autoSelect(groups))).toHaveLength(0);
  });
});
