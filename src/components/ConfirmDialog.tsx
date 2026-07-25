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

  useEffect(() => {
    if (!open) return;
    // 열릴 때 확인 버튼에 포커스 — 다만 파괴적 동작은 실수 방지를 위해 취소가 기본이
    // 낫다는 의견도 있어, 여기서는 '확인'에 두되 Enter 오발을 막게 danger 는 한 번 더
    // 시선을 요구하는 문구를 본문에 둔다.
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onPointerDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
