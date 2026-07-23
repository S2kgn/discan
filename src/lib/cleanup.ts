import { ScanNode, isFileNode } from "../types";

export type CleanupRisk = "safe" | "caution";

/** 후보 한 곳. 크기를 버리면 '순위의 근거가 화면에 없는 순위 목록'이 된다. */
export interface CleanupHit {
  path: string;
  size: number;
  /** 이 항목을 실제로 구분해 주는 이름(labelFor). 규칙 이름과 겹치지 않는다. */
  label: string;
}

export interface CleanupTip {
  id: string;
  title: string;
  /** 왜 후보인지 한 줄. 사용자가 스스로 판단할 근거를 준다. */
  hint: string;
  risk: CleanupRisk;
  size: number;
  /** 같은 사유로 잡힌 항목 수. 대표 경로 하나만 카드 머리에 띄운다. */
  count: number;
  path: string;
  /** 대표 경로의 식별 이름. 규칙 이름('Cache')이 아니라 판별에 쓰이는 조상이다. */
  label: string;
  /**
   * 큰 것부터의 후보 목록(상한 TOP_PATHS).
   *
   * 합계만 알려 주고 대표 한 곳만 열어 주면 '80곳 중 1.57 GiB' 를 보고도 도달할 수
   * 있는 것은 한 조각뿐이다. 나머지에 이르는 길이 카드 안에 있어야 한다.
   */
  paths: CleanupHit[];
  /** 검색으로 나머지에 도달할 때 쓸 질의어(규칙이 잡는 폴더 이름). */
  query: string;
  /**
   * 합계·개수가 하한값인지.
   *
   * 이 함수는 이미 가지치기된 트리(result.root)를 훑는다 — 백엔드가 임계 미만
   * 폴더·깊이 상한 초과·폴더당 상위 N개 밖을 결과에 싣기 전에 버리므로, 잡히지
   * 않은 캐시 폴더가 반드시 남는다. 그 사실을 값에 실어 두지 않으면 화면이
   * '합계 1.57 GiB'를 확정 수치로 적게 된다.
   */
  isLowerBound: boolean;
}

/** 카드에서 펼쳐 보여 줄 경로 수. 이보다 많으면 트리 검색으로 넘긴다. */
export const TOP_PATHS = 5;

interface Rule {
  id: string;
  title: string;
  hint: string;
  risk: CleanupRisk;
  /** 매칭 대상 폴더 이름들(소문자). 첫 항목을 트리 검색어로 그대로 쓴다. */
  names: string[];
}

/**
 * 대부분의 사용자에게 정답인 정리 후보. 스캔 데이터 안에 이미 다 들어 있는데
 * 트리를 직접 해석하게 두면 앱을 켠 목적이 달성되지 않는다.
 */
const RULES: Rule[] = [
  {
    id: "recycle",
    title: "휴지통",
    hint: "비우면 즉시 공간이 확보됩니다.",
    risk: "safe",
    names: ["$recycle.bin", "$recycle.bin.old", ".trash"],
  },
  {
    // 사본이 하나뿐인 문서가 흔히 머무는 곳이다. 이 앱이 삭제를 수행하지 않는다는
    // 사실이 잘못된 '안전' 표시의 면책이 되지는 않는다.
    id: "downloads",
    title: "다운로드 폴더",
    hint: "설치 파일과 함께 사본이 하나뿐인 문서가 섞여 있을 수 있습니다.",
    risk: "caution",
    names: ["downloads", "다운로드"],
  },
  {
    id: "windows-old",
    title: "이전 Windows 설치본",
    hint: "업그레이드 잔여물입니다. 설정 > 저장 공간의 정리 도구로 지우십시오.",
    risk: "safe",
    names: ["windows.old", "$windows.~bt", "$windows.~ws"],
  },
  {
    id: "temp",
    title: "임시 파일",
    hint: "재부팅 후에도 남는 임시 파일입니다. 삭제해도 복구됩니다.",
    risk: "safe",
    names: ["temp", "tmp", "temporary internet files"],
  },
  {
    id: "node-modules",
    title: "node_modules",
    hint: "npm install 로 언제든 복구됩니다. 쓰지 않는 프로젝트부터 지우십시오.",
    risk: "safe",
    names: ["node_modules"],
  },
  {
    id: "pkg-cache",
    title: "패키지 캐시",
    hint: "도구가 다시 내려받습니다. 다만 오프라인 환경이면 재설치가 느려집니다.",
    risk: "safe",
    names: [".cargo", ".gradle", ".nuget", ".m2", "packagecache", "npm-cache", "pip"],
  },
  {
    id: "app-cache",
    title: "앱 캐시",
    hint: "앱이 다시 만듭니다. 로그인 상태가 풀릴 수 있습니다.",
    risk: "caution",
    names: ["cache", "caches", ".cache", "cache_data", "code cache", "gpucache"],
  },
  {
    id: "vcs",
    title: ".git 저장소 이력",
    hint: "지우면 작업 이력이 사라집니다. 삭제 대상이 아니라 참고용입니다.",
    risk: "caution",
    names: [".git", ".svn", ".hg"],
  },
  {
    // target·obj·build·dist 는 뺐다. 백엔드 category.rs 의 is_conditional_cache_dir 이
    // '너무 흔한 단어'라는 근거로 빌드 지문(Cargo.toml·CACHEDIR.TAG 등)이 있을 때만
    // 캐시 힌트를 주는데, 이름만 보는 규칙을 여기 두면 D:\Photos\dist 가 삭제 권고
    // 패널 최상단으로 올라와 그 방어가 무효가 된다. 백엔드가 노드에 힌트 출처를
    // 실어 보내기 전까지는 오탐 없는 이름만 남긴다.
    id: "venv",
    title: "가상환경",
    hint: "재생성은 가능하나 설치해 둔 패키지가 함께 사라집니다.",
    risk: "caution",
    names: [".venv", "venv", "__pycache__"],
  },
];

/** 규칙이 잡는 폴더 이름 전체. 이 집합에 속한 이름은 정의상 식별자가 될 수 없다. */
const RULE_NAMES = new Set(RULES.flatMap((r) => r.names));

/**
 * 규칙 이름과 함께 '어디에나 있는' 중간 폴더 이름.
 *
 * `…\r_news_dark\Default\Cache` 에서 첫 비규칙 조상은 'Default' 인데, 그 이름은
 * 80곳 중 어느 것인지 알려 주지 못한다(Chromium 프로필은 거의 모두 Default 다).
 * 규칙 이름과 같은 이유로 건너뛴다 — 판별력이 0인 토큰을 굵게 내는 것이 이 항목의
 * 결함이었으므로, 그 판정을 이름 하나가 아니라 집합으로 둔다.
 */
const GENERIC_ANCESTORS = new Set([
  "default",
  "local",
  "locallow",
  "roaming",
  "appdata",
  "data",
  "user data",
  "profiles",
  "profile",
  "storage",
]);

/**
 * 카드에서 굵게 낼 식별 이름.
 *
 * RULES 는 폴더 이름이 규칙과 정확히 일치할 때만 후보로 잡으므로, 마지막 구성요소는
 * 정의상 언제나 'cache'/'node_modules' 중 하나다 — 가장 강조된 요소의 정보량이 0이
 * 되는 위계 역전이었다. 규칙 이름·범용 이름이 아닌 첫 조상까지 올라가 그것을 낸다.
 */
export function labelFor(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const lower = parts[i].toLowerCase();
    // 드라이브 문자는 어느 후보에나 붙는 값이라 식별자가 되지 못한다.
    if (/^[a-z]:$/.test(lower)) continue;
    if (!RULE_NAMES.has(lower) && !GENERIC_ANCESTORS.has(lower)) return parts[i];
  }
  // 전부 규칙·범용 이름이면(예: `C:\Temp`) 마지막 구성요소가 유일한 식별자다.
  return parts[parts.length - 1] ?? path;
}

export interface CleanupOptions {
  /** 카드 개수 상한. */
  limit?: number;
  /**
   * 백엔드 가지치기 임계값(pruneParams.minSize). 값이 있으면 이 트리에서 그보다
   * 작은 폴더가 이미 제거되었다는 뜻이라, 합계·개수가 하한값임이 확정된다.
   */
  minSize?: number;
}

/**
 * 트리를 훑어 정리 후보를 사유별로 합산한다.
 * 임계값을 두는 이유 — 100MB짜리 후보 다섯 개를 맨 위에 올려 봐야 도움이 안 된다.
 */
export function cleanupTips(
  root: ScanNode,
  totalSize: number,
  options: CleanupOptions = {},
): CleanupTip[] {
  const { limit = 4, minSize = 0 } = options;
  const floor = Math.max(64 * 1024 * 1024, totalSize * 0.01);
  const acc = new Map<string, CleanupTip>();
  // 사유별 개별 항목. 상위 몇 곳을 카드에서 펼쳐 보여 주려면 경로를 모아 둬야 한다.
  const hits = new Map<string, CleanupHit[]>();
  /*
   * 이 트리에서 무엇인가 이미 잘려 나갔는지.
   *
   * 임계값이 넘어오지 않는 호출(테스트·구버전 페이로드)에서도, 노드에 남은
   * truncated 흔적만으로 '이 합계는 하한'임을 판정할 수 있다. 둘 중 하나라도
   * 성립하면 카드는 확정 수치가 아니라 하한으로 적어야 한다.
   */
  let pruned = minSize > 0;

  const walk = (node: ScanNode) => {
    if (node.truncated > 0) pruned = true;
    if (isFileNode(node)) return;

    const name = node.name.toLowerCase();
    const rule = RULES.find((r) => r.names.includes(name));
    if (rule) {
      const list = hits.get(rule.id) ?? [];
      // 식별 이름은 히트마다 한 번만 계산한다(컴포넌트가 렌더마다 다시 풀 이유가 없다).
      list.push({ path: node.path, size: node.size, label: labelFor(node.path) });
      hits.set(rule.id, list);

      const prev = acc.get(rule.id);
      if (prev) {
        prev.size += node.size;
        prev.count += 1;
      } else {
        acc.set(rule.id, {
          id: rule.id,
          title: rule.title,
          hint: rule.hint,
          risk: rule.risk,
          size: node.size,
          count: 1,
          path: node.path,
          label: labelFor(node.path),
          paths: [],
          query: rule.names[0],
          // 최종 판정은 순회가 끝난 뒤에 한 번에 채운다(뒤쪽 가지에서 잘림이 나올 수 있다).
          isLowerBound: false,
        });
      }
      // 같은 사유가 중첩되는 경우(node_modules 안의 node_modules)는 이중 계산이 되므로
      // 일치한 가지 아래로는 더 내려가지 않는다.
      return;
    }

    for (const child of node.children) walk(child);
  };

  walk(root);

  for (const tip of acc.values()) {
    const sorted = (hits.get(tip.id) ?? []).sort((a, b) => b.size - a.size);
    // 크기를 버리면 순위의 근거가 화면에서 사라진다. 잘라 낸 결과를 그대로 싣는다.
    tip.paths = sorted.slice(0, TOP_PATHS);
    // 카드 머리의 대표 경로는 언제나 가장 큰 곳이어야 한다.
    tip.path = sorted[0]?.path ?? tip.path;
    tip.label = sorted[0]?.label ?? tip.label;
    tip.isLowerBound = pruned;
  }

  return [...acc.values()]
    .filter((t) => t.size >= floor)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);
}
