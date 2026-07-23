import { describe, expect, it } from "vitest";
import { contrastRatio, luminance, readableInk } from "./color";
import { CATEGORY_COLORS, CATEGORY_KEYS, CATEGORY_LABELS } from "../types";

/**
 * 스택 바에서 실제로 붙어 그려질 가능성이 높은 쌍만 잠근다.
 * (정렬이 크기순이라 cache·other 는 개발자 머신에서 거의 항상 1·2위로 인접한다)
 */
const ADJACENT_PAIRS: [string, string][] = [
  ["cache", "other"],
  ["code", "database"],
  ["document", "executable"],
  ["image", "audio"],
  ["video", "diskimage"],
  ["archive", "font"],
];

describe("카테고리 팔레트", () => {
  it.each(ADJACENT_PAIRS)("%s 와 %s 의 대비가 3:1 이상", (a, b) => {
    expect(contrastRatio(CATEGORY_COLORS[a], CATEGORY_COLORS[b])).toBeGreaterThanOrEqual(3);
  });

  // 개수를 손으로 적어 두면(예전의 toHaveLength(13)) 누락 상태가 오히려 고정된다.
  // 백엔드 Category::ALL 과 같은 키 목록을 기준으로 양쪽 사전을 검사한다.
  it("모든 분야 키에 색과 라벨이 있다", () => {
    for (const key of CATEGORY_KEYS) {
      expect(CATEGORY_COLORS[key], `색 누락: ${key}`).toBeTruthy();
      expect(CATEGORY_LABELS[key], `라벨 누락: ${key}`).toBeTruthy();
    }
  });

  it("사전에 목록 밖의 키가 남아 있지 않다", () => {
    const known = new Set<string>(CATEGORY_KEYS);
    expect(Object.keys(CATEGORY_COLORS).filter((k) => !known.has(k))).toEqual([]);
    expect(Object.keys(CATEGORY_LABELS).filter((k) => !known.has(k))).toEqual([]);
  });

  /**
   * 전체 91쌍 중 3:1 을 넘는 것은 일부뿐이다 — 세그먼트 사이 1px 분리선이 나머지
   * 몫을 한다. 손으로 고른 6쌍만 검사하면 팔레트를 손볼 때 실제 상태가 보이지
   * 않으므로, 미달 쌍 수를 여기에 못 박아 두고 그 수가 늘면 실패하게 한다.
   * (dataset 의 #8fb339 는 백엔드 category.rs 가 정하는 값이라 여기서는 관측만 한다)
   */
  it("분리선 없이 3:1 미만인 쌍의 수를 기록한다", () => {
    const keys = [...CATEGORY_KEYS];
    let low = 0;
    let pairs = 0;
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        pairs += 1;
        if (contrastRatio(CATEGORY_COLORS[keys[i]], CATEGORY_COLORS[keys[j]]) < 3) low += 1;
      }
    }
    expect(pairs).toBe(91);
    expect(low).toBe(58);
  });
});

/**
 * 막대 트랙은 얹히는 면과 3:1 이상 구분되어야 한다(WCAG 1.4.11 비텍스트 대비).
 * App.css 의 --track-line 값과 같아야 하며, 어긋나면 이 테스트가 먼저 깨진다.
 */
describe("트랙 토큰", () => {
  const LIGHT = { panel: "#ffffff", panel2: "#eef1f5", bg: "#f4f6f9", line: "#7a8695" };
  const DARK = { panel: "#171c24", panel2: "#1e242e", bg: "#0f1319", line: "#6a7889" };

  it.each([
    ["light/panel", LIGHT.line, LIGHT.panel],
    ["light/panel-2", LIGHT.line, LIGHT.panel2],
    ["light/bg", LIGHT.line, LIGHT.bg],
    ["dark/panel", DARK.line, DARK.panel],
    ["dark/panel-2", DARK.line, DARK.panel2],
    ["dark/bg", DARK.line, DARK.bg],
  ])("%s 위의 트랙 테두리가 3:1 이상", (_name, line, surface) => {
    expect(contrastRatio(line, surface)).toBeGreaterThanOrEqual(3);
  });
});

/**
 * 조작면 테두리는 얹히는 면과 3:1 이상이어야 한다(WCAG 1.4.11 비텍스트 대비).
 *
 * `.btn`·`.drive-card`·`.target-input`·`.tree-search`·`.chip` 은 테두리 외에
 * '누를 수 있는가'를 알리는 채널이 없다. 예전에는 면 구획용 --border 를 그대로 써서
 * 라이트 테마 1.48:1 — 흰 배경 위 거의 무색의 사각형이었다. App.css 의
 * --control-border 값과 같아야 하며, 팔레트를 다시 손봐도 여기서 먼저 깨진다.
 */
describe("조작면 토큰", () => {
  const LIGHT = { panel: "#ffffff", panel2: "#eef1f5", bg: "#f4f6f9", control: "#7d8899" };
  const DARK = { panel: "#171c24", panel2: "#1e242e", bg: "#0f1319", control: "#6a7889" };

  it.each([
    ["light/panel", LIGHT.control, LIGHT.panel],
    ["light/panel-2", LIGHT.control, LIGHT.panel2],
    ["light/bg", LIGHT.control, LIGHT.bg],
    ["dark/panel", DARK.control, DARK.panel],
    ["dark/panel-2", DARK.control, DARK.panel2],
    ["dark/bg", DARK.control, DARK.bg],
  ])("%s 위의 조작면 테두리가 3:1 이상", (_name, control, surface) => {
    expect(contrastRatio(control, surface)).toBeGreaterThanOrEqual(3);
  });
});

/** 빈 상태 고스트도 '보이는가'를 육안이 아니라 대비로 확인한다(그래픽 기준 3:1). */
describe("스켈레톤 토큰", () => {
  it.each([
    ["light", "#a4b0c0", "#ffffff", 0.72],
    ["dark", "#4a5666", "#171c24", 0.72],
  ])("%s 고스트 블록이 실효 대비 1.5:1 이상", (_name, block, surface, alpha) => {
    // opacity 가 걸리므로 실효 색은 배경과 alpha 로 섞인 값이다.
    const mix = (a: string, b: string, t: number) => {
      const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
      const c = [0, 1, 2].map((i) => Math.round(p(a, i) * t + p(b, i) * (1 - t)));
      return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    };
    expect(contrastRatio(mix(block, surface, alpha), surface)).toBeGreaterThanOrEqual(1.5);
  });
});

/**
 * seg-label 은 11px bold 라 대형 텍스트 예외(3:1)가 적용되지 않는다.
 * 팔레트를 손볼 때 이 단언이 먼저 깨져야 대비가 조용히 무너지지 않는다.
 */
describe("스택 바 라벨 대비", () => {
  it.each([...CATEGORY_KEYS])("%s 세그먼트의 라벨이 4.5:1 이상", (key) => {
    const bg = CATEGORY_COLORS[key];
    expect(contrastRatio(readableInk(bg), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * 오류 토스트는 --panel-2 위에 --danger 글자다. 다크 테마에서 12px 본문이
 * 4.5:1 에 미달했던 조합이라, 배경면 선택까지 포함해 잠근다.
 */
describe("상태 색 조합", () => {
  it.each([
    ["light/토스트", "#c62f43", "#fdeef0"],
    ["dark/토스트", "#e05263", "#2a1418"],
    ["light/위험 버튼", "#c62f43", "#ffffff"],
    ["dark/위험 버튼", "#e05263", "#171c24"],
  ])("%s 가 4.5:1 이상", (_name, ink, surface) => {
    expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * 실제 렌더 조합(토큰 × 표면 × opacity)으로 검사한다.
 *
 * 예전에는 토큰 자체만 봤고, 화면에서는 `.cat-row .link-btn { opacity: .75 }` 처럼
 * 감쇠가 곱해진 실효색이 그려졌다 — 흰 패널 위 3.18:1 이라 11px 링크가 AA 에
 * 미달했는데 팔레트 테스트는 초록이었다. 감쇠를 걷어낸 지금 상태를 여기서 잠근다.
 */
describe("accent 실효 대비", () => {
  const LIGHT_ACCENT = "#1a5fbf";
  const DARK_ACCENT = "#4a9df2";

  it.each([
    // 11px 텍스트는 굵기와 무관하게 4.5:1 이 요구된다('확장자', '안전', '… 곳 보기').
    ["light/panel", LIGHT_ACCENT, "#ffffff"],
    ["light/panel-2", LIGHT_ACCENT, "#eef1f5"],
    ["dark/panel", DARK_ACCENT, "#171c24"],
    ["dark/panel-2", DARK_ACCENT, "#1e242e"],
  ])("%s 의 링크·배지가 4.5:1 이상", (_name, ink, surface) => {
    expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    // 막대는 비텍스트 정보 요소라 자기 트랙과 3:1 이면 된다(1.4.11).
    ["light", LIGHT_ACCENT, "#dde3ea"],
    ["dark", DARK_ACCENT, "#2a323e"],
  ])("%s 트리 막대가 트랙과 3:1 이상", (_name, bar, track) => {
    expect(contrastRatio(bar, track)).toBeGreaterThanOrEqual(3);
  });
});

describe("color 유틸", () => {
  it("명도 경계", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(luminance("not-a-color")).toBe(0);
  });

  it("대비는 대칭이다", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("밝은 배경에는 어두운 글자", () => {
    expect(readableInk("#ffd166")).toBe("#0d1117");
    expect(readableInk("#3a424e")).toBe("#ffffff");
  });
});
