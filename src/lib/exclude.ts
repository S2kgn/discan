import { ScanNode } from "../types";

/** 제외된 최상위 항목 하나. 요약과 원복 목록에 쓴다. */
export interface ExcludedItem {
  path: string;
  name: string;
  /** 제외 시점의 원래 크기(취소선으로 보여 줄 값). */
  size: number;
}

export interface FolderExclusionResult {
  /** 제외분을 뺀 트리. 상위 노드의 size·files 가 그만큼 줄고, 제외 노드는 excluded 표식이 붙는다. */
  tree: ScanNode;
  /** 총계에서 빠진 바이트. */
  excludedSize: number;
  excludedFiles: number;
  /** 제외된 최상위 항목들(제외된 폴더 안의 또 다른 제외는 이미 포함되므로 세지 않는다). */
  items: ExcludedItem[];
}

interface Adjusted {
  node: ScanNode;
  removed: number;
  removedFiles: number;
  items: ExcludedItem[];
}

/**
 * 사용자가 제외한 폴더·파일을 뺀 트리를 만든다.
 *
 * 핵심 불변식: 제외된 노드에 이르면 **더 내려가지 않는다**. node.size 에 이미 그
 * 서브트리 전체가 들어 있으므로, 그 안의 또 다른 제외까지 따로 빼면 이중 계산이 된다.
 * 그래서 items(원복 목록)에도 '제외된 서브트리 안의 제외'는 오르지 않는다 —
 * 최상위 제외 하나만 목록에 남고, 그것을 원복하면 안쪽 제외가 다시 최상위로 떠오른다.
 *
 * 순수 함수라 UI 없이 테스트로 잠근다.
 */
export function applyFolderExclusions(
  root: ScanNode,
  excluded: ReadonlySet<string>,
): FolderExclusionResult {
  const adjust = (node: ScanNode): Adjusted => {
    if (excluded.has(node.path)) {
      // 제외 노드는 트리에 남겨 원래 크기를 그대로 보여 준다(취소선·원복). 하위로는
      // 내려가지 않는다 — 크기·파일 수는 이 노드 하나로 서브트리 전체를 대표한다.
      return {
        node: { ...node, excluded: true },
        removed: node.size,
        removedFiles: node.files,
        items: [{ path: node.path, name: node.name, size: node.size }],
      };
    }
    if (node.children.length === 0) {
      // 잎(파일 또는 빈 폴더)은 제외 표식만 지워 재계산이 멱등이 되게 한다.
      return node.excluded ? { node: { ...node, excluded: false }, removed: 0, removedFiles: 0, items: [] }
        : { node, removed: 0, removedFiles: 0, items: [] };
    }
    let removed = 0;
    let removedFiles = 0;
    const items: ExcludedItem[] = [];
    const children = node.children.map((c) => {
      const a = adjust(c);
      removed += a.removed;
      removedFiles += a.removedFiles;
      items.push(...a.items);
      return a.node;
    });
    return {
      node: {
        ...node,
        excluded: false,
        size: Math.max(0, node.size - removed),
        files: Math.max(0, node.files - removedFiles),
        children,
      },
      removed,
      removedFiles,
      items,
    };
  };

  const result = adjust(root);
  return {
    tree: result.node,
    excludedSize: result.removed,
    excludedFiles: result.removedFiles,
    // 제외 목록은 큰 것부터 — 원복 판단은 대개 '가장 큰 것을 되돌릴까'다.
    items: result.items.sort((a, b) => b.size - a.size),
  };
}
