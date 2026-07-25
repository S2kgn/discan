import { DuplicateGroup } from "../types";

/**
 * 기본 선택: 그룹마다 **첫 경로 하나를 남기고** 나머지를 삭제 대상으로 고른다.
 *
 * 백엔드가 경로를 정렬해 보내므로 첫 경로는 대개 가장 짧거나 사전순으로 앞선다 —
 * '원본으로 남길 하나'로 무난하다. 사용자는 개별 체크박스로 얼마든지 바꿀 수 있다.
 */
export function autoSelect(groups: DuplicateGroup[]): Set<string> {
  const s = new Set<string>();
  for (const g of groups) {
    for (let i = 1; i < g.paths.length; i += 1) s.add(g.paths[i]);
  }
  return s;
}

/** 선택된 파일 수와 회수 용량(각 파일 크기 = 그 그룹의 size). */
export function selectionStats(
  groups: DuplicateGroup[],
  selected: ReadonlySet<string>,
): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const g of groups) {
    for (const p of g.paths) {
      if (selected.has(p)) {
        count += 1;
        bytes += g.size;
      }
    }
  }
  return { count, bytes };
}

/**
 * 한 그룹의 **모든** 사본이 선택됐는지 — 그러면 원본까지 사라진다.
 *
 * 중복 삭제의 목적은 '사본을 지우되 하나는 남긴다'이다. 그룹 전체를 지우면 그 파일이
 * 통째로 없어지므로(휴지통이라 복원은 되지만 의도와 다르다), 실행 전에 막는다.
 */
export function groupsFullySelected(
  groups: DuplicateGroup[],
  selected: ReadonlySet<string>,
): DuplicateGroup[] {
  return groups.filter((g) => g.paths.length > 0 && g.paths.every((p) => selected.has(p)));
}
