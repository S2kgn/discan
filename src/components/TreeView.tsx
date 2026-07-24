import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ScanNode,
  TruncatePart,
  isFileNode,
  truncateParts,
  unexplainedTruncatedBytes,
} from "../types";
import { SortKey, SortState, ancestorsOfMatches, collectPaths, filterTree, sortNodes } from "../lib/tree";
import { formatBytesParts, formatCount, formatPercent, percent } from "../lib/format";

/** 화면에 실제로 그려지는 한 줄. 트리를 평탄화해 두면 키보드 이동이 인덱스 계산으로 끝난다. */
interface Row {
  id: string;
  kind: "node" | "truncated" | "cap";
  node: ScanNode;
  depth: number;
  /** 막대를 형제 비교로 그릴 때의 분모. */
  parentSize: number;
  hasChildren: boolean;
  open: boolean;
  /** DOM 이 평탄해서 계층을 반영하지 않으므로 형제 정보를 따로 싣는다(WAI-ARIA 요구). */
  setSize: number;
  posInSet: number;
  /** 생략 행일 때의 사유·개수. 사유별로 한 줄씩 그린다. */
  part?: TruncatePart;
}

type BarMode = "total" | "parent";

interface Props {
  root: ScanNode;
  /** 검색어. 정리 후보 카드가 '나머지 79곳'으로 보내 줄 때 바깥에서 채운다. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** 깊이 제한으로 잘린 가지를 새 스캔 대상으로 넘길 때 쓴다. */
  onRescan: (path: string) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  /**
   * 용량 계산 제외 기능(선택). 제외 여부는 root 트리의 각 노드 `excluded` 표식으로
   * 오므로 경로 집합을 따로 받지 않는다. 이 콜백이 없으면 제외 UI 자체가 없다.
   */
  onToggleExclude?: (path: string) => void;
  onRestoreExcluded?: () => void;
  /** 제외로 총계에서 빠진 바이트·개수와 제외 전 총량. 패널 머리의 '제외 후' 요약에 쓴다. */
  excludedSize?: number;
  excludedCount?: number;
  originalSize?: number;
}

/** 들여쓰기 상한. 깊이 12까지 그대로 밀면 최소 창 폭에서 그리드가 넘친다. */
const MAX_INDENT_DEPTH = 8;
const INDENT_PX = 14;
/**
 * 한 번에 그릴 행의 상한. 가상화를 붙이기 전까지의 방어선이다 —
 * 가지치기된 트리도 최대 2만 행까지 나올 수 있고, 행 하나가 DOM 노드 10개다.
 */
const MAX_ROWS = 3000;
/** 검색은 키 입력마다 트리 전체를 다시 만든다. 타이핑이 끝난 뒤에 한 번만 돌린다. */
const SEARCH_DEBOUNCE_MS = 180;

function TreeViewImpl({
  root,
  query: queryProp,
  onQueryChange,
  onRescan,
  onReveal,
  onCopyPath,
  onToggleExclude,
  onRestoreExcluded,
  excludedSize = 0,
  excludedCount = 0,
  originalSize = 0,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectPaths(root, 2)));
  const [focusIndex, setFocusIndex] = useState(0);
  const [ownQuery, setOwnQuery] = useState("");
  const query = queryProp ?? ownQuery;
  const [appliedQuery, setAppliedQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "size", dir: "desc" });
  const [barMode, setBarMode] = useState<BarMode>("parent");
  /**
   * 조작 불가 행에서 O/C 를 눌렀을 때의 낭독 문구.
   *
   * lossyPath 행은 열기·복사가 실패하도록 예정돼 있어 버튼 대신 ⚠ 아이콘만 두는데,
   * 키보드 사용자가 O/C 를 누르면 예전에는 조용히 return 해 아무 피드백이 없었다
   * ('기능이 왜 안 되는지'를 알 수 없는 무피드백 no-op). 이 라이브 리전으로 이유를
   * 낭독한다 — App 의 notify 채널을 끌어오면 memo 안정성을 깨므로 컴포넌트 안에 둔다.
   */
  const [rowNotice, setRowNotice] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * 검색이 자동으로 펼친 경로. 검색을 끝낼 때 이 집합만 되돌린다.
   * 사용자가 직접 펼친 노드는 남겨야 하므로 expanded 전체를 초기화할 수 없다.
   */
  const autoOpenedRef = useRef<Set<string>>(new Set());

  const setQuery = (next: string) => {
    setOwnQuery(next);
    onQueryChange?.(next);
  };

  // 새 스캔 결과가 오면 펼침 상태를 초기 깊이로 되돌린다.
  useEffect(() => {
    setExpanded(new Set(collectPaths(root, 2)));
    autoOpenedRef.current.clear();
    setFocusIndex(0);
  }, [root]);

  useEffect(() => {
    const id = window.setTimeout(() => setAppliedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const view = useMemo(() => filterTree(root, appliedQuery), [root, appliedQuery]);
  // 검색 중 자동 펼침은 '일치 노드의 조상까지'만. 예전에는 일치 노드 하위를 통째로 펼쳤다.
  const searchOpen = useMemo(() => ancestorsOfMatches(root, appliedQuery), [root, appliedQuery]);

  /**
   * 검색 진입 시 자동 펼침을 expanded 에 **합쳐 넣는다**.
   *
   * 예전에는 검색 중 expanded 를 아예 참조하지 않아, 행을 눌러도 열리지 않으면서
   * ▸ 아이콘과 pointer 커서는 그대로 남았다 — 'node_modules 를 찾아 그 안을 본다'는
   * 가장 자연스러운 후속 동작이 막혀 있었다. 상태를 하나로 합치면 펼치기도 접기도
   * 그대로 동작하고, 화면과 어포던스가 어긋나지 않는다.
   *
   * 다만 합쳐 넣기만 하고 되돌리지 않으면, 검색어를 지웠을 때 초기 깊이 2로 정돈돼
   * 있던 트리가 조상 경로 수백 개가 펼쳐진 상태로 돌아온다 — 'cache' 같은 흔한
   * 질의 뒤에는 MAX_ROWS 상한 행과 '검색으로 좁히십시오' 경고가 검색을 끝낸 직후에
   * 등장한다. 사용자가 한 조작(검색 종료)의 결과가 화면을 더 복잡하게 만드는 셈이라,
   * 자동으로 연 것만 기록해 두었다가 같은 만큼만 되돌린다.
   */
  useEffect(() => {
    const auto = autoOpenedRef.current;
    if (searchOpen.size === 0) {
      if (auto.size === 0) return;
      const toClose = new Set(auto);
      auto.clear();
      setExpanded((prev) => {
        const next = new Set(prev);
        let removed = false;
        for (const p of toClose) {
          if (next.delete(p)) removed = true;
        }
        return removed ? next : prev;
      });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      let added = false;
      for (const p of searchOpen) {
        if (!next.has(p)) {
          next.add(p);
          // 사용자가 직접 펼친 것이 아니어야 되돌려도 되는 경로다.
          auto.add(p);
          added = true;
        }
      }
      return added ? next : prev;
    });
  }, [searchOpen]);

  const { rows, capped } = useMemo(() => {
    const out: Row[] = [];
    if (!view) return { rows: out, capped: false };
    let overflow = false;

    const walk = (node: ScanNode, depth: number, parentSize: number, setSize: number, pos: number) => {
      if (out.length >= MAX_ROWS) {
        overflow = true;
        return;
      }
      const parts = truncateParts(node);
      // 제외된 노드는 잎으로 다룬다 — 하위를 펼치면 그 안에서 개별 제외를 또 토글할
      // 수 있어 '이미 통째로 뺀 것'과 모순된다. 원복하면 다시 펼칠 수 있다.
      const hasChildren = !node.excluded && (node.children.length > 0 || parts.length > 0);
      const open = hasChildren && expanded.has(node.path);
      out.push({
        // 경로는 트리 안에서 이미 유일하다. 인덱스를 섞으면 상단 폴더 하나를 접을 때마다
        // 그 아래 모든 행의 key 가 바뀌어 최대 3000행의 DOM 이 통째로 재생성된다.
        id: node.path,
        kind: "node",
        node,
        depth,
        parentSize,
        hasChildren,
        open,
        setSize,
        posInSet: pos,
      });

      if (!open) return;
      const children = sortNodes(node.children, sort);
      const siblings = children.length + parts.length;
      children.forEach((child, i) => walk(child, depth + 1, node.size, siblings, i + 1));
      parts.forEach((part, i) => {
        if (out.length >= MAX_ROWS) {
          overflow = true;
          return;
        }
        out.push({
          id: `${node.path}|${part.reason}`,
          kind: "truncated",
          node,
          depth: depth + 1,
          parentSize: node.size,
          hasChildren: false,
          open: false,
          setSize: siblings,
          posInSet: children.length + i + 1,
          part,
        });
      });
    };

    walk(view, 0, view.size, 1, 1);
    if (overflow) {
      out.push({
        id: "cap",
        kind: "cap",
        node: view,
        depth: 0,
        parentSize: view.size,
        hasChildren: false,
        open: false,
        setSize: 1,
        posInSet: 1,
      });
    }
    return { rows: out, capped: overflow };
  }, [view, expanded, sort]);

  const total = root.size;
  // 접기·검색으로 행이 줄면 포커스 대상이 사라진다. 로빙 tabindex 가 늘 하나는 남아야 한다.
  const activeIndex = rows.length > 0 ? Math.min(focusIndex, rows.length - 1) : 0;

  function focusRow(index: number) {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocusIndex(next);
    bodyRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus();
  }

  function toggle(node: ScanNode) {
    // 직접 조작한 노드는 더 이상 '검색이 연 것'이 아니다 — 검색을 끝낼 때 남긴다.
    autoOpenedRef.current.delete(node.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  }

  /**
   * 펼치기는 즉시 반응해야 한다.
   *
   * 예전에는 더블클릭의 '펼쳤다 접힘' 깜박임을 없애려고 모든 클릭을 220ms 미뤘는데,
   * 직접 조작이 즉시로 느껴지는 상한은 100ms 이고 폴더 펼치기는 이 앱에서 가장 잦은
   * 동작이다. 드문 동작(더블클릭 열기)의 매끄러움과 최빈 동작의 체감 속도를 맞바꾼
   * 셈이라, 더블클릭 열기를 걷어냈다 — 같은 행의 ↗ 버튼과 O 키가 이미 그 일을 한다.
   */
  function onRowClick(node: ScanNode, hasChildren: boolean) {
    if (!hasChildren) return;
    toggle(node);
  }

  function onRowKeyDown(e: ReactKeyboardEvent, row: Row, index: number) {
    // Ctrl+C 로 선택 텍스트를 복사하려는 사용자에게서 기본 동작을 뺏지 않는다.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowDown":
        focusRow(index + 1);
        break;
      case "ArrowUp":
        focusRow(index - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.hasChildren && !row.open) toggle(row.node);
        else focusRow(index + 1);
        break;
      case "ArrowLeft":
        if (row.hasChildren && row.open) {
          toggle(row.node);
        } else {
          // 부모는 자기보다 얕은 깊이를 가진 가장 가까운 위쪽 행이다.
          for (let i = index - 1; i >= 0; i -= 1) {
            if (rows[i].depth < row.depth) {
              focusRow(i);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        if (row.kind === "node" && row.hasChildren) toggle(row.node);
        break;
      // 버튼을 감춘 행에서 단축키만 살아 있으면 같은 결함이 키보드에만 남는다.
      // lossyPath 행은 열기·복사가 예정된 실패라 버튼을 두지 않는다. 그러나 조용히
      // return 하면 키보드·낭독 사용자는 '왜 안 되는지'를 알 수 없다 — ⚠ 아이콘의
      // 설명을 라이브 리전으로도 낸다(row-note 의 title 과 같은 문구).
      case "o":
      case "O":
        if (row.node.lossyPath) {
          setRowNotice("이 이름은 표준 문자로 표현할 수 없어 열기·복사를 지원하지 않습니다.");
          break;
        }
        onReveal(row.node.path);
        break;
      case "c":
      case "C":
        if (row.node.lossyPath) {
          setRowNotice("이 이름은 표준 문자로 표현할 수 없어 열기·복사를 지원하지 않습니다.");
          break;
        }
        onCopyPath(row.node.path);
        break;
      /*
       * 깊이 제한으로 잘린 가지를 다시 스캔하는 조작에는 키보드 경로가 없었다.
       * ⟳ 버튼은 tabIndex=-1 이라 Tab 으로 도달할 수 없고, ↗·⧉ 와 달리 대체 키도
       * 없어 키보드 사용자에게는 기능 자체가 전달되지 않았다(WCAG 2.1.1). 이 앱에서
       * 대체 수단이 '경로 직접 입력'뿐인 기능이라 비용이 가장 크다.
       */
      case "r":
      case "R":
        // 생략 행(사유 무관)에서 그 폴더만 다시 스캔한다. 재스캔하면 가지치기 임계값이
        // 그 폴더 기준으로 다시 잡혀(전체÷2000 → 훨씬 작아짐) 숨었던 항목이 드러난다.
        if (row.kind !== "truncated") return;
        onRescan(row.node.path);
        break;
      // 용량 계산에서 제외·원복. 생략 행에는 해당 노드가 없으므로 실제 노드 행에만 건다.
      case "x":
      case "X":
        if (row.kind !== "node" || !onToggleExclude) return;
        onToggleExclude(row.node.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  /** 열 머리글의 aria-sort. 정렬 상태를 표준 방식으로 전달한다. */
  function sortState(key: SortKey): "ascending" | "descending" | "none" {
    if (sort.key !== key) return "none";
    return sort.dir === "desc" ? "descending" : "ascending";
  }

  function sortButton(key: SortKey, label: string, className: string) {
    const active = sort.key === key;
    const state = !active ? "정렬 안 함" : sort.dir === "desc" ? "내림차순" : "오름차순";
    return (
      <button
        type="button"
        className={`tree-sort ${className}${active ? " active" : ""}`}
        aria-pressed={active}
        aria-label={`${label} 기준 정렬 — 현재 ${state}`}
        onClick={() =>
          setSort((prev) =>
            prev.key === key
              ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
              : { key, dir: "desc" },
          )
        }
      >
        {label}
        <span className="tree-sort-mark">{active ? (sort.dir === "desc" ? "▾" : "▴") : ""}</span>
      </button>
    );
  }

  return (
    <section className="panel panel-tree">
      <div className="panel-head">
        <h2 className="panel-title">폴더별 용량</h2>
        {/* 제외가 있으면 총계가 왜 줄었는지 이 줄이 설명한다 — '제외 후 X (원래 Y)'와
            한 번에 되돌릴 수단을 함께 둔다. 개별 원복은 각 행의 ↩ 버튼이 한다. */}
        {excludedCount > 0 && (
          <div className="tree-excluded" role="status">
            <span>
              {formatCount(excludedCount)}개 제외 · 제외 후{" "}
              <strong>{formatBytesParts(originalSize - excludedSize).value}{" "}
              {formatBytesParts(originalSize - excludedSize).unit}</strong>{" "}
              <span className="tree-excluded-orig">
                (원래 {formatBytesParts(originalSize).value} {formatBytesParts(originalSize).unit})
              </span>
            </span>
            <button type="button" className="btn tiny" onClick={onRestoreExcluded}>
              모두 원복
            </button>
          </div>
        )}
        <div className="tree-tools">
          <input
            className="tree-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="폴더·파일 이름 검색"
            aria-label="폴더·파일 이름 검색"
          />
          <button
            type="button"
            className="btn tiny"
            onClick={() => setBarMode(barMode === "total" ? "parent" : "total")}
            title="막대 길이의 기준을 바꿉니다"
          >
            막대 기준: {barMode === "total" ? "전체" : "상위 폴더"}
          </button>
        </div>
      </div>

      {/*
       * 열이 있는 트리는 tree 가 아니라 treegrid 다.
       *
       * 예전에는 본문만 role="tree" 이고 그 위의 열 머리글은 role="presentation" 이었다.
       * tree 롤에는 열 개념이 없어 머리글과 셀의 대응이 보조기술에 전달되지 않았고,
       * presentation 요소 안에 포커스 가능한 정렬 버튼이 셋 들어 있어 그 롤 자체가
       * 무효가 되는 충돌 상태였다(WAI-ARIA presentational role conflict).
       * 머리글과 본문을 한 treegrid 안에 넣으면 aria-sort 로 정렬 상태까지 표준
       * 방식으로 전달되고, 행 단위 포커스(로빙 tabindex)도 그대로 유효하다.
       */}
      <div className="tree-grid" role="treegrid" aria-label="폴더별 용량 트리">
        <div className="tree-head" role="row">
          <span className="tree-icon" role="columnheader" aria-label="펼침 상태" />
          <span className="tree-name-head" role="columnheader" aria-sort={sortState("name")}>
            {sortButton("name", "경로", "tree-name")}
          </span>
          <span className="tree-bar-wrap head" role="columnheader" aria-label="크기 막대" />
          <span className="tree-pct" role="columnheader">
            비중
          </span>
          {/* 본문과 같은 `1fr 30px` 그리드를 써야 머리글과 숫자열의 오른쪽 축이 맞는다. */}
          <span className="tree-size" role="columnheader" aria-sort={sortState("size")}>
            {sortButton("size", "용량", "tree-size-btn")}
          </span>
          <span className="tree-files" role="columnheader" aria-sort={sortState("files")}>
            {sortButton("files", "파일", "tree-files-btn")}
          </span>
          <span className="tree-actions" role="columnheader" aria-label="동작" />
        </div>

        <div className="tree-body" ref={bodyRef} role="rowgroup">
          {rows.map((row, index) => {
            const indent = Math.min(row.depth, MAX_INDENT_DEPTH) * INDENT_PX;

            if (row.kind === "cap") {
              /*
               * 상한 행도 로빙 tabindex 대상에 넣는다.
               *
               * 예전에는 data-row 도 tabIndex 도 없었는데, End 키는 rows.length-1 —
               * 곧 이 행 — 을 focusIndex 로 잡는다. 그러면 실제 포커스 이동은 실패하고
               * activeIndex 만 이 행을 가리켜 **모든** 행이 tabIndex=-1 이 됐다.
               * 트리 밖으로 나갔다가 Tab 으로 돌아오면 다시 진입할 수 없는 상태다.
               */
              return (
                <div
                  key={row.id}
                  className="tree-row muted warn"
                  role="row"
                  aria-level={1}
                  aria-setsize={row.setSize}
                  aria-posinset={row.posInSet}
                  data-row={index}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={(e) => onRowKeyDown(e, row, index)}
                >
                  <span className="tree-icon" role="gridcell" aria-hidden="true">
                    ·
                  </span>
                  <span className="tree-name" role="gridcell">
                    {formatCount(MAX_ROWS)}행까지만 그렸습니다 — 검색으로 좁히거나 상위 폴더를 접으십시오.
                  </span>
                  <span className="tree-bar-wrap" role="gridcell" />
                  <span className="tree-pct" role="gridcell" />
                  <span className="tree-size" role="gridcell" />
                  <span className="tree-files" role="gridcell" />
                  <span className="tree-actions" role="gridcell" />
                </div>
              );
            }

            if (row.kind === "truncated") {
              const part = row.part!;
              const size = formatBytesParts(part.bytes);
              /*
               * 생략 합계의 '부모 대비 비중'.
               *
               * node.size 는 남긴 자식 + 생략 바이트를 모두 포함하므로(백엔드 불변식),
               * part.bytes / node.size 가 곧 '이 폴더에서 생략분이 차지하는 몫'이다.
               * 개별은 작아도 합치면 부모의 큰 부분일 수 있다는 것 — 사용자가 지적한
               * 바로 그 상황 — 을 막대로 보이게 한다. 숫자만 접어 두면 보이지 않는다.
               */
              const shareOfParent = percent(part.bytes, row.node.size);
              /*
               * 사유가 둘 이상인데 백엔드가 바이트를 나눠 보내지 않으면 어느 줄에도
               * 바이트가 붙지 않는다 — '생략한 것은 개수·크기·사유를 남긴다'는 이 앱의
               * 불변식이 가장 흔한 경우(파일 상한 + 크기 미달 동시 적중)에 깨지는 셈이다.
               * 설명되지 않은 차액은 마지막 생략 행에 한 줄로 붙여 남기지 않는다.
               */
              const rest = unexplainedTruncatedBytes(row.node);
              const allParts = truncateParts(row.node);
              const isLastPart = allParts[allParts.length - 1]?.reason === part.reason;
              const restText =
                rest > 0 && isLastPart
                  ? ` (이 폴더에서 생략된 합계 ${formatBytesParts(rest).value} ${formatBytesParts(rest).unit})`
                  : "";
              // 개별은 작지만 합치면 클 수 있다는 뜻을 이름에 담고, 규모는 옆 열(막대·%·
              // 용량)이 낸다. 'R 로 이 폴더만 다시 스캔'하면 임계값이 낮아져 드러난다.
              const text =
                part.reason === "depthLimit"
                  ? `깊이 제한으로 생략한 하위 ${formatCount(part.count)}개`
                  : part.reason === "childCap"
                    ? `표시 한도로 생략한 ${formatCount(part.count)}개`
                    : `개별 용량이 작아 생략한 ${formatCount(part.count)}개 — 합치면 아래 비중`;

              return (
                <div
                  key={row.id}
                  className={`tree-row muted${part.reason === "depthLimit" ? " warn" : ""}`}
                  role="row"
                  aria-level={row.depth + 1}
                  aria-setsize={row.setSize}
                  aria-posinset={row.posInSet}
                  data-row={index}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={(e) => onRowKeyDown(e, row, index)}
                >
                  <span className="tree-icon" role="gridcell" aria-hidden="true">
                    ·
                  </span>
                  <span className="tree-name" role="gridcell">
                    <span className="tree-indent" style={{ width: `${indent}px` }} />
                    {text}
                    {restText}
                  </span>
                  {/* 생략 합계를 막대로 보인다 — 개별이 작아도 부모의 큰 몫이면 막대가
                      길게 나와, 접힌 회색 주석이 아니라 규모로 읽힌다. */}
                  <span className="tree-bar-wrap" role="gridcell">
                    {part.bytes > 0 && (
                      <span
                        className="tree-bar omitted"
                        style={{ width: `${Math.min(shareOfParent, 100)}%` }}
                      />
                    )}
                  </span>
                  <span className="tree-pct" role="gridcell">
                    {part.bytes > 0 ? formatPercent(shareOfParent) : ""}
                  </span>
                  <span className="tree-size" role="gridcell">
                    {part.bytes > 0 && (
                      <>
                        <span className="num">{size.value}</span>
                        <span className="unit">{size.unit}</span>
                      </>
                    )}
                  </span>
                  <span className="tree-files" role="gridcell" />
                  <span className="tree-actions" role="gridcell">
                    {/* 사유와 무관하게 '이 폴더만 다시 스캔'을 준다 — 재스캔하면 가지치기
                        임계값이 이 폴더 기준으로 낮아져 생략됐던 항목이 드러난다. */}
                    <button
                      type="button"
                      className="row-btn"
                      tabIndex={-1}
                      title="이 폴더만 다시 스캔 (R)"
                      // 글리프가 그대로 접근 가능한 이름이 되면 '시계 방향 화살표,
                      // 버튼'으로 낭독된다. 이름은 문구로 주고 글리프는 감춘다.
                      aria-label={`${row.node.name} — 이 폴더만 다시 스캔해 생략된 항목 보기`}
                      onClick={() => onRescan(row.node.path)}
                    >
                      <span aria-hidden="true">⟳</span>
                    </button>
                  </span>
                </div>
              );
            }

            const node = row.node;
            const file = isFileNode(node);
            const shareOfTotal = percent(node.size, total);
            const barShare = barMode === "total" ? shareOfTotal : percent(node.size, row.parentSize);
            // 목록 열은 자릿수를 고정해야 소수점이 세로로 맞는다.
            const size = formatBytesParts(node.size, { fixedDigits: 1 });

            return (
              <div
                key={row.id}
                className={`tree-row${row.hasChildren ? " clickable" : ""}${file ? " file" : ""}${node.incomplete ? " incomplete" : ""}${node.excluded ? " excluded" : ""}`}
                role="row"
                aria-level={row.depth + 1}
                aria-setsize={row.setSize}
                aria-posinset={row.posInSet}
                aria-expanded={row.hasChildren ? row.open : undefined}
                // 파일 수 열이 낭독에서 빠져 있었다 — 화면에 있는 열은 모두 이름에 담는다.
                // lossyPath 는 포커스 낭독만으로 이 행이 조작 불가임을 알 수 있게 함께 싣는다.
                aria-label={`${node.name}, ${size.value} ${size.unit}${node.excluded ? ", 용량 계산에서 제외됨" : `, 전체의 ${formatPercent(shareOfTotal)}`}${file ? "" : `, 파일 ${formatCount(node.files)}개`}${node.incomplete ? ", 하위 집계 미완료" : ""}${node.lossyPath ? ", 표준 문자가 아니라 열기·복사 불가" : ""}`}
                data-row={index}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setFocusIndex(index)}
                onClick={() => onRowClick(node, row.hasChildren)}
                onKeyDown={(e) => onRowKeyDown(e, row, index)}
                title={node.path}
              >
                <span className="tree-icon" role="gridcell" aria-hidden="true">
                  {row.hasChildren ? (row.open ? "▾" : "▸") : file ? "▪" : "▫"}
                </span>
                <span className="tree-name" role="gridcell">
                  <span className="tree-indent" style={{ width: `${indent}px` }} />
                  {node.name}
                  {/* 취소·오류로 하위 집계가 끝나지 못한 노드는 표시 용량이 하한값이다. */}
                  {node.incomplete && (
                    <span className="tree-incomplete" title="하위 집계가 끝나지 않아 실제 용량은 더 큽니다">
                      ≥
                    </span>
                  )}
                </span>
                <span className="tree-bar-wrap" role="gridcell">
                  {/* 제외된 노드는 총계에 없으므로 막대를 그리지 않는다 — 그리면 조정된
                      분모 대비 100%를 넘어 다른 행들과 어긋난다. */}
                  {!node.excluded && (
                    <span className="tree-bar" style={{ width: `${Math.min(barShare, 100)}%` }} />
                  )}
                </span>
                <span className="tree-pct" role="gridcell">
                  {node.excluded ? "제외" : formatPercent(shareOfTotal)}
                </span>
                <span className="tree-size" role="gridcell">
                  <span className="num">{size.value}</span>
                  <span className="unit">{size.unit}</span>
                </span>
                <span className="tree-files" role="gridcell">
                  {file ? "" : formatCount(node.files)}
                </span>
                <span className="tree-actions" role="gridcell">
                  {/*
                    표시 경로가 원본과 다르면(치환된 이름) 열기는 실패하고, 폴백이
                    복사한 경로도 원본과 달라 붙여 넣어도 열리지 않는다. 실패가
                    예정된 어포던스를 주지 않는다는 이 앱의 규칙을 여기에도 적용한다.
                  */}
                  {node.lossyPath ? (
                    <span
                      className="row-note"
                      title="이 이름은 표준 문자로 표현할 수 없어 열기·복사를 지원하지 않습니다"
                      aria-label={`${node.name} — 표준 문자로 표현할 수 없는 이름이라 열기·복사를 지원하지 않습니다`}
                    >
                      ⚠
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="row-btn"
                        tabIndex={-1}
                        title="탐색기에서 위치 보기 (O)"
                        aria-label={`${node.name} — 탐색기에서 위치 보기`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onReveal(node.path);
                        }}
                      >
                        <span aria-hidden="true">↗</span>
                      </button>
                      <button
                        type="button"
                        className="row-btn"
                        tabIndex={-1}
                        title="경로 복사 (C)"
                        aria-label={`${node.name} — 경로 복사`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCopyPath(node.path);
                        }}
                      >
                        <span aria-hidden="true">⧉</span>
                      </button>
                    </>
                  )}
                  {/* 제외·원복은 lossyPath 여도 쓸 수 있다 — 경로를 열지 않고 키로만
                      계산에서 빼는 조작이라 표준 문자가 아니어도 문제가 없다. */}
                  {onToggleExclude && (
                    <button
                      type="button"
                      className={`row-btn${node.excluded ? " active" : ""}`}
                      tabIndex={-1}
                      title={node.excluded ? "용량 계산에 다시 포함 (X)" : "용량 계산에서 제외 (X)"}
                      aria-label={`${node.name} — ${node.excluded ? "용량 계산에 다시 포함" : "용량 계산에서 제외"}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExclude(node.path);
                      }}
                    >
                      <span aria-hidden="true">{node.excluded ? "↩" : "⊘"}</span>
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 안내 문단은 treegrid 바깥에 둔다 — 행이 아닌 요소가 rowgroup 안에 있으면
          보조기술이 표 구조를 해석하다 만다. */}
      {rows.length === 0 && appliedQuery.trim() !== "" && (
        <p className="tree-empty">‘{appliedQuery}’와 이름이 일치하는 항목이 없습니다.</p>
      )}

      {/* 조작 불가 행에서 O/C 를 눌렀을 때의 낭독 채널. 시각에는 드러나지 않는다. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {rowNotice}
      </p>

      {/* '수식키'는 모디파이어 키의 번역어이고 '토글'도 일반 사용자 어휘가 아니다.
          다섯 가지를 한 줄에 몰아 두면 아무도 읽지 않는 회색 줄이 된다. 각 행의
          ↗·⧉ 버튼 툴팁이 이미 같은 안내를 하므로 키 두 개만 남긴다. */}
      <p className="tree-hint">
        행을 선택하고 O: 탐색기에서 위치 보기 · C: 경로 복사 · X: 용량 계산에서 제외·원복 · R:
        생략 행을 다시 스캔 (↑↓ 이동, →← 펼치기·접기)
        {capped && ` · 표시 행이 상한(${formatCount(MAX_ROWS)})에 걸렸습니다.`}
      </p>
    </section>
  );
}

/**
 * 이 패널이 재조정 비용의 대부분을 차지한다 — 최대 3,000행 × 행당 10개 안팎의
 * 엘리먼트다. 진행 이벤트(150ms)마다 App 이 리렌더될 때 함께 돌면 스캔이 가장
 * 무거운 순간에 UI 스레드를 그만큼 뺏겨 중단 버튼 반응까지 늦어진다.
 * 넘어오는 콜백은 App 에서 전부 useCallback 으로 고정해 두었다.
 */
export const TreeView = memo(TreeViewImpl);
