import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DeleteResult } from "../types";
import { useDuplicates } from "../lib/useDuplicates";
import { autoSelect, groupsFullySelected, selectionStats } from "../lib/dupeSelection";
import { formatBytes, formatCount, middlePath } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  /** 스캔한 경로. 이 안에서만 중복을 찾는다. */
  scannedPath: string;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onNotify: (message: string, tone: "info" | "error") => void;
}

/**
 * 중복 파일 패널.
 *
 * 스캔과 별개의 비싼 작업(내용 해시)이라 버튼으로만 시작한다. 결과는 그룹별로 묶고,
 * 기본으로 그룹마다 하나만 남기고 나머지를 선택해 준다 — 사용자는 조정만 하면 된다.
 * 삭제는 휴지통으로만 보내며(복원 가능), 실행 전 목록·총용량을 모달로 재확인시킨다.
 */
export function Duplicates({ scannedPath, onReveal, onCopyPath, onNotify }: Props) {
  const dupes = useDuplicates({ onNotify, onError: (e) => onNotify(e.message || "중복 찾기에 실패했습니다.", "error") });
  const { running, cancelling, progress, result } = dupes;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 새 결과가 오면 기본 선택(그룹마다 하나만 남김)으로 초기화.
  useEffect(() => {
    if (result) setSelected(autoSelect(result.groups));
    else setSelected(new Set());
  }, [result]);

  const stats = useMemo(
    () => (result ? selectionStats(result.groups, selected) : { count: 0, bytes: 0 }),
    [result, selected],
  );
  const unsafeGroups = useMemo(
    () => (result ? groupsFullySelected(result.groups, selected) : []),
    [result, selected],
  );

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  async function runDelete() {
    if (!result) return;
    setConfirmOpen(false);
    setDeleting(true);
    const paths = [...selected];
    try {
      const res = await invoke<DeleteResult>("delete_to_trash", { paths });
      dupes.applyDeleted(res.deleted);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of res.deleted) next.delete(p);
        return next;
      });
      const freed = res.deleted.length;
      if (res.failed.length === 0) {
        onNotify(`${formatCount(freed)}개 항목을 휴지통으로 보냈습니다.`, "info");
      } else {
        onNotify(
          `${formatCount(freed)}개는 휴지통으로, ${formatCount(res.failed.length)}개는 실패했습니다(사용 중이거나 권한 문제).`,
          "error",
        );
      }
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      onNotify(`삭제하지 못했습니다: ${msg}`, "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">중복 파일</h2>
        {!running && (
          <button
            type="button"
            className="btn tiny"
            onClick={() => void dupes.find(scannedPath)}
            disabled={!scannedPath || deleting}
          >
            {result ? "다시 찾기" : "중복 찾기"}
          </button>
        )}
        {running && (
          <button type="button" className="btn tiny danger" onClick={() => void dupes.cancel()} disabled={cancelling}>
            {cancelling ? "중단 중…" : "중단"}
          </button>
        )}
      </div>

      {!result && !running && (
        <p className="panel-empty">
          내용이 완전히 같은 파일을 찾아 회수 가능한 용량을 알려 줍니다. 크기가 같은 파일만
          해시하므로 스캔보다 오래 걸릴 수 있습니다. {formatBytes(64 * 1024)} 미만 파일은
          제외합니다.
        </p>
      )}

      {running && progress && (
        <div className="dupe-progress">
          <div className="progress-spinner" />
          <span>
            {progress.phase === "scanning"
              ? `크기 수집 중 — ${formatCount(progress.scanned)}개 파일 확인`
              : `내용 대조 중 — ${formatCount(progress.hashed)}개 해시 · ${formatBytes(progress.bytes)} 읽음 · 중복 ${formatCount(progress.groups)}그룹`}
            {progress.errors > 0 && ` · 접근 불가 ${formatCount(progress.errors)}건`}
          </span>
        </div>
      )}

      {result && !running && (
        <>
          {result.groups.length === 0 ? (
            <p className="panel-empty">
              {result.cancelled
                ? "중단되어 중복을 다 찾지 못했습니다."
                : `중복 파일이 없습니다 (파일 ${formatCount(result.filesScanned)}개 확인, ${formatBytes(result.minBytes)} 이상 대상).`}
            </p>
          ) : (
            <>
              <div className="dupe-summary">
                <span>
                  <strong>{formatCount(result.totalGroups)}</strong>개 중복 그룹 · 최대{" "}
                  <strong>{formatBytes(result.totalReclaimable)}</strong> 회수 가능
                </span>
                {result.truncated && (
                  <span className="dupe-trunc">회수 큰 순 상위만 표시했습니다.</span>
                )}
              </div>

              <div className="dupe-tools">
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => setSelected(autoSelect(result.groups))}
                >
                  그룹마다 하나만 남기고 선택
                </button>
                <button type="button" className="btn tiny" onClick={() => setSelected(new Set())}>
                  전체 해제
                </button>
              </div>

              {unsafeGroups.length > 0 && (
                <p className="dupe-warn">
                  <span className="notice-mark" aria-hidden="true">⚠</span>
                  {formatCount(unsafeGroups.length)}개 그룹은 사본을 전부 선택했습니다 — 그러면 그
                  파일이 통째로 사라집니다. 각 그룹에서 하나는 남겨 주십시오.
                </p>
              )}

              <ul className="dupe-groups">
                {result.groups.map((g) => (
                  <li key={g.paths[0]} className="dupe-group">
                    <div className="dupe-group-head">
                      파일당 {formatBytes(g.size)} · {formatCount(g.count)}개 · 회수{" "}
                      {formatBytes(g.reclaimable)}
                    </div>
                    <ul className="dupe-files">
                      {g.paths.map((p) => (
                        <li key={p} className="dupe-file">
                          <label className="dupe-check">
                            <input
                              type="checkbox"
                              checked={selected.has(p)}
                              onChange={() => toggle(p)}
                            />
                            <span className="dupe-path" title={p}>
                              {middlePath(p, 60)}
                            </span>
                          </label>
                          <span className="dupe-file-actions">
                            <button
                              type="button"
                              className="row-btn"
                              title="탐색기에서 위치 보기"
                              aria-label={`${p} — 탐색기에서 위치 보기`}
                              onClick={() => onReveal(p)}
                            >
                              <span aria-hidden="true">↗</span>
                            </button>
                            <button
                              type="button"
                              className="row-btn"
                              title="경로 복사"
                              aria-label={`${p} — 경로 복사`}
                              onClick={() => onCopyPath(p)}
                            >
                              <span aria-hidden="true">⧉</span>
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>

              <div className="dupe-action">
                <button
                  type="button"
                  className="btn danger-solid"
                  disabled={stats.count === 0 || unsafeGroups.length > 0 || deleting}
                  onClick={() => setConfirmOpen(true)}
                >
                  {deleting
                    ? "휴지통으로 보내는 중…"
                    : `선택 ${formatCount(stats.count)}개 휴지통으로 (${formatBytes(stats.bytes)} 회수)`}
                </button>
              </div>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="휴지통으로 보내기"
        confirmLabel={`${formatCount(stats.count)}개 휴지통으로`}
        danger
        onConfirm={() => void runDelete()}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          선택한 <strong>{formatCount(stats.count)}개</strong> 파일을 <strong>휴지통</strong>으로
          보냅니다 — 약 {formatBytes(stats.bytes)}가 회수됩니다.
        </p>
        <p className="modal-note">
          영구 삭제가 아닙니다. 잘못 보냈으면 Windows 휴지통에서 복원할 수 있습니다.
        </p>
      </ConfirmDialog>
    </section>
  );
}
