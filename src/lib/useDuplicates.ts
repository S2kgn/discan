import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

import { CommandError, DupeProgress, DupeResult, toCommandError } from "../types";

/**
 * 중복 찾기 수명주기 훅. useScan 과 같은 모양이되 세대는 두지 않는다 —
 * 완료 직후 재시작 경합이 스캔만큼 잦지 않고, 백엔드 `running` 플래그가 동시 실행을
 * 막는다. 취소는 현재 진행 객체에 직접 선다.
 */
export interface UseDuplicatesCallbacks {
  onError?: (error: CommandError) => void;
  onNotify?: (message: string, tone: "info" | "error") => void;
}

export interface DuplicatesController {
  running: boolean;
  cancelling: boolean;
  progress: DupeProgress | null;
  result: DupeResult | null;
  find: (path: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** 삭제 후 결과에서 사라진 경로를 반영한다(다시 스캔하지 않고 화면만 갱신). */
  applyDeleted: (deletedPaths: string[]) => void;
  reset: () => void;
}

const EMPTY: DupeProgress = { scanned: 0, hashed: 0, bytes: 0, groups: 0, errors: 0, phase: "scanning" };

export function useDuplicates(callbacks: UseDuplicatesCallbacks = {}): DuplicatesController {
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<DupeProgress | null>(null);
  const [result, setResult] = useState<DupeResult | null>(null);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const runningRef = useRef(false);
  const cancellingRef = useRef(false);
  const cbRef = useRef(callbacks);
  useEffect(() => {
    cbRef.current = callbacks;
  });

  useEffect(
    () => () => {
      unlistenRef.current?.();
    },
    [],
  );

  const find = useCallback(async (path: string) => {
    if (!path || runningRef.current) return;
    runningRef.current = true;
    setProgress({ ...EMPTY });
    setResult(null);
    cancellingRef.current = false;
    setCancelling(false);
    setRunning(true);

    unlistenRef.current = await listen<DupeProgress>("dupe-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const res = await invoke<DupeResult>("find_duplicates", { path });
      setResult(res);
    } catch (e) {
      cbRef.current.onError?.(toCommandError(e));
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      runningRef.current = false;
      cancellingRef.current = false;
      setRunning(false);
      setCancelling(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    try {
      const accepted = await invoke<boolean>("cancel_duplicates");
      if (accepted === false) {
        cancellingRef.current = false;
        setCancelling(false);
        cbRef.current.onNotify?.("중단 요청이 반영되지 않았습니다 — 이미 끝난 작업입니다.", "error");
      }
    } catch {
      cancellingRef.current = false;
      setCancelling(false);
      cbRef.current.onNotify?.("중단 요청을 보내지 못했습니다.", "error");
    }
  }, []);

  const applyDeleted = useCallback((deletedPaths: string[]) => {
    if (deletedPaths.length === 0) return;
    const gone = new Set(deletedPaths);
    setResult((prev) => {
      if (!prev) return prev;
      const groups = prev.groups
        .map((g) => {
          const paths = g.paths.filter((p) => !gone.has(p));
          // 하나만 남으면 더 이상 중복이 아니다.
          if (paths.length < 2) return null;
          const count = paths.length;
          return { ...g, paths, count, reclaimable: g.size * (count - 1) };
        })
        .filter((g): g is (typeof prev.groups)[number] => g !== null);
      const totalReclaimable = groups.reduce((s, g) => s + g.reclaimable, 0);
      return { ...prev, groups, totalGroups: groups.length, totalReclaimable };
    });
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setProgress(null);
  }, []);

  return { running, cancelling, progress, result, find, cancel, applyDeleted, reset };
}
