import { describe, expect, it, vi } from "vitest";
import { ScanNode, truncateReasonOf, truncatedBytesOf, isFileNode } from "../types";
import {
  ancestorsOfMatches,
  collectFileNodes,
  collectPaths,
  countNodes,
  filterTree,
  sortNodes,
} from "./tree";

function dir(name: string, size: number, children: ScanNode[] = [], files = 0): ScanNode {
  return { name, path: `C:\\${name}`, size, files, isDir: true, children, truncated: 0 };
}

function file(name: string, size: number): ScanNode {
  return { name, path: `C:\\${name}`, size, files: 1, isDir: false, children: [], truncated: 0 };
}

const tree = dir("root", 1000, [
  dir("Downloads", 600, [file("movie.mp4", 500), dir("old", 100)], 3),
  dir("src", 400, [file("main.rs", 40)], 12),
]);

describe("sortNodes", () => {
  const nodes = [dir("b", 10, [], 5), dir("a", 30, [], 1), dir("c", 20, [], 9)];

  it("용량 내림차순이 기본", () => {
    expect(sortNodes(nodes, { key: "size", dir: "desc" }).map((n) => n.name)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("이름·파일 수로도 정렬한다", () => {
    expect(sortNodes(nodes, { key: "name", dir: "asc" }).map((n) => n.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortNodes(nodes, { key: "files", dir: "desc" }).map((n) => n.name)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("원본 배열을 바꾸지 않는다", () => {
    const before = nodes.map((n) => n.name);
    sortNodes(nodes, { key: "size", dir: "asc" });
    expect(nodes.map((n) => n.name)).toEqual(before);
  });
});

describe("filterTree", () => {
  it("빈 질의는 원본을 그대로 돌려준다", () => {
    expect(filterTree(tree, "  ")).toBe(tree);
  });

  it("일치 노드와 조상만 남긴다", () => {
    const filtered = filterTree(tree, "main");
    expect(filtered).not.toBeNull();
    expect(filtered!.children).toHaveLength(1);
    expect(filtered!.children[0].name).toBe("src");
    expect(filtered!.children[0].children[0].name).toBe("main.rs");
  });

  it("일치 노드의 하위는 유지한다", () => {
    const filtered = filterTree(tree, "downloads");
    expect(filtered!.children[0].children).toHaveLength(2);
  });

  it("일치가 없으면 null", () => {
    expect(filterTree(tree, "zzz")).toBeNull();
  });
});

describe("파일 노드", () => {
  it("isDir 이 없으면 디렉터리로 본다", () => {
    expect(isFileNode(dir("x", 1))).toBe(false);
    expect(isFileNode(file("x", 1))).toBe(true);
  });

  it("큰 것부터 모은다", () => {
    expect(collectFileNodes(tree).map((f) => f.name)).toEqual(["movie.mp4", "main.rs"]);
    expect(collectFileNodes(tree, 1)).toHaveLength(1);
  });
});

describe("생략 사유 정규화", () => {
  // 백엔드 note_truncated 가 실제로 보내는 값은 이 셋뿐이다. 느슨한 별칭 정규화는
  // 계약이 확정된 뒤에도 남겨 두면 다음 드리프트를 조용히 smallShare 로 떨어뜨린다.
  it.each([
    ["depth", "depthLimit"],
    ["count", "childCap"],
    ["size", "smallShare"],
    [undefined, "smallShare"],
  ])("%s → %s", (raw, expected) => {
    expect(truncateReasonOf({ ...dir("x", 1), truncatedReason: raw })).toBe(expected);
  });

  it("모르는 사유는 smallShare 로 떨어지되 개발 모드에서 소리를 낸다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(truncateReasonOf({ ...dir("x", 1), truncatedReason: "max_depth" })).toBe("smallShare");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("생략 합계는 백엔드가 확정한 한 이름만 읽는다", () => {
    expect(truncatedBytesOf({ ...dir("x", 1), truncatedBytes: 20 })).toBe(20);
    expect(truncatedBytesOf(dir("x", 1))).toBe(0);
  });
});

describe("ancestorsOfMatches", () => {
  it("빈 질의는 아무것도 펼치지 않는다", () => {
    expect(ancestorsOfMatches(tree, " ").size).toBe(0);
  });

  it("일치 노드의 조상만 펼치고 일치 노드 자신은 접어 둔다", () => {
    const open = ancestorsOfMatches(tree, "main");
    expect([...open].sort()).toEqual(["C:\\root", "C:\\src"]);
    expect(open.has("C:\\main.rs")).toBe(false);
  });

  it("일치 노드의 하위는 펼치지 않는다 — 검색 한 글자에 트리 전체가 열리던 원인", () => {
    const open = ancestorsOfMatches(tree, "downloads");
    expect([...open]).toEqual(["C:\\root"]);
    expect(open.has("C:\\Downloads")).toBe(false);
  });
});

describe("보조 함수", () => {
  it("노드 수와 경로 수집", () => {
    expect(countNodes(tree)).toBe(6);
    expect(collectPaths(tree, 1)).toEqual(["C:\\root"]);
    expect(collectPaths(tree, 2)).toHaveLength(3);
  });
});
