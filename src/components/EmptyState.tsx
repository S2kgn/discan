interface Props {
  recent: string[];
  onPick: (path: string) => void;
  /** 최근 경로와 이력을 함께 지운다. 공용 PC·화면 공유에서 필요한 수단이다. */
  onClearHistory: () => void;
}

/**
 * 실행 직후 창 아래쪽이 통째로 비어 있으면 무엇이 나올지 알 수 없다.
 * 결과 레이아웃의 고스트를 흐리게 깔아 화면 구성을 미리 알린다.
 */
export function EmptyState({ recent, onPick, onClearHistory }: Props) {
  /*
   * 고스트의 목적은 '무엇이 나올지 미리 알린다'는 것이라, 라벨이 결과와 다른 것을
   * 약속하면 그 목적이 훼손된다. 3·4번 타일은 결과 시점에 지표가 분기한다 —
   * 정리 후보가 없으면 3번은 '폴더', 스캔 경로의 볼륨이 안 잡히면 4번은 '소요'로
   * 바뀐다(ResultHeader). 예고 라벨을 하나로 못 박으면 그 분기에서 어긋나므로,
   * 늘 맞는 1·2번만 라벨을 두고 분기하는 3·4번은 형태(중립 스켈레톤)만 남긴다.
   */
  const labels = ["총 용량", "파일"];
  return (
    <section className="panel empty-state">
      <div className="ghost" aria-hidden="true">
        <div className="ghost-stats">
          {labels.map((label) => (
            <div key={label} className="ghost-stat">
              <span className="ghost-value" />
              <span className="ghost-label">{label}</span>
            </div>
          ))}
          {[0, 1].map((i) => (
            <div key={`skel-${i}`} className="ghost-stat">
              <span className="ghost-value" />
              <span className="ghost-label ghost-label-skeleton" />
            </div>
          ))}
        </div>
        <div className="ghost-bar">
          <span style={{ width: "46%" }} />
          <span style={{ width: "24%" }} />
          <span style={{ width: "16%" }} />
          <span style={{ width: "14%" }} />
        </div>
        <div className="ghost-rows">
          {[92, 74, 58, 41, 30].map((w, i) => (
            <div key={i} className="ghost-row">
              <span className="ghost-name" />
              <span className="ghost-track">
                <span style={{ width: `${w}%` }} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="empty-copy">
        <p className="empty-title">드라이브를 선택하거나 경로를 지정한 뒤 스캔을 시작하십시오.</p>
        <p className="empty-sub">
          파일을 읽어 크기만 셉니다. 아무것도 지우거나 바꾸지 않습니다. C: 전체는 보통 1~3분,
          폴더 하나는 몇 초면 끝납니다.
        </p>
        {recent.length > 0 && (
          <div className="recent">
            <span className="recent-label">최근 스캔</span>
            {recent.map((path) => (
              <button key={path} type="button" className="chip" onClick={() => onPick(path)}>
                {path}
              </button>
            ))}
            <button type="button" className="btn tiny" onClick={onClearHistory}>
              기록 지우기
            </button>
          </div>
        )}
        {/* '무엇을 남기는가'까지 적어야 안심 문구가 성립한다. */}
        <p className="empty-sub">
          스캔한 경로와 총 용량만 이 PC에 저장되며(파일 목록은 저장하지 않습니다), 외부로
          전송하지 않습니다.
        </p>
      </div>
    </section>
  );
}
