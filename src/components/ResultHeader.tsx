import { memo } from "react";

import { ScanResult } from "../types";
import { Comparison } from "../lib/history";
import { Coverage, ErrorBreakdown, FAILED_KIND_HINTS, FAILED_KIND_LABELS, describeErrors } from "../lib/notice";
import { formatBytes, formatBytesParts, formatCount, formatDuration, middlePath, percent } from "../lib/format";

interface Props {
  result: ScanResult;
  /** 총 용량이 하한값인지(취소·읽기 실패). ≥ 표식의 근거다. */
  lowerBound: boolean;
  /** 총 용량 타일 각주. 값의 해석을 바꾸지 않는 갈래는 null 로 와서 그려지지 않는다. */
  footnote: string | null;
  delta: Comparison;
  /** 스캔 대상이 속한 볼륨. 4번 타일의 여유 공간 근거다. */
  scannedDrive: { path: string; total: number; free: number } | null;
  /** 정리 후보 합계. 0보다 크면 3번 타일이 폴더 수 대신 이 값을 낸다. */
  tipsTotal: number;
  tipsLowerBound: boolean;
  errorBreakdown: ErrorBreakdown | null;
  coverage: Coverage | null;
  linkLine: string | null;
  cloudLine: string | null;
  conditions: string[];
  conditionsSummaryText: string;
  /** 실패 경로 미리보기 상한. App 이 정한 값을 그대로 받는다. */
  failedPreview: number;
}

/**
 * 결과 머리 — 지표 타일·경고·집계 조건.
 *
 * App 한 함수가 이 JSX 까지 들고 있으면 스캔 수명주기와 표시 규칙이 같은 스코프에
 * 섞여, 어느 상태가 어느 화면을 만드는지 읽는 데 파일 전체가 필요했다. 여기로
 * 떼어 내면 이 대역의 표시 규칙만 따로 읽고 고칠 수 있다.
 */
function ResultHeaderImpl({
  result,
  lowerBound,
  footnote,
  delta,
  scannedDrive,
  tipsTotal,
  tipsLowerBound,
  errorBreakdown,
  coverage,
  linkLine,
  cloudLine,
  conditions,
  conditionsSummaryText,
  failedPreview: FAILED_PREVIEW,
}: Props) {
  const totalParts = formatBytesParts(result.totalSize);
  return (
    <>
      <section className="stat-row">
        <div className="stat">
          {/* GiB 설명은 펼친 대상 패널에만 있어 결과 화면에서는 사라졌다. 1차 지표
              타일에 상시 툴팁으로 붙여 '이 숫자가 탐색기의 GB와 같은 값'임을 남긴다. */}
          <span
            className="stat-value"
            title="GiB = 탐색기가 'GB'로 적는 값과 같은 계산입니다 (1 GiB = 1024 MiB)."
          >
            <span className="num">
              {lowerBound && "≥ "}
              {totalParts.value}
            </span>
            <span className="unit">{totalParts.unit}</span>
          </span>
          <span className="stat-label">총 용량</span>
          {/* 값의 해석을 바꾸는 단서만 여기 남긴다. 스캔마다 변하지 않는 조건
              ('클러스터 크기 미상', '점유가 거의 같음')은 접히는 집계 조건으로
              내려, 첫 화면에서 같은 가중치의 회색 줄이 서로를 가리지 않게 한다. */}
          {footnote && <span className="stat-foot">{footnote}</span>}
          {delta.text && (
            <span className={`stat-delta ${delta.direction}`}>{delta.text}</span>
          )}
        </div>
        <div className="stat">
          <span className="stat-value no-unit">
            <span className="num">{formatCount(result.totalFiles)}</span>
          </span>
          <span className="stat-label">파일</span>
        </div>
        {/* 디스크가 꽉 차서 앱을 켠 사람에게 '폴더 11,261'은 어떤 행동으로도
            이어지지 않는다. 행동으로 이어지는 값이 있으면 그것을 대신 낸다
            (폴더 수는 접히는 집계 조건에 남긴다). */}
        {tipsTotal > 0 ? (
          <div className="stat">
            <span className="stat-value">
              <span className="num">
                {tipsLowerBound && "≥ "}
                {formatBytesParts(tipsTotal).value}
              </span>
              <span className="unit">{formatBytesParts(tipsTotal).unit}</span>
            </span>
            <span className="stat-label">정리 후보</span>
          </div>
        ) : (
          <div className="stat">
            <span className="stat-value no-unit">
              <span className="num">{formatCount(result.totalDirs)}</span>
            </span>
            <span className="stat-label">폴더</span>
          </div>
        )}
        {/* '소요 — 1초 미만'은 의사결정 기여도가 0에 가깝다. 네 칸 중 하나를
            이 앱을 켠 이유에 답하는 값으로 바꾸고, 소요 시간은 대상 줄로 내렸다. */}
        {scannedDrive && scannedDrive.total > 0 ? (
          <div className="stat">
            <span className="stat-value">
              <span className="num">{formatBytesParts(scannedDrive.free).value}</span>
              <span className="unit">{formatBytesParts(scannedDrive.free).unit}</span>
            </span>
            <span className="stat-label">
              {scannedDrive.path.replace(/\\$/, "")} 여유 공간
            </span>
            <span className="stat-foot">
              전체 {formatBytes(scannedDrive.total)} 중{" "}
              {Math.round(percent(scannedDrive.total - scannedDrive.free, scannedDrive.total))}%
              사용 중입니다.
            </span>
          </div>
        ) : (
          <div className="stat">
            <span className="stat-value no-unit">
              <span className="num">{formatDuration(result.elapsedMs)}</span>
            </span>
            <span className="stat-label">소요</span>
          </div>
        )}
      </section>

      {/* 실제 경고(부분 집계·읽기 실패)만 amber 박스에 남긴다. */}
      {(result.cancelled || errorBreakdown || coverage?.tone === "warn") && (
        <div className="notice" role="status">
          {result.cancelled && (
            <p>
              <span className="notice-mark" aria-hidden="true">
                ⚠
              </span>
              사용자 중단으로 부분 집계된 결과입니다 — 실제 용량은 이보다 큽니다.
            </p>
          )}
          {coverage?.tone === "warn" && (
            <p>
              <span className="notice-mark" aria-hidden="true">
                ⚠
              </span>
              {coverage.text}
            </p>
          )}
          {errorBreakdown && (
            <>
              <p>
                <span className="notice-mark" aria-hidden="true">
                  ⚠
                </span>
                {describeErrors(errorBreakdown)}
                {errorBreakdown.suggestElevation &&
                  " 권한으로 막힌 항목은 관리자 권한으로 다시 실행하면 보입니다."}
              </p>
              {(result.failedPaths?.length ?? 0) > 0 && (
                <details className="failed-details">
                  <summary>읽지 못한 경로 보기</summary>
                  <ul className="failed-list">
                    {/* 백엔드는 엔트리 순회 실패를 '실패한 항목'이 아니라 부모
                        디렉터리 경로로 기록한다. 한 디렉터리에서 오류가 여러 번
                        나면 같은 path 가 여러 줄 들어와 key 가 중복된다. */}
                    {result.failedPaths!.slice(0, FAILED_PREVIEW).map((f, i) => (
                      <li key={`${f.path}|${f.kind}|${i}`}>
                        <span className={`failed-kind ${f.kind}`}>
                          {FAILED_KIND_LABELS[f.kind] ?? f.kind}
                        </span>
                        <span className="failed-path" title={f.path}>
                          {middlePath(f.path, 64)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="failed-foot">
                    {(result.failedPaths?.length ?? 0) > FAILED_PREVIEW &&
                      `상위 ${FAILED_PREVIEW}건만 표시했습니다 — 전체는 JSON 내보내기에 있습니다. `}
                    {/* 잘린 목록을 전량으로 오인하면 감사 결론이 뒤집힌다. */}
                    {result.failedPathsTruncated &&
                      `실패 ${formatCount(result.failedPathsTotal ?? result.errors)}건 중 ${formatCount(result.failedPaths?.length ?? 0)}건만 기록되었습니다. `}
                    {Object.entries(errorBreakdown.counts)
                      .filter(([, n]) => n > 0)
                      .map(([k]) => FAILED_KIND_HINTS[k as keyof typeof FAILED_KIND_HINTS])
                      .join(" ")}
                  </p>
                </details>
              )}
            </>
          )}
          {(result.dirErrors ?? 0) > 0 && (
            <p className="notice-sub">
              이 중 폴더 단위 실패가 {formatCount(result.dirErrors ?? 0)}건입니다 — 그만큼의
              하위 트리가 통째로 빠졌습니다.
            </p>
          )}
        </div>
      )}

      {/* 커버리지 요약·제외 규칙·가지치기 기준은 중립 정보다. 늘 접근할 수 있어야
          하지만, 11px 회색 네 줄이 결과 첫 화면의 세로 대역을 상시 점유하면
          정작 실행 가능한 카드가 스크롤 아래로 밀린다. 요약 한 줄만 내놓는다. */}
      <details className="conditions">
        <summary>{conditionsSummaryText}</summary>
        <div className="conditions-body">
          {coverage?.tone === "info" && (
            <p>
              <span className="notice-mark" aria-hidden="true">
                ⓘ
              </span>
              {coverage.text}
            </p>
          )}
          {linkLine && <p>{linkLine}</p>}
          {cloudLine && <p>{cloudLine}</p>}
          {/* 지표 타일에서 내려온 개수. 사라지면 '무엇이 11,261개인가'를
              확인할 길이 없어지므로 자리를 옮기되 지우지는 않는다. */}
          <p>
            파일 {formatCount(result.totalFiles)}개 · 폴더{" "}
            {formatCount(result.totalDirs)}개를 셌습니다.
          </p>
          {conditions.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </details>
    </>
  );
}

/** 진행 이벤트(150ms)마다 이 대역까지 재조정할 이유는 없다. */
export const ResultHeader = memo(ResultHeaderImpl);
