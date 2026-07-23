/** #rrggbb → [0,1] 채널. 잘못된 값은 검정으로 떨어뜨린다. */
function channels(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function linear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 상대 명도. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 두 색의 명도 대비. 인접 그래픽 요소는 3:1 이상이어야 한다(WCAG 1.4.11). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 스택 바 라벨에 쓰는 두 잉크. 다른 색을 섞지 않는다. */
export const INK_DARK = "#0d1117";
export const INK_LIGHT = "#ffffff";

/**
 * 배경색 위에 얹을 글자색. 스택 바 안쪽 라벨에 쓴다.
 *
 * 예전에는 명도 0.35 를 경계로 갈랐는데, 흑백 대비가 실제로 뒤집히는 지점은
 * 0.179 여서 그 사이 구간(video #ff6b7a, game #eb5fc0 — 개인용 디스크에서 상위
 * 분야가 되기 쉬운 두 색)이 흰 글자를 받아 AA 4.5:1 에 미달했다. 임계값을 고쳐
 * 잡는 대신 두 후보의 대비를 직접 비교한다 — 팔레트를 손봐도 다시 틀어지지 않는다.
 */
export function readableInk(background: string): string {
  return contrastRatio(background, INK_LIGHT) >= contrastRatio(background, INK_DARK)
    ? INK_LIGHT
    : INK_DARK;
}
