import { memo, useState } from "react";
import { CleanupTip, TOP_PATHS } from "../lib/cleanup";
import { formatBytes, formatBytesParts, formatCount, middlePath } from "../lib/format";

interface Props {
  tips: CleanupTip[];
  /**
   * 지금의 볼륨 여유 공간. 모르면 null.
   *
   * 예전에는 '안전 항목을 모두 정리한 뒤의 여유 공간' 하나만 받았는데, 그 값은 안전
   * 합계가 0보다 클 때만 계산되었다. 실사용에서 가장 흔한 후보(앱 캐시·다운로드·
   * .git·가상환경)가 모두 '주의' 등급이라, 이 앱을 켠 이유에 대한 답이 통째로
   * 사라지는 것이 예외가 아니라 표준 화면이었다. 도달점을 여기서 두 개 만든다.
   */
  free?: number | null;
  /** 백엔드 가지치기 임계값. 합계가 왜 하한인지 근거를 화면에 남길 때 쓴다. */
  minSize?: number;
  /**
   * 분야 패널의 '캐시·빌드 산출물' 합계. 후보 합계와 8배씩 어긋나는 두 숫자를
   * 한 문장 안에 놓아 화해시키기 위한 값이다.
   */
  cacheCategory?: { label: string; size: number } | null;
  onReveal: (path: string) => void;
  /** 나머지 위치로 가는 길. 트리 검색어를 채워 준다. */
  onSearch?: (query: string) => void;
}

/** 등급을 색 하나에 싣지 않는다 — '지워도 되는가'는 되돌릴 수 없는 판단이다. */
const RISK_LABEL = { safe: "안전", caution: "주의" } as const;
const RISK_DESC = {
  safe: "지워도 되돌릴 수 있는 항목입니다.",
  caution: "지우기 전에 내용을 확인해야 하는 항목입니다.",
} as const;

/** 숫자를 보러 온 사람은 없다. 되찾을 공간의 후보를 먼저 짚어 준다. */
function CleanupTipsImpl({ tips, free, minSize, cacheCategory, onReveal, onSearch }: Props) {
  // 카드마다 '상위 N곳 보기'가 열려 있는지. 기본은 접힘 — 카드 높이가 목록으로 늘어나면
  // 여러 후보를 나란히 비교할 수 없다.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /*
   * 면책 팝오버.
   *
   * 예전에는 title 속성뿐이었는데 브라우저는 키보드 포커스만으로 title 툴팁을 띄우지
   * 않는다 — tabIndex 를 줘도 키보드·터치 사용자에게는 존재하지 않는 문구였다.
   * 내보내기 메뉴와 같은 '눌러서 여는' 패턴으로 바꿔 낭독·터치에서도 도달하게 한다.
   */
  const [noteOpen, setNoteOpen] = useState(false);
  if (tips.length === 0) return null;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const total = tips.reduce((sum, t) => sum + t.size, 0);
  const safeTotal = tips.filter((t) => t.risk === "safe").reduce((sum, t) => sum + t.size, 0);
  // 하나라도 가지치기된 트리에서 나왔으면 합계 전체가 하한이다.
  const lowerBound = tips.some((t) => t.isLowerBound);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">이것부터 확인해 보십시오</h2>
        <button
          type="button"
          className="panel-info"
          aria-expanded={noteOpen}
          aria-label="이 목록을 읽는 조건"
          onClick={() => setNoteOpen((v) => !v)}
        >
          ⓘ
        </button>
      </div>
      {noteOpen && (
        <p className="tip-note" role="note">
          이 앱은 아무것도 지우지 않습니다 — 삭제는 탐색기에서 직접 확인한 뒤 하십시오. 등급은
          일반적인 기준이며, 지워도 되는지의 최종 판단은 내용을 보고 하셔야 합니다.
        </p>
      )}

      {/* '이걸 지우면 몇 GB 남지?'는 이 패널이 답해야 할 질문이다. 다만 그 답이
          확정 수치처럼 읽히면 안 된다 — 아래 합계는 가지치기된 트리에서 나온 하한이다. */}
      <p className="tip-goal">
        후보 합계 {lowerBound && "최소 "}
        {formatBytes(total)}
        {safeTotal > 0 && safeTotal < total && ` (그중 ‘안전’ 항목 ${formatBytes(safeTotal)})`}
      </p>
      {/*
        도달점은 두 개다.
        '안전' 항목만 정리했을 때와 후보를 전부 정리했을 때를 나란히 내면, 등급의
        의미(되돌릴 수 있는가)까지 같은 줄에서 전달된다. 안전 합계가 0인 흔한 경우에도
        문장이 사라지지 않고, 대신 전부가 '주의'라는 사실을 함께 적는다.
      */}
      {free !== null && free !== undefined && (
        <p className="tip-goal-free">
          지금 여유 {formatBytes(free)} →{" "}
          {safeTotal > 0 ? (
            <>
              ‘안전’ 항목만 정리하면 약 {formatBytes(free + safeTotal)}
              {safeTotal < total && `, 후보를 모두 정리하면 약 ${formatBytes(free + total)}`} 가
              됩니다.
            </>
          ) : (
            <>
              후보를 모두 정리하면 최대 약 {formatBytes(free + total)} 가 됩니다. 다만 이 후보는
              모두 ‘주의’ 등급이라 내용을 확인한 뒤 지우셔야 합니다.
            </>
          )}
        </p>
      )}
      {/* 숫자의 해석 조건은 숫자 옆에 있어야 한다. 호버 전용 ⓘ 안에 두면
          키보드·터치 사용자에게는 '1.57 GiB'가 확정값으로만 읽힌다. */}
      <p className="tip-goal-note">
        {/*
          가장 큰 누락 사유를 적지 않으면 '작은 폴더 몇 개가 빠진 정도'로 오해된다.
          분야 패널이 '캐시·빌드 산출물 12.8 GiB'라고 말하는 화면에서 이 카드가
          '1.57 GiB'를 내면 8배 차이가 설명 없이 남는데, 실제 원인은 임계값이 아니라
          '이름으로 확실히 알아볼 수 있는 폴더만 센다'는 규칙이다.
        */}
        후보는 이름으로 확실히 알아볼 수 있는 폴더(캐시·휴지통·node_modules 등)만 셉니다
        {cacheCategory && cacheCategory.size > total
          ? ` — ‘${cacheCategory.label}’로 분류된 ${formatBytes(cacheCategory.size)} 중 ${formatBytes(total)} 입니다. 나머지는 아래 ‘폴더별 용량’에서 직접 확인하십시오.`
          : " — 나머지는 아래 ‘폴더별 용량’에서 직접 확인하십시오."}
        {lowerBound &&
          (minSize !== undefined && minSize > 0
            ? ` 합계는 화면에 표시된 폴더만 더한 값이라, 용량이 ${formatBytes(minSize)} 미만이거나 너무 깊은 폴더는 목록에 없습니다.`
            : " 합계는 화면에 표시된 폴더만 더한 값이라, 생략된 작은·깊은 폴더가 빠져 있습니다.")}
      </p>

      <div className={`tip-grid${tips.length <= 2 ? " sparse" : ""}`}>
        {tips.map((tip) => {
          // 카드가 가로로 나란히 놓이므로 여기도 목록 규칙(1자리 고정)을 따른다.
          const size = formatBytesParts(tip.size, { fixedDigits: 1 });
          const multi = tip.count > 1;
          const expanded = open.has(tip.id);
          const shown = Math.min(tip.count, tip.paths.length || TOP_PATHS);
          return (
            <article
              key={tip.id}
              className={`tip-card ${tip.risk}`}
              aria-label={`${tip.title} — ${RISK_LABEL[tip.risk]}. ${RISK_DESC[tip.risk]}`}
            >
              <div className="tip-head">
                <span className="tip-title">{tip.title}</span>
                <span className={`tip-risk ${tip.risk}`} title={RISK_DESC[tip.risk]}>
                  {RISK_LABEL[tip.risk]}
                </span>
                <span className="tip-size">
                  {/* 여러 폴더의 합계를 한 폴더의 크기로 읽히게 두면 그냥 거짓말이다.
                      가지치기된 트리에서 나온 값이면 취소된 스캔과 같은 관용으로 ≥ 를 붙인다. */}
                  {multi && <span className="tip-approx">합계</span>}
                  {tip.isLowerBound && (
                    <span className="tip-approx" title="표시된 폴더만 더한 값이라 실제로는 더 큽니다">
                      ≥
                    </span>
                  )}
                  {size.value} {size.unit}
                </span>
              </div>
              <p className="tip-hint">{tip.hint}</p>
              <div className="tip-foot">
                <span className="tip-where">
                  <span className="tip-where-label">
                    {multi ? `${formatCount(tip.count)}곳 중 가장 큰 곳` : "위치"}
                  </span>
                  {/*
                    규칙 이름과 일치하는 마지막 구성요소는 식별자가 될 수 없다 —
                    app-cache 규칙에 걸린 항목의 baseName 은 정의상 언제나 'Cache' 라,
                    가장 강조된 요소의 정보량이 0이고 바로 아래 경로 꼬리와 글자까지
                    같았다. cleanup.ts 가 히트마다 계산해 넘기는 식별 이름을 쓴다.
                  */}
                  <strong className="tip-base">{tip.label}</strong>
                  <span className="tip-path" title={tip.path}>
                    {middlePath(tip.path, 56)}
                  </span>
                </span>
                <button type="button" className="btn tiny" onClick={() => onReveal(tip.path)}>
                  탐색기에서 위치 보기
                </button>
              </div>

              {/* 합계는 여러 곳을 더한 값인데 열 수 있는 것이 한 곳뿐이면,
                  큰 숫자를 보여 주고 실행은 막는 카드가 된다. */}
              {multi && (
                <div className="tip-more">
                  {/* 라벨이 '80곳 모두 보기'인데 실제로는 5곳만 펼쳐졌다 — 접힘 상태의
                      약속과 펼친 뒤의 결과가 같은 수를 가리켜야 한다. */}
                  <button
                    type="button"
                    className="tip-more-btn"
                    aria-expanded={expanded}
                    onClick={() => toggle(tip.id)}
                  >
                    {expanded
                      ? "접기"
                      : /* 1위의 크기를 접힘 라벨에 함께 내면, 합계가 한 곳에 몰렸는지
                           80곳에 고르게 퍼졌는지가 펼치기 전에 판별된다. */
                        `가장 큰 ${formatCount(shown)}곳 보기 (전체 ${formatCount(tip.count)}곳${
                          tip.paths[0] ? ` · 최대 ${formatBytes(tip.paths[0].size)}` : ""
                        })`}
                  </button>
                  {expanded && (
                    <>
                      <p className="tip-paths-head">용량 상위 {formatCount(shown)}곳입니다.</p>
                      <ul className="tip-paths">
                        {tip.paths.map((h) => {
                          // 다른 목록(분야·파일·트리)과 같은 .num/.unit 두 칸을 써야
                          // 숫자 축이 맞는다. 자릿수도 목록 규칙(1자리)을 따른다.
                          const hs = formatBytesParts(h.size, { fixedDigits: 1 });
                          return (
                            <li key={h.path}>
                              <button
                                type="button"
                                className="tip-path-btn"
                                title={h.path}
                                onClick={() => onReveal(h.path)}
                              >
                                <strong className="tip-path-label">{h.label}</strong>
                                <span className="tip-path-rest">{middlePath(h.path, 44)}</span>
                              </button>
                              <span className="tip-path-size">
                                <span className="num">{hs.value}</span>
                                <span className="unit">{hs.unit}</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {tip.count > tip.paths.length && onSearch && (
                        <button
                          type="button"
                          className="tip-more-btn"
                          onClick={() => onSearch(tip.query)}
                        >
                          나머지 {formatCount(tip.count - tip.paths.length)}곳은 폴더별 용량에서 ‘
                          {tip.query}’ 검색
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 진행 이벤트(150ms)마다 App 이 리렌더되어도 이 패널까지 재조정할 이유는 없다.
 * 넘어오는 콜백은 App 에서 useCallback 으로 고정해 두었다.
 */
export const CleanupTips = memo(CleanupTipsImpl);
