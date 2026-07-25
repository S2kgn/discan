import { ReactNode, useEffect, useRef } from "react";

interface Props {
  open: boolean;
  title: string;
  /** 본문. 삭제 대상 목록·총용량 등 결정에 필요한 사실을 담는다. */
  children: ReactNode;
  confirmLabel: string;
  /** 확인이 파괴적 동작이면 빨간 톤으로. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 인앱 확인 모달.
 *
 * OS 네이티브 대화상자(dialog 플러그인 ask) 대신 인앱 모달을 쓰는 이유: 삭제 대상
 * 목록·총용량 같은 결정 근거를 그대로 보여 줘야 하는데 네이티브 ask 는 한 줄 문구만
 * 담는다. 되돌리기 어려운 동작일수록 무엇을 하는지 눈으로 확인시켜야 한다.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 모달을 연 트리거. 닫을 때 여기로 포커스를 되돌린다(안 되돌리면 body 로 떨어진다).
  const restoreRef = useRef<HTMLElement | null>(null);
  // onCancel 은 부모에서 매 렌더 새로 만들어지므로 effect 의존성에 넣으면 열려 있는
  // 동안 effect 가 계속 재실행돼 포커스가 튄다. 최신 값을 ref 로만 읽어 의존성을
  // [open] 하나로 유지한다.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    if (!open) return;
    // 열기 직전 포커스를 기억해 두고(대개 모달을 연 버튼), 확인 버튼으로 옮긴다.
    // 파괴적 동작은 취소가 기본이 낫다는 의견도 있어 '확인'에 두되, danger 는 본문에
    // 한 번 더 시선을 요구하는 문구를 둔다.
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    confirmRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancelRef.current();
        return;
      }
      // Tab 을 모달 안에 가둔다. 트랩이 없으면 초점이 배경(드라이브 카드·내보내기
      // 메뉴 등 여전히 접근성 트리에 있는 요소)으로 새어, 파괴적 모달이 열린 채
      // 뒤쪽을 조작할 수 있다. aria-modal 은 보조기술만 제약하지 키보드는 못 막는다.
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // 닫힐 때 트리거로 초점 복원. 트리거가 그새 사라졌거나 비활성이면 focus()가
      // 조용히 실패할 뿐이라(현행과 동일) 안전하다.
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onPointerDown={() => onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        // 백드롭 클릭만 취소로 삼고, 모달 안 클릭은 삼키지 않도록 전파를 막는다.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            취소
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`btn ${danger ? "danger-solid" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
