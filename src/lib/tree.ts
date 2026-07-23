import { LargeFile, ScanNode, isFileNode } from "../types";

export type SortKey = "size" | "name" | "files";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** 백엔드는 크기 내림차순으로만 보낸다. 그 외 정렬은 여기서 렌더 시점에 한다. */
export function sortNodes(nodes: ScanNode[], sort: SortState): ScanNode[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const sorted = [...nodes];
  sorted.sort((a, b) => {
    switch (sort.key) {
      case "name":
        return sign * a.name.localeCompare(b.name);
      case "files":
        return sign * (a.files - b.files);
      default:
        return sign * (a.size - b.size);
    }
  });
  return sorted;
}

/**
 * 이름에 질의가 포함된 노드와 그 조상만 남긴다.
 * 일치한 노드의 하위는 그대로 둔다 — 찾은 폴더 안을 이어서 볼 수 있어야 한다.
 */
export function filterTree(node: ScanNode, query: string): ScanNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;

  const hit = node.name.toLowerCase().includes(q);
  if (hit) return node;

  const children = node.children
    .map((c) => filterTree(c, q))
    .filter((c): c is ScanNode => c !== null);

  if (children.length === 0) return null;
  // 조상 노드는 경로만 이어주는 역할이므로 생략 안내를 끌고 내려가지 않는다.
  return { ...node, children, truncated: 0 };
}

/** 트리에 실린 파일 노드를 큰 것부터 모은다. 백엔드가 파일을 싣지 않으면 빈 배열이다. */
export function collectFileNodes(root: ScanNode, limit = 50): LargeFile[] {
  const found: LargeFile[] = [];
  const walk = (node: ScanNode) => {
    if (isFileNode(node)) {
      found.push({ name: node.name, path: node.path, size: node.size });
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  found.sort((a, b) => b.size - a.size);
  return found.slice(0, limit);
}

export function countNodes(node: ScanNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

/**
 * 일치 노드에 도달하기까지의 조상 경로만 모은다.
 *
 * 예전에는 검색 중 모든 노드를 무조건 펼쳤는데, filterTree 가 일치 노드의 하위를
 * 통째로 유지하므로 루트 근처에서 한 글자만 맞아도 가지치기된 트리 전체가 한 번에
 * 그려졌다(키 입력마다). 조상까지만 펼치면 일치 지점은 보이면서 하위는 접혀 있다.
 */
export function ancestorsOfMatches(node: ScanNode, query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const open = new Set<string>();
  if (!q) return open;

  const walk = (n: ScanNode): boolean => {
    if (n.name.toLowerCase().includes(q)) return true;
    let hit = false;
    for (const child of n.children) {
      if (walk(child)) hit = true;
    }
    if (hit) open.add(n.path);
    return hit;
  };

  walk(node);
  // 루트는 늘 열려 있어야 결과가 한 줄이라도 보인다.
  open.add(node.path);
  return open;
}

/** 모든 조상 경로. 검색 결과를 자동으로 펼칠 때 쓴다. */
export function collectPaths(node: ScanNode, maxDepth = Infinity, depth = 0): string[] {
  if (depth >= maxDepth) return [];
  const paths = [node.path];
  for (const child of node.children) {
    paths.push(...collectPaths(child, maxDepth, depth + 1));
  }
  return paths;
}
