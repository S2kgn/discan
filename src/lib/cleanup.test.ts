import { describe, expect, it } from "vitest";
import { ScanNode } from "../types";
import { cleanupTips } from "./cleanup";

const GiB = 1024 ** 3;

function dir(name: string, size: number, children: ScanNode[] = [], path?: string): ScanNode {
  return { name, path: path ?? `C:\\${name}`, size, files: 1, isDir: true, children, truncated: 0 };
}

describe("cleanupTips", () => {
  it("휴지통·다운로드 같은 정답 후보를 크기순으로 짚는다", () => {
    const root = dir("C:\\", 100 * GiB, [
      dir("Downloads", 40 * GiB),
      dir("$RECYCLE.BIN", 12 * GiB),
      dir("Program Files", 30 * GiB),
    ]);

    const tips = cleanupTips(root, 100 * GiB);
    expect(tips.map((t) => t.id)).toEqual(["downloads", "recycle"]);
    expect(tips[0].size).toBe(40 * GiB);
    // 다운로드 폴더는 사본이 하나뿐인 문서가 섞이는 곳이라 '안전'으로 표시하지 않는다.
    expect(tips[0].risk).toBe("caution");
    expect(tips[1].risk).toBe("safe");
  });

  it("이름만으로 판정하면 오탐이 되는 빌드 폴더는 후보로 올리지 않는다", () => {
    // 백엔드는 빌드 지문이 있을 때만 캐시 힌트를 준다. 프런트가 이름만 보고
    // 그 판정을 뒤집으면 사진 라이브러리의 dist/ 가 삭제 권고 최상단에 온다.
    const root = dir("Photos", 100 * GiB, [
      dir("target", 30 * GiB),
      dir("dist", 25 * GiB),
      dir("build", 20 * GiB),
      dir("obj", 15 * GiB),
    ]);
    expect(cleanupTips(root, 100 * GiB)).toHaveLength(0);
  });

  it("같은 사유는 합산하고 대표 경로는 가장 큰 항목으로 잡는다", () => {
    const root = dir("dev", 30 * GiB, [
      dir("a", 20 * GiB, [dir("node_modules", 20 * GiB)]),
      dir("b", 5 * GiB, [dir("node_modules", 5 * GiB)]),
    ]);

    const [tip] = cleanupTips(root, 30 * GiB);
    expect(tip.id).toBe("node-modules");
    expect(tip.size).toBe(25 * GiB);
    expect(tip.count).toBe(2);
    expect(tip.path).toBe("C:\\node_modules");
  });

  it("중첩된 같은 사유를 두 번 세지 않는다", () => {
    const root = dir("dev", 10 * GiB, [
      dir("node_modules", 10 * GiB, [dir("node_modules", 4 * GiB)]),
    ]);

    const [tip] = cleanupTips(root, 10 * GiB);
    expect(tip.size).toBe(10 * GiB);
    expect(tip.count).toBe(1);
  });

  it(".git 은 위험 표시로 남긴다", () => {
    const root = dir("repo", 20 * GiB, [dir(".git", 8 * GiB)]);
    const [tip] = cleanupTips(root, 20 * GiB);
    expect(tip.id).toBe("vcs");
    expect(tip.risk).toBe("caution");
  });

  it("합계에 든 상위 경로를 함께 돌려준다", () => {
    // 합계만 알려 주고 대표 한 곳만 열어 주면 나머지에 도달할 길이 없다.
    const root = dir("dev", 60 * GiB, [
      dir("a", 30 * GiB, [dir("node_modules", 30 * GiB, [], "C:\\a\\node_modules")]),
      dir("b", 20 * GiB, [dir("node_modules", 20 * GiB, [], "C:\\b\\node_modules")]),
      dir("c", 10 * GiB, [dir("node_modules", 10 * GiB, [], "C:\\c\\node_modules")]),
    ]);

    const [tip] = cleanupTips(root, 60 * GiB);
    expect(tip.paths.map((h) => h.path)).toEqual([
      "C:\\a\\node_modules",
      "C:\\b\\node_modules",
      "C:\\c\\node_modules",
    ]);
    // 순위의 근거(크기)를 버리면 '왜 1위인지 알 수 없는 순위 목록'이 된다.
    expect(tip.paths.map((h) => h.size)).toEqual([30 * GiB, 20 * GiB, 10 * GiB]);
    // 나머지로 넘어갈 때 쓸 검색어도 함께 준다.
    expect(tip.query).toBe("node_modules");
  });

  it("굵게 낼 식별 이름은 규칙 이름이 아니라 그 위 조상이다", () => {
    // app-cache 규칙에 걸린 항목의 baseName 은 정의상 언제나 'Cache' 라, 그것을
    // 강조하면 80곳 중 어느 것인지 알려 주는 토큰이 화면에서 가장 약해진다.
    const root = dir("C:\\", 100 * GiB, [
      dir(
        "Cache",
        20 * GiB,
        [],
        "C:\\Users\\a\\AppData\\Local\\r_news_dark\\Default\\Cache",
      ),
    ]);
    const [tip] = cleanupTips(root, 100 * GiB);
    // 'Default' 는 Chromium 프로필마다 있어 판별력이 없으므로 함께 건너뛴다.
    expect(tip.label).toBe("r_news_dark");
    expect(tip.paths[0].label).toBe("r_news_dark");
  });

  it("전부 규칙·범용 이름뿐이면 마지막 구성요소로 떨어진다", () => {
    const root = dir("C:\\", 100 * GiB, [dir("Temp", 20 * GiB, [], "C:\\Temp")]);
    expect(cleanupTips(root, 100 * GiB)[0].label).toBe("Temp");
  });

  it("가지치기된 트리에서 나온 합계는 하한으로 표시한다", () => {
    // 백엔드는 임계 미만·깊이 초과·폴더당 상위 N개 밖을 결과에 싣기 전에 버린다.
    // 그 사실을 값에 실어 두지 않으면 화면이 '합계 1.57 GiB'를 확정 수치로 적는다.
    const root = dir("C:\\", 100 * GiB, [dir("Downloads", 40 * GiB)]);
    expect(cleanupTips(root, 100 * GiB)[0].isLowerBound).toBe(false);
    expect(cleanupTips(root, 100 * GiB, { minSize: 7 * 1024 * 1024 })[0].isLowerBound).toBe(true);

    // 임계값을 모르는 호출에서도 노드에 남은 생략 흔적으로 판정할 수 있다.
    const pruned = dir("C:\\", 100 * GiB, [
      { ...dir("Downloads", 40 * GiB), truncated: 12, truncatedBytes: 1024 },
    ]);
    expect(cleanupTips(pruned, 100 * GiB)[0].isLowerBound).toBe(true);
  });

  it("임계 미만은 제안하지 않는다", () => {
    const root = dir("C:\\", 100 * GiB, [dir("Downloads", 10 * 1024 * 1024)]);
    expect(cleanupTips(root, 100 * GiB)).toHaveLength(0);
  });
});
