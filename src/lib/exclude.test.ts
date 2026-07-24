import { describe, expect, it } from "vitest";
import { ScanNode } from "../types";
import { applyFolderExclusions } from "./exclude";

/** 테스트용 노드. size 는 하위 합 + 자기 잔여를 직접 적는다(백엔드 불변식과 동형). */
function dir(name: string, path: string, size: number, children: ScanNode[] = []): ScanNode {
  return { name, path, size, files: 0, isDir: true, children, truncated: 0 };
}
function file(name: string, path: string, size: number): ScanNode {
  return { name, path, size, files: 1, isDir: false, children: [], truncated: 0 };
}

const TREE = dir("root", "C:\\r", 1000, [
  dir("a", "C:\\r\\a", 600, [
    file("a1", "C:\\r\\a\\a1", 400),
    file("a2", "C:\\r\\a\\a2", 200),
  ]),
  dir("b", "C:\\r\\b", 300, [file("b1", "C:\\r\\b\\b1", 300)]),
  file("c", "C:\\r\\c", 100),
]);

describe("applyFolderExclusions", () => {
  it("제외가 없으면 트리와 총계가 그대로다", () => {
    const r = applyFolderExclusions(TREE, new Set());
    expect(r.excludedSize).toBe(0);
    expect(r.tree.size).toBe(1000);
    expect(r.items).toHaveLength(0);
  });

  it("폴더를 제외하면 그 크기가 상위·총계에서 빠지고 노드는 표식만 남는다", () => {
    const r = applyFolderExclusions(TREE, new Set(["C:\\r\\a"]));
    expect(r.excludedSize).toBe(600);
    expect(r.tree.size).toBe(400); // 1000 - 600
    // 제외 노드는 트리에 남아 원래 크기를 그대로 보여 준다(취소선·원복 대상).
    const a = r.tree.children.find((c) => c.path === "C:\\r\\a")!;
    expect(a.excluded).toBe(true);
    expect(a.size).toBe(600);
    expect(r.items).toEqual([{ path: "C:\\r\\a", name: "a", size: 600 }]);
  });

  it("여러 항목 제외분을 합산하고 큰 것부터 목록에 싣는다", () => {
    const r = applyFolderExclusions(TREE, new Set(["C:\\r\\b", "C:\\r\\c"]));
    expect(r.excludedSize).toBe(400); // 300 + 100
    expect(r.tree.size).toBe(600);
    expect(r.items.map((i) => i.name)).toEqual(["b", "c"]); // 300 먼저
  });

  it("제외된 폴더 안의 제외는 이중 계산하지 않는다(최상위 하나만 목록에 남는다)", () => {
    // a 와 그 자식 a1 을 모두 제외해도, a 크기(600)에 a1(400)이 이미 들어 있다.
    const r = applyFolderExclusions(TREE, new Set(["C:\\r\\a", "C:\\r\\a\\a1"]));
    expect(r.excludedSize).toBe(600); // 1000 이 아니라 600 — a1 을 또 빼지 않는다
    expect(r.tree.size).toBe(400);
    expect(r.items).toEqual([{ path: "C:\\r\\a", name: "a", size: 600 }]);
  });

  it("원본을 건드리지 않고, 집합이 바뀌면 원본에 다시 적용해 총계를 낸다", () => {
    // 이 함수는 언제나 원본 트리에 적용된다(App 의 useMemo 가 result.root 에 건다).
    // 제외를 늘려도 원본이 바뀌지 않으므로 같은 원본에 새 집합을 걸면 결과가 누적이
    // 아니라 그 집합만의 결과로 나온다 — 원본 불변이 이 동작의 전제다.
    const one = applyFolderExclusions(TREE, new Set(["C:\\r\\a"]));
    expect(one.tree.size).toBe(400);
    expect(TREE.size).toBe(1000); // 원본은 그대로

    const more = applyFolderExclusions(TREE, new Set(["C:\\r\\a", "C:\\r\\b"]));
    expect(more.tree.size).toBe(100); // 1000 - 600 - 300
    expect(more.excludedSize).toBe(900);
  });
});
