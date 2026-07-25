import { ScanNode } from "../types";

/** 배치된 타일 하나. 좌표·크기는 부모 사각형 안의 픽셀(또는 임의 단위)이다. */
export interface TreemapTile {
  node: ScanNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Sized {
  node: ScanNode;
  value: number;
}

/**
 * Squarified treemap (Bruls·Huizing·van Wijk, 2000).
 *
 * 단순 slice-and-dice 는 종횡비가 극단으로 벌어져(가느다란 띠) 크기 비교가 안 된다.
 * squarify 는 각 행의 최악 종횡비를 최소화해 타일이 정사각에 가깝게 유지된다 —
 * 이 앱의 목적이 '어느 것이 큰가'의 시각 비교이므로 종횡비가 핵심이다.
 *
 * 순수 함수라 UI 없이 테스트로 잠근다.
 */
export function squarify(
  nodes: ScanNode[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreemapTile[] {
  const items: Sized[] = nodes
    .map((node) => ({ node, value: Math.max(0, node.size) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (items.length === 0 || w <= 0 || h <= 0) return [];

  const total = items.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return [];

  // 값을 넓이로 환산: 전체 값 → 전체 면적.
  const area = (w * h) / total;
  const scaled = items.map((s) => ({ node: s.node, area: s.value * area }));

  const tiles: TreemapTile[] = [];
  // 남은 영역. 가로가 길면 세로로 채우고(짧은 변을 따라 행을 쌓는다), 반대도 같다.
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;

  let row: { node: ScanNode; area: number }[] = [];

  const shortSide = () => Math.min(rw, rh);

  // 한 행의 최악 종횡비. 짧은 변 길이 side 에 area 합을 채웠을 때.
  const worst = (r: { area: number }[], side: number): number => {
    if (r.length === 0) return Infinity;
    const sum = r.reduce((s, i) => s + i.area, 0);
    const max = Math.max(...r.map((i) => i.area));
    const min = Math.min(...r.map((i) => i.area));
    const side2 = side * side;
    const sum2 = sum * sum;
    return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
  };

  const layoutRow = (r: { node: ScanNode; area: number }[]) => {
    const sum = r.reduce((s, i) => s + i.area, 0);
    if (sum <= 0) return;
    if (rw >= rh) {
      // 세로로 쌓은 행을 왼쪽에 붙이고, 남은 영역을 오른쪽으로 좁힌다.
      const colW = sum / rh;
      let cy = ry;
      for (const it of r) {
        const th = (it.area / sum) * rh;
        tiles.push({ node: it.node, x: rx, y: cy, w: colW, h: th });
        cy += th;
      }
      rx += colW;
      rw -= colW;
    } else {
      // 가로로 쌓은 행을 위에 붙이고, 남은 영역을 아래로 좁힌다.
      const rowH = sum / rw;
      let cx = rx;
      for (const it of r) {
        const tw = (it.area / sum) * rw;
        tiles.push({ node: it.node, x: cx, y: ry, w: tw, h: rowH });
        cx += tw;
      }
      ry += rowH;
      rh -= rowH;
    }
  };

  for (const it of scaled) {
    const side = shortSide();
    if (row.length === 0 || worst([...row, it], side) <= worst(row, side)) {
      row.push(it);
    } else {
      layoutRow(row);
      row = [it];
    }
  }
  if (row.length > 0) layoutRow(row);

  return tiles;
}

/**
 * 노드별 '지배 분야'(하위에서 바이트가 가장 큰 분야 키)를 미리 계산한다.
 *
 * 트리맵 타일은 분야 색으로 칠해야 사용자가 이미 익힌 색과 일치한다. 파일 잎은
 * 자기 category 를 쓰고, 폴더는 하위 잎들의 분야별 바이트를 합쳐 최대인 것을 쓴다.
 * 트리 한 번 순회로 WeakMap 에 담아, 드릴다운마다 다시 걷지 않게 한다.
 */
export function dominantCategories(root: ScanNode): WeakMap<ScanNode, string> {
  const memo = new WeakMap<ScanNode, string>();

  const walk = (node: ScanNode): Map<string, number> => {
    const acc = new Map<string, number>();
    if (node.children.length === 0) {
      // 잎. 파일이면 자기 분야, 분야가 없으면 'other'.
      const key = node.category ?? "other";
      acc.set(key, node.size);
    } else {
      for (const child of node.children) {
        const childAcc = walk(child);
        for (const [k, v] of childAcc) acc.set(k, (acc.get(k) ?? 0) + v);
      }
    }
    let best = "other";
    let bestVal = -1;
    for (const [k, v] of acc) {
      if (v > bestVal) {
        best = k;
        bestVal = v;
      }
    }
    memo.set(node, best);
    return acc;
  };

  walk(root);
  return memo;
}
