import { memo } from "react";
import { CATEGORY_COLORS, CATEGORY_LABELS, LargeFile } from "../types";
import { formatBytesParts, formatPercent, middlePath, percent } from "../lib/format";
import { systemFileNote } from "../lib/system";

interface Props {
  files: LargeFile[];
  totalSize: number;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
}

/**
 * '어느 파일이 큰가'는 이 앱을 켜는 가장 흔한 이유다.
 * 트리는 폴더 단위 판단, 이 패널은 파일 단위 판단을 맡는다.
 */
function LargestFilesImpl({ files, totalSize, onReveal, onCopyPath }: Props) {
  if (files.length === 0) return null;

  return (
    <section className="panel">
      <h2 className="panel-title">가장 큰 파일</h2>
      {/* 세 수치 목록이 같은 우측 정렬 구조를 쓰는데 머리글 유무만 갈리면
          시각적 일관성도, 낭독 시의 열 의미도 함께 사라진다. */}
      <div className="file-head" role="presentation">
        <span className="file-name">이름</span>
        <span className="file-path">경로</span>
        <span className="file-pct">비중</span>
        {/* 본문과 같은 `1fr 30px` 그리드를 유지해야 숫자 축과 34px 어긋나지 않는다. */}
        <span className="file-size">
          <span className="num">용량</span>
        </span>
        <span className="file-actions" />
      </div>
      <ul className="file-list">
        {files.map((f) => {
          // 목록 열은 자릿수를 고정해야 소수점이 세로로 맞는다.
          const size = formatBytesParts(f.size, { fixedDigits: 1 });
          const note = systemFileNote(f.path, f.name);
          const cat = f.category;
          return (
            <li key={f.path} className={`file-row${note ? " system" : ""}`}>
              <span className="file-name" title={f.path}>
                {cat && (
                  <span
                    className="cat-dot"
                    style={{ background: CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.other }}
                    title={CATEGORY_LABELS[cat] ?? cat}
                    aria-label={CATEGORY_LABELS[cat] ?? cat}
                  />
                )}
                {f.name}
                {/* 배지가 없으면 목록 맨 위의 pagefile.sys 가 그냥 '제일 큰 파일'로 읽힌다. */}
                {note && (
                  <span className="file-system-badge" title={note.detail}>
                    {note.label}
                  </span>
                )}
              </span>
              {/* JS 로 앞을 자르고 CSS 가 뒤를 또 자르면 어느 파일인지 알 수 없다.
                  가운데를 생략해 드라이브와 마지막 폴더를 항상 남긴다. */}
              <span className="file-path" title={f.path}>
                {middlePath(f.path, 52)}
              </span>
              <span className="file-pct" aria-label={`${f.name} 비중`}>
                {formatPercent(percent(f.size, totalSize))}
              </span>
              <span className="file-size" aria-label={`${f.name} 용량`}>
                <span className="num">{size.value}</span>
                <span className="unit">{size.unit}</span>
              </span>
              <span className="file-actions">
                {/* 표시 경로가 원본과 다르면 열기는 실패하고 복사본도 열리지 않는다.
                    실패가 예정된 어포던스를 주지 않는다. */}
                {f.lossyPath ? (
                  <span
                    className="row-note"
                    title="이 이름은 표준 문자로 표현할 수 없어 열기·복사를 지원하지 않습니다"
                    aria-label={`${f.name} — 표준 문자로 표현할 수 없는 이름이라 열기·복사를 지원하지 않습니다`}
                  >
                    ⚠
                  </span>
                ) : (
                <>
                {/* 내용이 있으면 title 은 접근 가능한 이름 계산에 쓰이지 않는다.
                    예전에는 최대 20행 × 2개 = 40개의 버튼이 전부 '북동쪽 화살표,
                    버튼'으로 낭독되어 어느 파일의 조작인지 알 수 없었다. */}
                <button
                  type="button"
                  className="row-btn"
                  title="탐색기에서 위치 보기"
                  aria-label={`${f.name} — 탐색기에서 위치 보기`}
                  onClick={() => onReveal(f.path)}
                >
                  <span aria-hidden="true">↗</span>
                </button>
                <button
                  type="button"
                  className="row-btn"
                  title="경로 복사"
                  aria-label={`${f.name} — 경로 복사`}
                  onClick={() => onCopyPath(f.path)}
                >
                  <span aria-hidden="true">⧉</span>
                </button>
                </>
                )}
              </span>
              {note && <span className="file-note">{note.detail}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 재스캔 중 진행 이벤트(150ms)마다 최대 20행을 다시 만들 이유가 없다. */
export const LargestFiles = memo(LargestFilesImpl);
