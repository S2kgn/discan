import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CATEGORY_COLORS, ScanNode, isFileNode } from "../types";
import { formatBytes, formatCount, formatPercent, middlePath, percent } from "../lib/format";
import { readableInk } from "../lib/color";
import { dominantCategories, squarify } from "../lib/treemap";

interface Props {
  root: ScanNode;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
}

/** 이 픽셀보다 작은 타일은 그리지 않는다 — 1~2px 슬라이버는 클릭도 판독도 안 된다. */
const MIN_TILE_PX = 4;
/** 라벨을 얹을 최소 타일 크기. 이보다 작으면 글자가 넘쳐 오히려 지저분하다. */
const LABEL_MIN_W = 54;
const LABEL_MIN_H = 24;

/**
 * WinDirStat 식 트리맵.
 *
 * 폴더별 용량 목록·트리가 '순위'를 준다면 트리맵은 '규모의 형상'을 준다 — 40GB짜리
 * 파일 하나와 40GB어치 잡파일이 한눈에 갈린다. 타일은 분야 색으로 칠해(사용자가
 * 이미 익힌 색) 무엇이 공간을 먹는지 색만으로도 읽히게 한다.
 */
function TreemapImpl({ root, onReveal, onCopyPath }: Props) {
  // 드릴다운 경로. 마지막이 현재 보고 있는 노드다.
  const [stack, setStack] = useState<ScanNode[]>([root]);
  const [hover, setHover] = useState<ScanNode | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // 새 스캔 결과가 오면 루트로 되돌린다.
  useEffect(() => {
    setStack([root]);
    setHover(null);
  }, [root]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const current = stack[stack.length - 1];
  const dominant = useMemo(() => dominantCategories(root), [root]);

  const tiles = useMemo(() => {
    if (size.w <= 0 || size.h <= 0) return [];
    return squarify(current.children, 0, 0, size.w, size.h).filter(
      (t) => t.w >= MIN_TILE_PX && t.h >= MIN_TILE_PX,
    );
  }, [current, size]);

  const colorOf = (node: ScanNode): string => {
    const key = isFileNode(node) ? node.category ?? "other" : dominant.get(node) ?? "other";
    return CATEGORY_COLORS[key] ?? CATEGORY_COLORS.other;
  };

  const onTileClick = (node: ScanNode) => {
    if (isFileNode(node)) onReveal(node.path);
    else if (node.children.length > 0) setStack((s) => [...s, node]);
  };

  const onTileKey = (e: ReactKeyboardEvent, node: ScanNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onTileClick(node);
    } else if ((e.key === "c" || e.key === "C") && !node.lossyPath) {
      onCopyPath(node.path);
    } else if (e.key === "Backspace" && stack.length > 1) {
      e.preventDefault();
      setStack((s) => s.slice(0, -1));
    }
  };

  const total = current.size;

  return (
    <section className="panel panel-treemap">
      <div className="panel-head">
        <h2 className="panel-title">트리맵</h2>
        {/* 경로(breadcrumb). 각 조각을 눌러 그 깊이로 되돌아간다. */}
        <nav className="tm-crumbs" aria-label="트리맵 위치">
          {stack.map((n, i) => (
            <span key={n.path} className="tm-crumb">
              {i > 0 && <span className="tm-crumb-sep" aria-hidden="true">›</span>}
              {i === stack.length - 1 ? (
                <span className="tm-crumb-current">{n.name || n.path}</span>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setStack((s) => s.slice(0, i + 1))}
                >
                  {n.name || n.path}
                </button>
              )}
            </span>
          ))}
        </nav>
      </div>

      <p className="tm-hint">
        타일 크기 = 용량, 색 = 분야. 폴더를 누르면 그 안으로 들어가고, 파일을 누르면
        탐색기에서 열립니다{stack.length > 1 && " (Backspace 로 상위)"}.
      </p>

      <div className="tm-box" ref={boxRef} role="group" aria-label="트리맵">
        {tiles.length === 0 && size.w > 0 && (
          <p className="tm-empty">이 폴더에는 표시할 만한 크기의 항목이 없습니다.</p>
        )}
        {tiles.map((t) => {
          const node = t.node;
          const bg = colorOf(node);
          const showLabel = t.w >= LABEL_MIN_W && t.h >= LABEL_MIN_H;
          const dir = !isFileNode(node);
          const share = percent(node.size, total);
          return (
            <div
              key={node.path}
              className={`tm-tile${dir ? " dir" : " file"}`}
              style={{
                left: `${t.x}px`,
                top: `${t.y}px`,
                width: `${t.w}px`,
                height: `${t.h}px`,
                background: bg,
                color: readableInk(bg),
              }}
              role="button"
              tabIndex={0}
              aria-label={`${node.name}, ${formatBytes(node.size)}, 전체의 ${formatPercent(share)}${dir ? `, 폴더 (파일 ${formatCount(node.files)}개)` : ", 파일"}`}
              title={`${node.path}\n${formatBytes(node.size)} · ${formatPercent(share)}`}
              onClick={() => onTileClick(node)}
              onKeyDown={(e) => onTileKey(e, node)}
              onMouseEnter={() => setHover(node)}
              onMouseLeave={() => setHover((h) => (h === node ? null : h))}
            >
              {showLabel && (
                <span className="tm-label">
                  <span className="tm-name">{node.name}</span>
                  <span className="tm-size">{formatBytes(node.size)}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 호버 정보줄 — 작은 타일은 라벨이 없으므로 여기서 무엇인지 읽는다. */}
      <p className="tm-readout" aria-hidden="true">
        {hover
          ? `${middlePath(hover.path, 72)} · ${formatBytes(hover.size)} · 전체의 ${formatPercent(percent(hover.size, total))}`
          : "타일에 마우스를 올리면 경로와 크기가 여기 표시됩니다."}
      </p>
    </section>
  );
}

/** 진행 이벤트(150ms)마다 재조정하지 않도록 memo. */
export const Treemap = memo(TreemapImpl);
