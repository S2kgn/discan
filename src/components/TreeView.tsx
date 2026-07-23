import { useState } from "react";
import { ScanNode } from "../types";
import { formatBytes, formatCount, percent } from "../lib/format";

interface RowProps {
  node: ScanNode;
  total: number;
  depth: number;
  /** 최초 렌더에서 펼쳐둘 깊이. 그 아래는 사용자가 열어야 보인다. */
  autoExpandDepth: number;
}

function TreeRow({ node, total, depth, autoExpandDepth }: RowProps) {
  const [open, setOpen] = useState(depth < autoExpandDepth);
  const hasChildren = node.children.length > 0;
  const share = percent(node.size, total);

  return (
    <>
      <div
        className={`tree-row${hasChildren ? " clickable" : ""}`}
        style={{ paddingLeft: `${depth * 18 + 10}px` }}
        onClick={() => hasChildren && setOpen(!open)}
        title={node.path}
      >
        <span className="tree-caret">
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-bar-wrap">
          <span className="tree-bar" style={{ width: `${Math.min(share, 100)}%` }} />
        </span>
        <span className="tree-pct">{share.toFixed(1)}%</span>
        <span className="tree-size">{formatBytes(node.size)}</span>
        <span className="tree-files">{formatCount(node.files)}</span>
      </div>

      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            total={total}
            depth={depth + 1}
            autoExpandDepth={autoExpandDepth}
          />
        ))}

      {open && node.truncated > 0 && (
        <div className="tree-row muted" style={{ paddingLeft: `${(depth + 1) * 18 + 10}px` }}>
          <span className="tree-caret">·</span>
          <span className="tree-name">
            그 외 {formatCount(node.truncated)}개 항목 생략 (비중 과소)
          </span>
        </div>
      )}
    </>
  );
}

interface Props {
  root: ScanNode;
}

export function TreeView({ root }: Props) {
  return (
    <section className="panel">
      <h2 className="panel-title">폴더별 용량</h2>
      <div className="tree-head">
        <span className="tree-caret" />
        <span className="tree-name">경로</span>
        <span className="tree-bar-wrap" />
        <span className="tree-pct">비중</span>
        <span className="tree-size">용량</span>
        <span className="tree-files">파일</span>
      </div>
      <div className="tree-body">
        <TreeRow node={root} total={root.size} depth={0} autoExpandDepth={2} />
      </div>
    </section>
  );
}
