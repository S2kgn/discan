import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

import { CommandError, ScanProgress, ScanResult, toCommandError } from "../types";

/**
 * 스캔 수명주기 하나만 담는 훅.
 *
 * 예전에는 App 한 함수가 드라이브 열거·스캔 수명주기·이력 저장·내보내기 팝오버·오류
 * 표시·결과 머리까지 모두 담았다. useState 20개와 useRef 8개가 한 스코프에 있으니
 * `startScan` 이 읽는 상태가 매 렌더 달라져 useCallback 으로 고정할 수 없었고, 자식
 * 패널의 memo 를 살리려고 `startScanRef` 우회를 썼다 — 그 우회가 필요했다는 사실
 * 자체가 관심사 분리의 신호였다.
 *
 * 콜백을 ref 에 담아 두면 훅이 돌려주는 startScan/cancelScan 은 영구히 안정 참조가
 * 되고, 취소 네 갈래(수락·기각·throw·구버전 null)를 App 렌더 없이 검증할 수 있다.
 */
export interface UseScanCallbacks {
  /** 스캔 시작 직후. 대상 경로를 함께 넘긴다. */
  onStart?: (path: string) => void;
  /** 결과 도착. 이력·최근 경로·포커스처럼 App 이 아는 후처리는 여기서 한다. */
  onResult?: (path: string, result: ScanResult) => void;
  onError?: (error: CommandError) => void;
  /** 사용자에게 알릴 일(취소 기각 등). 토스트 채널은 App 이 가진다. */
  onNotify?: (message: string, tone: "info" | "error") => void;
  /** 낭독 전용 상태 고지(토스트를 띄우지 않는다). */
  onAnnounce?: (message: string) => void;
  /** 1초마다. 낭독 요약 주기는 호출자가 정한다(150ms 진행 이벤트와 분리). */
  onTick?: (elapsedMs: number, progress: ScanProgress | null) => void;
}

export interface ScanController {
  scanning: boolean;
  cancelling: boolean;
  progress: ScanProgress | null;
  result: ScanResult | null;
  elapsed: number;
  /** 스캔을 시작한다. 이미 진행 중이면 아무 일도 하지 않는다. */
  startScan: (path: string) => Promise<void>;
  cancelScan: () => Promise<void>;
}

export function useScan(callbacks: UseScanCallbacks = {}): ScanController {
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const startedAtRef = useRef<number>(0);
  // 라이브 리전 갱신은 렌더 주기와 무관하게 돌아야 해서 최신 진행값을 따로 들고 있는다.
  const progressRef = useRef<ScanProgress | null>(null);
  // 백엔드 cancel_scan 은 세대를 지목할 수 있다. 진행 이벤트에서 받은 값을 넘겨야 그 방어가 산다.
  const scanIdRef = useRef<number | null>(null);
  // 재진입 방어는 상태가 아니라 ref 로 본다 — setScanning 은 다음 렌더에나 반영된다.
  const runningRef = useRef(false);
  const cancellingRef = useRef(false);

  // 콜백은 매 렌더 새로 만들어져도 상관없다. 최신 것만 ref 로 따라간다.
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

  useEffect(() => {
    if (!scanning) return;
    const id = window.setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(ms);
      cbRef.current.onTick?.(ms, progressRef.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, [scanning]);

  const startScan = useCallback(async (path: string) => {
    if (!path || runningRef.current) return;
    runningRef.current = true;

    scanIdRef.current = null;
    progressRef.current = { files: 0, dirs: 0, bytes: 0, errors: 0 };
    setProgress({ files: 0, dirs: 0, bytes: 0, errors: 0 });
    setElapsed(0);
    cancellingRef.current = false;
    setCancelling(false);
    startedAtRef.current = Date.now();
    setScanning(true);
    cbRef.current.onStart?.(path);

    unlistenRef.current = await listen<ScanProgress>("scan-progress", (e) => {
      const payload = e.payload;
      /*
       * 세대는 단조 증가한다. '가장 먼저 본 scanId 에 고정'하면 직전 스캔의 잔여
       * 이벤트(송신 스레드가 done 확인 뒤 잠든 사이에 한 번 더 방출한다)를 먼저 받은
       * 리스너가 옛 세대에 잠겨 버린다. 그러면 새 스캔의 진행이 전부 폐기되고,
       * cancelScan 이 옛 세대를 지목해 중단까지 기각된다. 큰 세대로 갱신하고 작은
       * 세대는 버리는 규칙이면 어느 순서로 도착해도 최신 스캔이 이긴다.
       */
      if (payload.scanId !== undefined) {
        const seen = scanIdRef.current;
        if (seen !== null && payload.scanId < seen) return;
        scanIdRef.current = payload.scanId;
      }
      progressRef.current = payload;
      setProgress(payload);
    });

    try {
      const res = await invoke<ScanResult>("start_scan", { path });
      if (res.scanId !== undefined) scanIdRef.current = res.scanId;
      // 이전 결과는 새 결과가 도착한 뒤에 교체한다. 레이아웃이 튀지 않아야 비교가 된다.
      setResult(res);
      cbRef.current.onResult?.(path, res);
    } catch (e) {
      cbRef.current.onError?.(toCommandError(e));
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      runningRef.current = false;
      cancellingRef.current = false;
      setScanning(false);
      setCancelling(false);
    }
  }, []);

  const cancelScan = useCallback(async () => {
    // 연타로 같은 요청을 두 번 보내지 않는다. 상태는 다음 렌더에나 반영되므로 ref 로 본다.
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    // 취소는 워커가 다음 디렉터리에 진입할 때 반영된다. 그 공백을 UI가 먼저 설명한다.
    setCancelling(true);
    cbRef.current.onAnnounce?.("중단을 요청했습니다.");
    // 세대를 지목하면 '이전 스캔 종료 → 새 스캔 시작' 사이에 끼어든 취소가 새 스캔을 죽이지 않는다.
    const scanId = scanIdRef.current;
    try {
      const accepted = await invoke<boolean | null>(
        "cancel_scan",
        scanId !== null ? { scanId } : {},
      );
      /*
       * 취소가 기각됐는데도 '중단 중…'으로 굳어 있으면 사용자는 앱이 죽었다고 본다.
       * (구버전 백엔드는 () 를 반환해 null 이 온다 — 그때는 판정할 근거가 없으므로
       *  기존 동작대로 요청이 받아들여진 것으로 둔다.)
       */
      if (accepted === false) {
        cancellingRef.current = false;
        setCancelling(false);
        cbRef.current.onNotify?.("중단 요청이 반영되지 않았습니다 — 이미 끝난 스캔입니다.", "error");
      }
    } catch {
      cancellingRef.current = false;
      setCancelling(false);
      cbRef.current.onNotify?.("중단 요청을 보내지 못했습니다. 다시 눌러 주십시오.", "error");
    }
  }, []);

  return { scanning, cancelling, progress, result, elapsed, startScan, cancelScan };
}
