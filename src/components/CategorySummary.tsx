import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  CATEGORY_WARNINGS,
  CategoryStat,
  ExtStat,
  categoryColor,
  categoryLabel,
  extLabel,
  isExtOverflowRow,
} from "../types";
import { formatBytes, formatBytesParts, formatCount, formatPercent, percent } from "../lib/format";
import { readableInk } from "../lib/color";

interface Props {
  categories: CategoryStat[];
  /** 디렉터리 힌트를 무시한 순수 확장자 분류. '캐시 84%'의 내부를 되돌려 본다. */
  contentCategories?: CategoryStat[];
  /** 용량 상위 확장자. '기타'를 분해할 유일한 수단이다. */
  extensions?: ExtStat[];
  /**
   * 분야가 'other' 인 확장자만 따로 뽑은 목록.
   *
   * 전역 상위 30개로만 조인하면 '기타'로 좁혔을 때 남는 것이 __none·__overflow 뿐이라
   * '기타 1.65 GiB → 그 밖의 확장자 1.5 GiB' 라는 동어반복에 도달한다. 미분류는
   * 정의상 롱테일이라 개별 확장자가 전역 상위 30에 하나도 들지 못하기 때문이다.
   */
  otherExtensions?: ExtStat[];
  totalSize: number;
  /** 결과가 비었을 때 원인을 구분해 안내하려고 받는다. */
  errors: number;
  /** '권한 문제'로 단정하지 않도록 사유별 분해가 있으면 함께 받는다. */
  errorHint?: string;
}

type Axis = "hint" | "content" | "ext";

/**
 * 라벨 실폭 추정.
 *
 * 예전에는 글자당 8px 고정이었는데 .seg-label 은 11px 이고 한글·CJK 는 전각이라
 * 실제 advance 가 폰트 크기와 거의 같다 — 추정이 실폭의 70% 수준이라, 잘릴 라벨을
 * 거르려고 만든 판정이 오히려 '캐시·빌드 산…'을 통과시켰다. 전각과 반각을 나눠
 * 재고, 추정이 실폭보다 크게 나오도록 여유를 둔다.
 */
const LABEL_CJK_PX = 11.5;
const LABEL_ASCII_PX = 6.5;
const LABEL_PAD_PX = 14;

/** 전각으로 그려지는 문자대(한글·한자·가나·전각 기호). */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export function labelWidthPx(label: string): number {
  let w = LABEL_PAD_PX;
  for (const ch of label) w += WIDE_CHAR.test(ch) ? LABEL_CJK_PX : LABEL_ASCII_PX;
  return w;
}

/**
 * 축마다 제목·대체 텍스트가 달라야 한다.
 * '확장자' 탭에서 제목이 '분야별 구성'이면 화면 낭독 사용자에게 축 전환이 전달되지 않는다.
 */
const AXIS_TITLE: Record<Axis, string> = {
  hint: "분야별 구성",
  content: "내용 기준 구성",
  ext: "확장자별 구성",
};
const AXIS_CHART_LABEL: Record<Axis, string> = {
  hint: "분야별 용량 비중",
  content: "내용 기준 용량 비중",
  ext: "확장자별 용량 비중",
};

function CategorySummaryImpl({
  categories,
  contentCategories,
  extensions,
  otherExtensions,
  totalSize,
  errors,
  errorHint,
}: Props) {
  const [axis, setAxis] = useState<Axis>("hint");
  /**
   * 확장자 축을 특정 분야로 좁힌 상태.
   *
   * '기타 12.9%'를 보고도 그것이 무엇으로 채워졌는지 알 방법이 없으면, 사용자는
   * 미분류 덩어리를 영원히 분해할 수 없고 분류표를 개선할 피드백 루프도 생기지
   * 않는다. 단, 조인이 성립하는 축은 '내용 기준'뿐이다(아래 crossFrom 참고).
   */
  const [extFilter, setExtFilter] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);

  // 세그먼트에 라벨이 들어가는지는 퍼센트가 아니라 실측 폭으로만 알 수 있다.
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setBarWidth(entries[0].contentRect.width));
    ro.observe(el);
    setBarWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const hasContent = (contentCategories?.length ?? 0) > 0;
  const hasExt = (extensions?.length ?? 0) > 0;

  /** 백엔드가 확장자→분야 매핑을 실어 보내면 교차 필터가 가능하다. */
  const canCross = (extensions ?? []).some((e) => e.category !== undefined);

  /**
   * 어느 분야에 실제로 상위 확장자가 있는지.
   *
   * 백엔드는 용량 상위 30개 확장자만 싣는다. 그 안에 하나도 들지 못한 분야에서
   * 교차 링크를 렌더하면 눌렀을 때 막대도 목록도 사라진 빈 패널이 나온다 —
   * 실패가 예정된 어포던스는 애초에 주지 않는다(드라이브 카드와 같은 원칙).
   */
  const crossable = useMemo(() => {
    const set = new Set<string>();
    for (const e of extensions ?? []) if (e.category) set.add(e.category);
    // 'other' 는 전역 상위 30 안에 개별 확장자가 없어도 전용 목록으로 분해된다.
    if ((otherExtensions?.length ?? 0) > 0) set.add("other");
    return set;
  }, [extensions, otherExtensions]);

  /** 확장자 목록도 분야 행과 같은 포맷으로 그리면 비교가 된다. */
  const extRows = useMemo<CategoryStat[]>(() => {
    if (!extensions) return [];
    const scoped =
      extFilter === "other" && (otherExtensions?.length ?? 0) > 0
        ? // '기타'는 전용 목록으로 분해한다. 전역 목록을 걸러 봐야 센티널 두 줄뿐이다.
          otherExtensions!
        : extFilter && canCross
          ? extensions.filter((e) => e.category === extFilter)
          : extensions;
    const listed = scoped.reduce((sum, e) => sum + e.size, 0);
    // 확장자에는 고유색이 없으므로 분야 팔레트를 순환해 인접 세그먼트만 갈라 준다.
    const palette = Object.values(CATEGORY_COLORS).filter((c) => c !== CATEGORY_COLORS.other);
    const rows: CategoryStat[] = scoped.map((e, i) => ({
      key: `ext:${e.ext}`,
      // 백엔드의 ASCII 센티널("__overflow")이 화면에 직접 새어 나가지 않게 한다.
      // 접어 넣은 종수를 함께 내야 그 덩어리가 소수의 대형 파일인지 롱테일인지 갈린다.
      label:
        isExtOverflowRow(e.ext) && (e.kinds ?? 0) > 1
          ? `${extLabel(e.ext)} (${formatCount(e.kinds ?? 0)}종)`
          : extLabel(e.ext),
      size: e.size,
      files: e.files,
      // 잔여 합산 행은 개별 확장자가 아니다. 색으로도 구분해 둔다.
      color: isExtOverflowRow(e.ext) ? CATEGORY_COLORS.other : palette[i % palette.length],
    }));
    // 분야로 좁힌 목록은 전체의 100%를 설명할 의무가 없다(분모가 다르다).
    const residual = extFilter && canCross ? 0 : Math.max(0, totalSize - listed);
    if (residual > 0) {
      rows.push({
        key: "ext:__residual",
        label: "그 밖의 확장자 합계",
        size: residual,
        files: 0,
        color: CATEGORY_COLORS.other,
      });
    }
    return rows;
  }, [extensions, otherExtensions, totalSize, extFilter, canCross]);

  const rows = axis === "content" ? contentCategories ?? [] : axis === "ext" ? extRows : categories;

  /**
   * 비중의 분모.
   *
   * 분야로 좁힌 확장자 목록은 그 분야만의 부분집합이라 전체 용량을 분모로 쓰면
   * 목록의 합이 결코 100%가 되지 않는다. 그런데 막대의 마지막 세그먼트에는
   * flex-grow 가 걸려 남는 폭을 전부 흡수하므로, 2%짜리 확장자가 막대의 90%를
   * 차지한 것처럼 그려져 바로 아래의 '2.0%'와 정면으로 어긋났다. 분모를 걸러낸
   * 합계로 바꾸고 '이 분야 안에서의 비중'임을 문장으로 밝힌다.
   */
  const scopedTotal = rows.reduce((sum, c) => sum + c.size, 0);
  const filtering = axis === "ext" && extFilter !== null && canCross;
  const basis = filtering ? scopedTotal : totalSize;

  /** 백엔드가 실제로 나열한 개별 확장자 수. 잔여 합산 행은 세지 않는다. */
  const listedExtCount = (extensions ?? []).filter((e) => !isExtOverflowRow(e.ext)).length;

  // 1위 분야에 주의 문구가 달려 있으면 그것은 목록 안이 아니라 목록 위에 있어야 한다.
  const top = [...categories].sort((a, b) => b.size - a.size)[0];
  const topWarning =
    top && CATEGORY_WARNINGS[top.key] ? { stat: top, text: CATEGORY_WARNINGS[top.key] } : null;

  // 패널 골격은 언제나 유지한다. 스캔 대상에 따라 패널이 사라지면 레이아웃을 학습할 수 없다.
  if (categories.length === 0) {
    return (
      <section className="panel">
        <h2 className="panel-title">{AXIS_TITLE.hint}</h2>
        <p className="panel-empty">
          {errors > 0
            ? errorHint ?? `${formatCount(errors)}개 항목을 읽지 못해 이 경로의 내용을 분류하지 못했습니다.`
            : "분류할 파일이 없습니다."}
        </p>
      </section>
    );
  }

  const visible = rows.filter((c) => percent(c.size, basis) >= 0.1);
  const smallSum = rows
    .filter((c) => percent(c.size, basis) < 0.1)
    .reduce((sum, c) => sum + c.size, 0);

  const labelOf = (c: CategoryStat) => (axis === "ext" ? c.label ?? c.key : categoryLabel(c));

  /**
   * 행에서 제공할 교차 조작.
   *
   * 힌트 축(result.categories)의 키를 ExtStat.category 로 조인하면 모집단이 다르다 —
   * ext_category() 는 디렉터리 힌트를 적용하지 않으므로, '캐시 12.0 GiB'에서
   * 확장자로 넘어가면 확장자 자체가 캐시로 분류되는 pyc·log·obj 만 남고 정작 그
   * 12 GiB 의 대부분인 node_modules 의 .js·.json 은 '코드'에 남는다. 두 축을 이어
   * 붙이면 사용자의 질문에 다른 모집단의 답이 돌아가므로, 힌트 축에서는 축 전환만
   * 시키고(정의가 같은 내용 기준으로 이동) 교차 필터는 내용 축에서만 연다.
   *
   * 힌트 축에서 그 축 전환 링크를 14개 행 전부에 달면, 행마다 하는 일이 똑같은데도
   * 밑줄 친 파란 텍스트의 세로 띠가 생겨 크기 내림차순이라는 이 목록의 유일한 조직
   * 원리를 방해한다(축 전환은 이미 탭에 있다). 분해할 동기가 실제로 있는 '기타'
   * 한 행에만 남긴다.
   */
  const crossOf = (c: CategoryStat): { text: string; run: () => void } | null => {
    if (axis === "ext") return null;
    if (axis === "hint") {
      if (!hasContent || c.key !== "other") return null;
      return { text: "내용 기준으로 분해", run: () => setAxis("content") };
    }
    if (!hasExt || !canCross || !crossable.has(c.key)) return null;
    return {
      text: "확장자",
      run: () => {
        setExtFilter(c.key);
        setAxis("ext");
      },
    };
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">{AXIS_TITLE[axis]}</h2>
        {/*
          선택 상태에 .btn.primary 를 쓰지 않는다.
          accent 채움 + accent-ink 는 이 디자인 시스템에서 '스캔 시작'이라는 단 하나의
          주 행동에 배정된 토큰이다. 그것을 현재 선택 표시에 쓰면 결과 화면에서
          유일하게 채워진 버튼이 사실은 아무 일도 하지 않는 버튼이 된다.
          세그먼티드 컨트롤 전용 상태(밑선·테두리)로 분리한다.
        */}
        <div className="axis-tabs" role="group" aria-label="집계 축">
          <button
            type="button"
            className="btn tiny axis-tab"
            aria-pressed={axis === "hint"}
            onClick={() => setAxis("hint")}
          >
            분야
          </button>
          {hasContent && (
            <button
              type="button"
              className="btn tiny axis-tab"
              aria-pressed={axis === "content"}
              onClick={() => setAxis("content")}
              title="폴더 이름 힌트를 빼고 파일 확장자만으로 다시 분류한 결과입니다"
            >
              내용 기준
            </button>
          )}
          {hasExt && (
            <button
              type="button"
              className="btn tiny axis-tab"
              aria-pressed={axis === "ext"}
              onClick={() => {
                setExtFilter(null);
                setAxis("ext");
              }}
              title="'기타'가 무엇으로 채워졌는지 확장자로 분해합니다"
            >
              확장자
            </button>
          )}
        </div>
      </div>

      {axis === "content" && (
        <p className="axis-note">
          폴더 이름 힌트(cache·node_modules 등)를 빼고 파일 확장자만으로 다시 분류한 결과입니다.
          '캐시·임시 파일'의 내부가 무엇이었는지 여기서 확인할 수 있습니다.
        </p>
      )}
      {axis === "ext" && (
        <p className="axis-note">
          {filtering && (
            <>
              <strong>{CATEGORY_LABELS[extFilter!] ?? extFilter}</strong>(내용 기준)로 분류된 확장자{" "}
              {formatCount(rows.length)}개 · 합계 {formatBytes(scopedTotal)} 만 보고 있습니다. 아래
              비중은 <strong>이 분야 안에서의 비중</strong>입니다.{" "}
              <button type="button" className="link-btn" onClick={() => setExtFilter(null)}>
                전체 보기
              </button>{" "}
            </>
          )}
          용량 상위 {formatCount(listedExtCount)}개 확장자와, 그 밖의 확장자를 백엔드가 하나로
          합산한 행입니다. 색은 인접 구분용이며 분야 색과 의미가 다릅니다.
        </p>
      )}

      {/* '캐시 85% = 10.9 GiB' 는 '지우면 10 GB 가 생긴다'로 읽힌다. 그 오해를 막는
          문장이 배지의 title 속성에만 있으면 터치·키보드 사용자에게는 없는 것과 같다. */}
      {axis === "hint" && topWarning && (
        <p className="axis-warn">
          <span className="notice-mark" aria-hidden="true">
            ⚠
          </span>
          {categoryLabel(topWarning.stat)} {formatBytesParts(topWarning.stat.size).value}{" "}
          {formatBytesParts(topWarning.stat.size).unit}
          {"에는 "}
          {topWarning.text}
          {hasContent && (
            <button type="button" className="link-btn" onClick={() => setAxis("content")}>
              내용 기준으로 확인
            </button>
          )}
        </p>
      )}

      {/* 상위 30개 확장자 안에 이 분야가 하나도 없으면 목록이 통째로 비어, 링크를
          누른 사용자는 화면이 그냥 사라진 것만 보게 된다. 이유와 되돌아갈 길을 낸다. */}
      {rows.length === 0 ? (
        <div className="panel-empty">
          <p>
            {filtering
              ? `'${CATEGORY_LABELS[extFilter!] ?? extFilter}' 로 분류된 확장자가 상위 ${formatCount(listedExtCount)}개 목록에 없습니다.`
              : "표시할 확장자가 없습니다."}
          </p>
          <button type="button" className="btn tiny" onClick={() => setExtFilter(null)}>
            전체 보기
          </button>
        </div>
      ) : (
        <>
          <div className="stacked-bar" role="img" aria-label={AXIS_CHART_LABEL[axis]} ref={barRef}>
            {visible.map((c, i) => {
              const width = percent(c.size, basis);
              const size = formatBytesParts(c.size);
              const isLast = i === visible.length - 1 && smallSum === 0;
              const color = categoryColor(c);
              const label = labelOf(c);
              // 6%(=60px)면 '캐시·빌드 산출물'이 '캐시·빌드 산'으로 잘린다. 잘린 라벨은 오독을 만든다.
              const fits = barWidth > 0 && (width / 100) * barWidth >= labelWidthPx(label);
              return (
                <div
                  key={c.key}
                  className="stacked-seg"
                  style={{
                    // 마지막 세그먼트가 반올림 잔여를 흡수한다. 100%를 표방하는 차트는 100%를 채워야 한다.
                    width: `${width}%`,
                    flex: isLast ? "1 1 auto" : undefined,
                    background: color,
                  }}
                  title={`${label} · ${size.value} ${size.unit} (${formatPercent(width)})`}
                >
                  {fits && (
                    <span className="seg-label" style={{ color: readableInk(color) }}>
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
            {smallSum > 0 && (
              // '기타'가 마지막 가시 세그먼트인 경우가 흔해 같은 색이면 하나로 보인다. 무늬로 가른다.
              <div
                className="stacked-seg residual"
                style={{ flex: "1 1 auto" }}
                title={`0.1% 미만 합계 · ${formatBytesParts(smallSum).value} ${formatBytesParts(smallSum).unit}`}
              />
            )}
          </div>

          {/* 예전에는 cat-head 가 role="presentation" 이라, 시각적으로는 '분야/비중/용량/
              파일' 4열 표처럼 보이는데 열 머리글과 셀의 대응이 낭독에 전달되지 않았다.
              TreeView(treegrid)와 달리 이 목록은 펼침·포커스가 없는 정적 표라 role="table"
              로 모델링해, 머리글 행과 각 셀에 role 을 주어 시각·비시각 표현을 일치시킨다.
              (색 점은 TreeView 의 펼침 아이콘과 같이 머리글만 이름을 갖고 본문 셀은
              장식이라 aria-hidden 으로 숨긴다.) */}
          <div className="cat-table" role="table" aria-label={AXIS_CHART_LABEL[axis]}>
            <div className="cat-head" role="row">
              <span className="cat-dot" role="columnheader" aria-label="색" />
              <span className="cat-label" role="columnheader">
                {axis === "ext" ? "확장자" : "분야"}
              </span>
              <span className="cat-pct" role="columnheader">
                비중
              </span>
              {/* 본문과 같은 `1fr 30px` 그리드를 유지해야 머리글과 숫자열의 축이 맞는다. */}
              <span className="cat-size" role="columnheader">
                <span className="num">용량</span>
              </span>
              <span className="cat-files" role="columnheader">
                파일
              </span>
            </div>

            <ul className="cat-list" role="rowgroup">
              {rows.map((c) => {
                // 목록 열은 자릿수를 고정해야 소수점이 세로로 맞는다.
                const size = formatBytesParts(c.size, { fixedDigits: 1 });
                const warning = CATEGORY_WARNINGS[c.key];
                const label = labelOf(c);
                const cross = crossOf(c);
                return (
                  <li key={c.key} className="cat-row" role="row">
                    <span
                      className="cat-dot"
                      role="cell"
                      aria-hidden="true"
                      style={{ background: categoryColor(c) }}
                    />
                    <span className="cat-label" role="cell">
                      <span className="cat-name">{label}</span>
                      {/*
                        바로 위 배너가 같은 내용을 전문으로 이미 냈다면 이 행의 배지는
                        정보를 더하지 않으면서 호버해야만 읽히는 요소로 남는다
                        (설명이 title 에만 있어 터치·키보드 사용자에게는 '주의' 두 글자뿐이다).
                        배너가 다루지 않는 행에서만 배지를 남긴다.
                      */}
                      {warning && !(axis === "hint" && topWarning?.stat.key === c.key) && (
                        <span className="cat-warn" title={warning} aria-label={warning}>
                          주의
                        </span>
                      )}
                      {/* '기타 1.65 GiB 가 미분류'라는 사실만 알고 끝나면 분류표를 개선할
                          길이 없다. 그 덩어리를 분해하는 경로를 행에 노출하되, 이름보다
                          먼저 접히게 해서 행의 1차 식별자를 밀어내지 않는다. */}
                      {cross && (
                        <button
                          type="button"
                          className="link-btn"
                          aria-label={`${label} — ${cross.text}로 보기`}
                          onClick={cross.run}
                        >
                          {cross.text}
                        </button>
                      )}
                    </span>
                    <span className="cat-pct" role="cell" aria-label={`${label} 비중`}>
                      {formatPercent(percent(c.size, basis))}
                    </span>
                    <span className="cat-size" role="cell" aria-label={`${label} 용량`}>
                      <span className="num">{size.value}</span>
                      <span className="unit">{size.unit}</span>
                    </span>
                    <span className="cat-files" role="cell" aria-label={`${label} 파일 수`}>
                      {c.files > 0 ? `${formatCount(c.files)}개` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * 진행 이벤트는 150ms마다 App 상태를 갱신한다. 재스캔 중에는 이전 결과가 그대로
 * 마운트되어 있으므로, memo 가 없으면 이 패널이 초당 6~7회 재조정된다 —
 * 스캔이 가장 무거운 순간에 UI 스레드를 그만큼 뺏는다.
 */
export const CategorySummary = memo(CategorySummaryImpl);
