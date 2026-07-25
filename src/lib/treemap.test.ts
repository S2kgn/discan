import { describe, expect, it } from "vitest";
import { ScanNode } from "../types";
import { dominantCategories, squarify } from "./treemap";

function file(name: string, size: number, category?: string): ScanNode {
  return { name, path: `C:\\${name}`, size, files: 1, isDir: false, children: [], truncated: 0, category };
}
function dir(name: string, size: number, children: ScanNode[]): ScanNode {
  return { name, path: `C:\\${name}`, size, files: children.length, isDir: true, children, truncated: 0 };
}

describe("squarify", () => {
  it("타일 면적의 합이 캔버스 면적과 같다(값 비례)", () => {
    const nodes = [file("a", 600), file("b", 300), file("c", 100)];
    const tiles = squarify(nodes, 0, 0, 100, 100);
    const area = tiles.reduce((s, t) => s + t.w * t.h, 0);
    expect(area).toBeCloseTo(10000, 5); // 100×100
    // 각 타일 면적이 값 비율과 일치한다.
    const byName = Object.fromEntries(tiles.map((t) => [t.node.name, t.w * t.h]));
    expect(byName.a).toBeCloseTo(6000, 3);
    expect(byName.b).toBeCloseTo(3000, 3);
    expect(byName.c).toBeCloseTo(1000, 3);
  });

  it("모든 타일이 캔버스 경계 안에 있다", () => {
    const nodes = [file("a", 50), file("b", 30), file("c", 12), file("d", 8)];
    const tiles = squarify(nodes, 0, 0, 200, 120);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-6);
      expect(t.y).toBeGreaterThanOrEqual(-1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(200 + 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(120 + 1e-6);
    }
  });

  it("크기 0·빈 입력·0 캔버스는 빈 배열", () => {
    expect(squarify([file("z", 0)], 0, 0, 100, 100)).toEqual([]);
    expect(squarify([], 0, 0, 100, 100)).toEqual([]);
    expect(squarify([file("a", 10)], 0, 0, 0, 100)).toEqual([]);
  });
});

describe("dominantCategories", () => {
  it("잎은 자기 분야, 폴더는 하위 바이트가 최대인 분야", () => {
    const tree = dir("root", 1000, [
      dir("media", 700, [file("a.mp4", 500, "video"), file("b.jpg", 200, "image")]),
      file("c.rs", 300, "code"),
    ]);
    const dom = dominantCategories(tree);
    expect(dom.get(tree)).toBe("video"); // 500(video) > 300(code) > 200(image)
    const media = tree.children[0];
    expect(dom.get(media)).toBe("video"); // 500 > 200
  });

  it("분야 없는 잎은 other 로 집계한다", () => {
    const tree = dir("root", 100, [file("x", 100)]);
    expect(dominantCategories(tree).get(tree)).toBe("other");
  });
});
