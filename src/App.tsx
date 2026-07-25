import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { CategorySummary } from "./components/CategorySummary";
import { CleanupTips } from "./components/CleanupTips";
import { Duplicates } from "./components/Duplicates";
import { EmptyState } from "./components/EmptyState";
import { LargestFiles } from "./components/LargestFiles";
import { ResultHeader } from "./components/ResultHeader";
import { Treemap } from "./components/Treemap";
import { TreeView } from "./components/TreeView";
import {
  CommandError,
  DriveInfo,
  categoryLabel,
  driveBlockedReason,
  toCommandError,
} from "./types";
import { cleanupTips } from "./lib/cleanup";
import { collectFileNodes } from "./lib/tree";
import { applyFolderExclusions } from "./lib/exclude";
import {
  ExportOptions,
  buildCategoryCsv,
  buildExtensionCsv,
  buildFailedPathsCsv,
  buildHistoryCsv,
  buildJson,
  buildTreeCsv,
  copyText,
  downloadText,
  exportDisclosure,
  timestampSlug,
} from "./lib/export";
import { errorAction, errorDetail, friendlyError, isBenignError } from "./lib/errors";
import {
  basisLines,
  describeErrors,
  breakdownErrors,
  conditionsSummary,
  describeCoverage,
  describeSkippedCloud,
  describeSkippedLinks,
  totalFootnote,
} from "./lib/notice";
import { revealInExplorer } from "./lib/reveal";
import { useScan } from "./lib/useScan";
import {
  Comparison,
  History,
  RECENT_KEY,
  clearStoredPaths,
  compareMessage,
  readHistory,
  writeHistory,
} from "./lib/history";
import {
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  middlePath,
} from "./lib/format";
import "./App.css";

const RECENT_MAX = 3;
/** 정보 토스트의 표시 시간. 오류 톤은 이 타이머를 쓰지 않는다. */
const TOAST_MS = 3500;
/** 실패 경로는 감사용이라 전부 필요하지 않다. 상위 몇 건이면 어디가 빠졌는지 감이 온다. */
const FAILED_PREVIEW = 20;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 처음 켰을 때 고를 드라이브.
 *
 * 목록의 첫 항목을 쓰면 카드 리더가 A: 로 잡힌 PC에서 엉뚱한 드라이브가 선택된다.
 * 이 앱을 켠 이유는 공간이 모자라서이므로, 스캔 가능한 고정 디스크 중 사용률이
 * 가장 높은 것을 짚어 준다.
 */
export function pickDefaultDrive(drives: DriveInfo[]): string | null {
  const usable = drives.filter((d) => driveBlockedReason(d) === null);
  if (usable.length === 0) return drives[0]?.path ?? null;
  const fixed = usable.filter((d) => d.driveType === undefined || d.driveType === "fixed");
  const pool = fixed.length > 0 ? fixed : usable;
  return pool.reduce((best, d) =>
    (d.total - d.free) / d.total > (best.total - best.free) / best.total ? d : best,
  ).path;
}

function App() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [drivesLoading, setDrivesLoading] = useState(true);
  const [target, setTarget] = useState<string>("");
  const [scannedPath, setScannedPath] = useState<string>("");
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  // 오류는 객체 그대로 들고 있는다. String(e) 로 받으면 백엔드가 코드로 나눠 보낸
  // 갈래가 전부 "[object Object]" 한 문장으로 뭉개진다.
  const [error, setError] = useState<CommandError | null>(null);
  const [toast, setToast] = useState<string>("");
  const [toastTone, setToastTone] = useState<"info" | "error">("info");
  // 오류 톤 토스트는 후속 행동을 요구하는 문장이라 자동 해제하지 않는다(WCAG 2.2.1).
  const [toastSticky, setToastSticky] = useState(false);
  // 낭독 채널은 하나로 모은다(토스트에도 aria-live 를 걸면 같은 문장을 두 번 읽는다).
  const [live, setLive] = useState("");
  const [alertLive, setAlertLive] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [history, setHistory] = useState<History>(() => readHistory());
  const [delta, setDelta] = useState<Comparison>({ text: "", direction: "unknown" });
  // 정리 후보 카드에서 '나머지 79곳'으로 넘어갈 때 트리 검색어를 채워 준다.
  const [treeQuery, setTreeQuery] = useState("");
  // 결과가 나온 뒤에도 설정 패널이 창의 40%를 먹지 않도록 한 줄로 접는다.
  const [targetOpen, setTargetOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSerial, setExportSerial] = useState(false);
  const [exportAnonymize, setExportAnonymize] = useState(false);
  // 용량 계산에서 뺀 폴더·파일 경로와 분야 키. 새 스캔이 오면 비운다(아래 useEffect).
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(() => new Set());
  const [excludedCats, setExcludedCats] = useState<Set<string>>(() => new Set());

  const toastTimerRef = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const refreshDrives = useCallback(async (selectDefault: boolean) => {
    setDrivesLoading(true);
    try {
      const list = await invoke<DriveInfo[]>("list_drives");
      setDrives(list);
      if (selectDefault && list.length > 0) {
        const pick = pickDefaultDrive(list);
        if (pick) setTarget((prev) => prev || pick);
      }
    } catch (e) {
      setError(toCommandError(e));
    } finally {
      setDrivesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDrives(true);
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [refreshDrives]);

  /**
   * 토스트는 시각 채널만 담당하고, 낭독은 sr-only 리전 하나가 전담한다.
   * 두 채널을 모두 켜 두면 같은 문장을 두 번 읽고, alert 와 polite 가 섞여
   * 낭독 순서까지 불안정해진다. 톤 구분은 리전을 둘로 나눠 유지한다.
   *
   * 오류 톤은 자동으로 지우지 않는다 — '탐색기를 열 수 없어 경로를 복사했습니다'
   * 처럼 후속 행동을 요구하는 문장이 읽기도 전에 사라지고 다시 불러올 방법이 없으면,
   * 자동으로 사라지는 콘텐츠에 연장·해제 수단을 요구하는 WCAG 2.2.1 에 어긋난다.
   */
  function notify(message: string, tone: "info" | "error" = "info") {
    setToast(message);
    setToastTone(tone);
    setToastSticky(tone === "error");
    if (tone === "error") setAlertLive(message);
    else setLive(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    if (tone !== "error") {
      toastTimerRef.current = window.setTimeout(() => setToast(""), TOAST_MS);
    }
  }

  /** 읽는 중에 사라지지 않도록 호버·포커스 동안 타이머를 멈춘다. */
  function holdToast() {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
  }

  function resumeToast() {
    if (toastSticky || !toast) return;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), TOAST_MS);
  }

  async function pickFolder() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setTarget(picked);
    } catch {
      notify("폴더 선택 창을 열지 못했습니다. 경로를 직접 입력해 주십시오.", "error");
    }
  }

  const handleReveal = useCallback(async (path: string) => {
    const outcome = await revealInExplorer(path);
    // revealItemInDir 은 상위 폴더를 열고 항목을 선택한다. '열었습니다'라고 적으면
    // 폴더 안을 기대한 사용자가 한 단계 위 화면을 받고 한 번 더 더블클릭하게 된다.
    if (outcome === "revealed") notify("탐색기에서 위치를 표시했습니다.");
    else if (outcome === "copied") notify("탐색기를 열 수 없어 경로를 클립보드에 복사했습니다.", "error");
    else notify("탐색기를 열지 못했습니다.", "error");
  }, []);

  const handleCopyPath = useCallback(async (path: string) => {
    const ok = await copyText(path);
    notify(ok ? "경로를 복사했습니다." : "복사에 실패했습니다.", ok ? "info" : "error");
  }, []);

  /*
   * 스캔 수명주기는 useScan 이 전담한다.
   *
   * 콜백은 훅 안의 ref 를 거치므로 여기서 상태를 몇 개 읽든 startScan 의 참조가
   * 흔들리지 않는다 — 예전의 startScanRef 우회가 사라지는 지점이다.
   */
  const scan = useScan({
    onStart: () => setLive("스캔을 시작했습니다."),
    onAnnounce: setLive,
    onNotify: notify,
    onError: (err) => {
      setError(err);
      setAlertLive(friendlyError(err));
    },
    onTick: (ms, p) => {
      // 낭독 폭주를 막으려고 5초 간격으로만 요약을 갱신한다.
      if (p && Math.floor(ms / 1000) % 5 === 0) {
        setLive(`스캔 중 ${formatClock(ms)} — ${formatCount(p.files)}개 파일, ${formatBytes(p.bytes)}`);
      }
    },
    onResult: (path, res) => {
      setTargetOpen(false);
      // 부분 집계는 비교 기준이 될 수 없다.
      if (!res.cancelled) {
        setDelta(
          compareMessage(history[path], {
            size: res.totalSize,
            errors: res.errors,
            elevated: res.elevated,
            sizeBasis: res.sizeBasis,
            appVersion: res.appVersion,
            // 중복 제거 기준이 다르면 총량 델타는 정리 성과가 아니다(elevated 와 동형).
            dedup: res.dedup,
          }),
        );
        setHistory((prev) =>
          writeHistory(prev, path, {
            size: res.totalSize,
            errors: res.errors,
            totalFiles: res.totalFiles,
            appVersion: res.appVersion,
            sizeBasis: res.sizeBasis,
            // 같은 볼륨도 실행 권한에 따라 총량이 GB 단위로 달라진다. 저장해 두지
            // 않으면 그 차이가 다음 스캔에서 '정리 성과'로 보고된다.
            elevated: res.elevated,
            // dedup 기준 차이도 같은 크기의 오독을 만든다. 비교·내보내기에서 함께 쓴다.
            dedup: res.dedup,
            dedupMinBytes: res.dedupMinBytes,
          }),
        );
      } else {
        setDelta({ text: "", direction: "unknown" });
      }
      setScannedPath(path);
      setScannedAt(new Date());
      setRecent((prev) => {
        const next = [path, ...prev.filter((p) => p !== path)].slice(0, RECENT_MAX);
        try {
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch {
          // 저장 실패는 기능에 영향이 없다.
        }
        return next;
      });
      setLive(`스캔 완료. 총 ${formatBytes(res.totalSize)}, 파일 ${formatCount(res.totalFiles)}개.`);
      // 결과가 교체되면 포커스가 있던 트리 행이 언마운트되며 포커스가 body 로 떨어진다.
      window.setTimeout(() => resultsRef.current?.focus(), 0);
      // 정리 후 여유 공간이 바뀌었을 수 있다.
      void refreshDrives(false);
    },
  });
  const { scanning, cancelling, progress, result, elapsed, cancelScan } = scan;

  /** 대상 문자열 정규화와 화면 초기화만 여기서 하고 나머지는 훅에 넘긴다. */
  async function startScan(pathArg?: string) {
    const path = (pathArg ?? target).trim();
    if (!path || scanning) return;

    setTarget(path);
    setError(null);
    /*
     * 대상이 바뀌면 트리 검색어를 비운다.
     *
     * 정리 후보 카드의 '나머지 N곳은 … 검색'이 채운 검색어가 남아 있으면, 다른
     * 경로를 스캔했을 때 새 결과가 이전 스캔의 필터로 걸러진 채 그려진다. 새 대상에
     * 그 이름이 없으면 폴더별 용량 패널에는 '일치하는 항목이 없습니다'만 남아,
     * 사용자는 스캔이 실패했다고 읽는다. 같은 경로 재스캔은 문맥이 이어지므로 둔다.
     */
    if (path !== scannedPath) setTreeQuery("");
    await scan.startScan(path);
  }

  function clearHistory() {
    clearStoredPaths();
    setRecent([]);
    setHistory({});
    setDelta({ text: "", direction: "unknown" });
    notify("저장된 스캔 경로 기록을 지웠습니다.");
  }

  const selectedDrive = useMemo(
    () => drives.find((d) => d.path === target) ?? null,
    [drives, target],
  );
  /**
   * 스캔 대상이 속한 볼륨.
   *
   * 예전에는 경로 완전 일치라 드라이브 루트를 스캔했을 때만 찾아졌다. 그런데
   * 여유 공간은 경로 속성이 아니라 볼륨 속성이고, 실사용에서는 '어느 폴더가
   * 문제인지 짐작이 갈 때 그 폴더만 스캔'하는 쪽이 더 흔하다. 폴더 스캔에서
   * 여유 공간·정리 후 목표치가 통째로 사라지면 이 앱을 켠 이유에 답이 없다.
   */
  const scannedDrive = useMemo(() => {
    const vol = /^([A-Za-z]):/.exec(scannedPath)?.[1]?.toUpperCase();
    if (!vol) return null;
    return drives.find((d) => d.path.toUpperCase().startsWith(`${vol}:`)) ?? null;
  }, [drives, scannedPath]);
  /** 커버리지 대조(드라이브 사용량 vs 합계)는 루트를 통째로 스캔했을 때만 성립한다. */
  const scannedIsRoot =
    scannedDrive !== null && scannedDrive.path.toUpperCase() === scannedPath.toUpperCase();
  const targetBlocked = selectedDrive ? driveBlockedReason(selectedDrive) : null;

  /*
   * 진행률 퍼센트는 내지 않는다.
   *
   * 예전에는 `min(99, 스캔한 바이트 / 드라이브 사용량)` 으로 퍼센트를 냈는데, 두 경우
   * 모두 거짓말이 됐다 — 하위 폴더를 스캔하면 분모(드라이브 전체)가 과대해 영영 안
   * 차고, 드라이브 전체를 스캔하면 큰 파일 몇 개에 99% 상한까지 순식간에 올라간 뒤
   * 남은 수만 개의 작은 파일과 마무리(가지치기·집계)가 도는 내내 99%에 멈춰 있었다.
   * '거의 다 됐다'는 신호를 준 채로 한참 기다리게 하는 것이 이 표시의 결함이었다.
   * 총량을 미리 알 방법이 없으므로 정직한 표시는 무한 진행 막대 + 실측 카운트다.
   */

  const tips = useMemo(
    () =>
      result
        ? // 가지치기 임계값을 함께 넘겨야 카드가 '합계는 하한'임을 근거와 함께 적을 수 있다.
          cleanupTips(result.root, result.totalSize, { minSize: result.pruneParams?.minSize })
        : [],
    [result],
  );
  const largestFiles = useMemo(() => {
    if (!result) return [];
    // 백엔드가 별도 목록을 주면 그것을 쓰고, 트리에 파일 노드가 실린 경우에는 거기서 뽑는다.
    if (result.largestFiles && result.largestFiles.length > 0) return result.largestFiles.slice(0, 20);
    return collectFileNodes(result.root, 20);
  }, [result]);

  const errorBreakdown = useMemo(() => (result ? breakdownErrors(result) : null), [result]);
  const coverage = useMemo(
    () =>
      result && scannedDrive && scannedIsRoot && scannedDrive.total > 0
        ? describeCoverage(result, scannedDrive.total - scannedDrive.free)
        : null,
    [result, scannedDrive, scannedIsRoot],
  );
  /*
   * 자식에게 넘기는 콜백은 전부 안정 참조여야 한다.
   *
   * 진행 이벤트는 백엔드 송신 주기(150ms)마다 setProgress 를 부르고, 재스캔 중에도
   * 이전 결과는 의도적으로 유지되므로 트리·분야·파일·정리 패널이 모두 마운트된
   * 상태다. 이 네 패널을 memo 로 감싸도 콜백이 매 렌더 새로 만들어지면 memo 가
   * 무효가 되어 최대 3,000행이 초당 6~7회 재조정된다 — 스캔이 가장 무거운 순간에
   * UI 스레드를 정확히 그만큼 뺏는 셈이다.
   *
   * useScan 의 startScan 은 콜백을 ref 로 받으므로 그 자체가 영구 안정 참조다.
   * 예전의 startScanRef 우회는 여기서 사라졌다.
   */
  const handleRescan = useCallback(
    (path: string) => {
      void scan.startScan(path);
    },
    [scan.startScan],
  );
  const handleTipSearch = useCallback((q: string) => {
    setTreeQuery(q);
    // 검색어만 채우고 화면이 그대로면 어디로 갔는지 알 수 없다.
    document.querySelector(".panel-tree")?.scrollIntoView({ block: "start" });
  }, []);

  // 새 스캔 결과가 오면 제외 상태를 비운다 — 이전 스캔의 경로·분야는 의미가 없다.
  useEffect(() => {
    setExcludedPaths(new Set());
    setExcludedCats(new Set());
  }, [result]);

  const toggleExcludePath = useCallback((path: string) => {
    setExcludedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const restoreAllPaths = useCallback(() => setExcludedPaths(new Set()), []);
  const toggleExcludeCat = useCallback((key: string) => {
    setExcludedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** 제외분을 뺀 트리와 그 합계. 폴더 제외는 트리·총계에만 반영한다(분야 제외는 별도 축). */
  const folderExcl = useMemo(
    () => (result ? applyFolderExclusions(result.root, excludedPaths) : null),
    [result, excludedPaths],
  );

  const linkLine = result ? describeSkippedLinks(result) : null;
  const cloudLine = result ? describeSkippedCloud(result) : null;
  const conditions = result ? basisLines(result) : [];
  /** null 이면 그 각주는 상수 조건이라 접히는 영역으로 내려갔다는 뜻이다. */
  const footnote = result ? totalFootnote(result) : null;

  /**
   * 열어 둔 팝오버가 결과 위에 계속 떠 있으면 '닫는 법'을 따로 배워야 한다.
   * Escape 와 바깥 클릭으로 닫고, 포커스는 트리거로 되돌린다.
   */
  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExportOpen(false);
      exportBtnRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [exportOpen]);

  const exportOptions: ExportOptions = {
    ...(exportSerial ? { includeVolumeSerial: true } : {}),
    ...(exportAnonymize ? { anonymizePaths: true } : {}),
  };

  function saveFile(kind: "tree" | "category" | "extension" | "failed" | "history" | "json") {
    if (!result) return;
    const stamp = timestampSlug();
    const build = {
      tree: () => ({ name: `discan-tree-${stamp}.csv`, mime: "text/csv", text: buildTreeCsv(result, scannedPath, exportOptions) }),
      category: () => ({ name: `discan-categories-${stamp}.csv`, mime: "text/csv", text: buildCategoryCsv(result, scannedPath, exportOptions) }),
      extension: () => ({ name: `discan-extensions-${stamp}.csv`, mime: "text/csv", text: buildExtensionCsv(result, scannedPath, exportOptions) }),
      failed: () => ({ name: `discan-failed-${stamp}.csv`, mime: "text/csv", text: buildFailedPathsCsv(result, scannedPath, exportOptions) }),
      history: () => ({ name: `discan-history-${stamp}.csv`, mime: "text/csv", text: buildHistoryCsv(history, exportOptions) }),
      json: () => ({ name: `discan-${stamp}.json`, mime: "application/json", text: buildJson(result, scannedPath, exportOptions) }),
    }[kind]();
    downloadText(build.name, build.text, build.mime);
    setExportOpen(false);
    exportBtnRef.current?.focus();
    /*
     * 확인하지 않은 사실을 단정하지 않는다.
     *
     * downloadText 는 `<a download>` 클릭으로 끝나는 fire-and-forget 이고,
     * capabilities 에 dialog:allow-save 도 fs 쓰기도 없어 앱이 저장 여부·경로를
     * 확인할 수단 자체가 없다. WebView2 는 정책·프로필 설정에 따라 저장 위치를 묻거나
     * 차단할 수 있으므로 '저장했습니다'는 거짓이 될 수 있는 문장이다. 앱이 실제로
     * 아는 사실(내보내기를 시작했다)만 적는다.
     * — 정공법은 capabilities 에 저장 대화상자 권한을 추가해 실제 경로를 받는 것이다.
     */
    notify(`${build.name} 내보내기를 시작했습니다 — 저장 위치는 Windows 다운로드 설정을 따릅니다.`);
  }

  /*
   * 총 용량이 하한값인 경우의 표식.
   *
   * 취소만 보던 조건에 root.incomplete 를 더한다 — 접근 거부된 폴더를 대상으로
   * 잡으면 total_files=0, root.incomplete=true 로 오는데, 그때 '0 B'를 표식 없이
   * 적으면 '비어 있다'는 거짓 결론이 그대로 1차 정보가 된다.
   */
  const lowerBound = result !== null && (result.cancelled || result.root.incomplete === true);
  /*
   * 정리 후보 합계. 이 앱을 켠 이유에 가장 가까운 숫자다.
   *
   * 도달점 계산(안전만 정리 / 전부 정리)은 CleanupTips 가 한다 — 예전에는 여기서
   * '안전 합계 > 0' 일 때만 목표치를 만들어, 가장 흔한 후보가 모두 '주의' 등급인
   * 표준 화면에서 그 문장이 통째로 사라졌다.
   */
  const tipsTotal = tips.reduce((sum, t) => sum + t.size, 0);
  const tipsLowerBound = tips.some((t) => t.isLowerBound);
  /** 후보 합계와 8배씩 어긋나는 분야 합계를 카드가 한 문장 안에서 화해시키게 한다. */
  const cacheCategory = useMemo(() => {
    const stat = result?.categories.find((c) => c.key === "cache");
    return stat ? { label: categoryLabel(stat), size: stat.size } : null;
  }, [result]);

  /**
   * 내보내기 팝오버. 접힌 대상 줄과 펼친 결과 머리 양쪽에서 같은 것을 쓴다.
   *
   * 메뉴 항목에는 무엇에 쓰는 파일인지 한 마디씩 붙인다 — CSV 세 종류와 JSON 을
   * 이름만으로 구분할 수 있는 사용자는 많지 않다.
   */
  const exportControl = (
    <div className="export" ref={exportRef}>
      <button
        type="button"
        className="btn tiny"
        ref={exportBtnRef}
        aria-expanded={exportOpen}
        onClick={() => setExportOpen((v) => !v)}
      >
        내보내기 ▾
      </button>
      {/* role="menu" 는 menuitem·화살표 이동을 요구한다. 실제 구현은
          버튼 나열 + 설정 체크박스이므로 단순 팝오버로 둔다. */}
      {exportOpen && (
        <div className="export-menu">
          <button type="button" className="export-item" onClick={() => saveFile("tree")}>
            폴더별 표 (CSV)
            <span className="export-item-note">엑셀에서 열 수 있는 폴더·파일 목록</span>
          </button>
          <button type="button" className="export-item" onClick={() => saveFile("category")}>
            분야별 표 (CSV)
            <span className="export-item-note">영상·캐시 등 분야별 합계</span>
          </button>
          <button
            type="button"
            className="export-item"
            onClick={() => saveFile("extension")}
            disabled={(result?.extensions?.length ?? 0) === 0}
          >
            확장자별 표 (CSV)
            <span className="export-item-note">.mp4·.zip 등 확장자별 합계</span>
          </button>
          {/* 실패 목록은 감사 추적의 1차 자료인데 JSON 을 읽을 수 있는 소비자에게만
              열려 있었다. '이 표가 놓친 용량이 어디에 있는가'가 표 산출물만으로
              종결되려면 이 항목이 있어야 한다. */}
          <button
            type="button"
            className="export-item"
            onClick={() => saveFile("failed")}
            disabled={(result?.failedPaths?.length ?? 0) === 0}
          >
            읽지 못한 경로 (CSV)
            <span className="export-item-note">권한·길이 등으로 빠진 위치 목록</span>
          </button>
          <button
            type="button"
            className="export-item"
            onClick={() => saveFile("history")}
            disabled={Object.keys(history).length === 0}
          >
            스캔 이력 (CSV)
            <span className="export-item-note">이 PC에 남은 경로별 실행 기록</span>
          </button>
          <button type="button" className="export-item" onClick={() => saveFile("json")}>
            전체 원본 데이터 (JSON)
            <span className="export-item-note">화면에 나온 모든 수치와 집계 조건</span>
          </button>
          <div className="export-settings">
            {/* 라벨이 약속하는 보호와 실제 동작이 어긋나면 통제가 아니라 오해다.
                익명화는 트리·상위 파일·실패 목록·프리앰블에 한 함수로 일괄 적용된다. */}
            <label className="export-opt">
              <input
                type="checkbox"
                checked={exportAnonymize}
                onChange={(e) => setExportAnonymize(e.currentTarget.checked)}
              />
              경로 익명화 (스캔 루트 아래 상대 경로만)
            </label>
            <label className="export-opt">
              <input
                type="checkbox"
                checked={exportSerial}
                onChange={(e) => setExportSerial(e.currentTarget.checked)}
              />
              볼륨 식별자 포함 (감사용)
            </label>
            <p className="export-note">{exportDisclosure(exportOptions)}</p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      {/*
        결과가 있으면 헤더를 접는다.
        창 제목이 이미 'Discan — 디스크 공간 분석기'인데 그 아래 워드마크 행을 다시
        그리는 것은 웹 관습이다. 결과가 있으면 툴바도 숨겨져 이 행에는 컨트롤이 하나도
        없는데 헤더 32px + gap 14px 로 기본 창 높이의 6% 를 먹었다 — 분야 목록 데이터
        두 행에 해당하는 공간이다. 브랜드 마크는 접힌 대상 줄 왼쪽 끝으로 옮긴다.
      */}
      {!result && (
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◧
            </span>
            <h1>Discan</h1>
          </div>
          <div className="toolbar">
            <button
              type="button"
              className="btn tiny"
              onClick={() => void startScan(target)}
              disabled={scanning || !target}
            >
              다시 스캔
            </button>
          </div>
        </header>
      )}

      {/* 결과가 나온 뒤에는 설정 영역을 한 줄로 접는다 — 이미 끝난 조작이 결과보다 클 이유가 없다. */}
      {result && !targetOpen ? (
        <section className="panel panel-target collapsed">
          <div className="target-summary">
            {/* 헤더를 접은 대신 브랜드 마크만 여기로 옮긴다(폭 비용 0). */}
            <span className="brand-mark" aria-hidden="true">
              ◧
            </span>
            <span className="target-summary-path" title={scannedPath}>
              {middlePath(scannedPath, 48)}
            </span>
            {/*
              여유 공간은 4번 지표 타일이 각주까지 달아 낸다 — 두 값이 세로 40px
              간격으로 나란히 있으면 설명이 아니라 소음이다(총 용량 중복을 없애려고
              여기에 넣었던 값이 나중에 타일로도 승격되면서 같은 결함이 재발했다).
              타일이 답하지 못하는 값만 남긴다: 무엇을·언제·얼마나 걸려 셌는가.
              라벨 없는 '1초 미만 · 오전 12:54:00' 은 앞이 소요 시간인지 알 수 없었다.
            */}
            <span className="target-summary-when">
              {/* 초 단위는 의사결정에 기여하지 않으면서 정렬도 안 되는 자리라 뺀다(분까지). */}
              {scannedAt &&
                `${scannedAt.toLocaleTimeString(navigator.language || "ko-KR", {
                  hour: "numeric",
                  minute: "2-digit",
                })} 스캔 · `}
              {formatDuration(result.elapsedMs)} 소요
            </span>
            {/* 좁은 창에서 줄바꿈이 일어날 때 텍스트가 아니라 이 묶음이 내려가야
                한다 — 가장 중요한 정보(무엇을 스캔했는가)가 먼저 잘리면 안 된다. */}
            <span className="target-summary-actions">
              <button type="button" className="btn tiny" onClick={() => setTargetOpen(true)}>
                경로 변경
              </button>
              <button
                type="button"
                className="btn tiny"
                onClick={() => void startScan(scannedPath)}
                disabled={scanning}
              >
                다시 스캔
              </button>
              {/* 내보내기 버튼 하나가 45px 짜리 빈 대역을 통째로 차지하고 있었다.
                  결과 전체에 대한 조작이므로 대상 줄 끝이 제자리다. */}
              {exportControl}
            </span>
          </div>
        </section>
      ) : (
        <section className="panel panel-target">
          <h2 className="panel-title">분석 대상</h2>

          <div className="drive-grid" role="group" aria-label="분석할 드라이브">
            {drivesLoading && <p className="panel-empty">드라이브를 확인하는 중입니다…</p>}
            {!drivesLoading && drives.length === 0 && (
              <p className="panel-empty">
                드라이브를 찾지 못했습니다 — 아래에 경로를 직접 입력하십시오.
              </p>
            )}
            {drives.map((d) => {
              const used = d.total - d.free;
              const usage = d.total > 0 ? (used / d.total) * 100 : 0;
              const level = usage >= 90 ? "critical" : usage >= 75 ? "warn" : "ok";
              // 실패가 예정된 어포던스를 주지 않는다 — 눌러 보고 나서 거부당하는 것이 가장 나쁘다.
              const blocked = driveBlockedReason(d);
              // 쿼터가 걸린 볼륨에서는 '여유 공간'과 '내가 쓸 수 있는 공간'이 다르다.
              // 값을 받아 두고도 화면에 쓰지 않으면 정리 목표치가 틀어진다.
              const quota =
                d.availableToCaller !== undefined && d.availableToCaller < d.free
                  ? d.availableToCaller
                  : null;
              return (
                <button
                  key={d.path}
                  type="button"
                  className={`drive-card ${level}${target === d.path ? " selected" : ""}${blocked ? " blocked" : ""}`}
                  aria-pressed={target === d.path}
                  onClick={() => setTarget(d.path)}
                  disabled={scanning || blocked !== null}
                  title={
                    blocked ??
                    (quota !== null
                      ? `쿼터가 걸려 있어 실제로 쓸 수 있는 공간은 ${formatBytes(quota)} 입니다.`
                      : undefined)
                  }
                >
                  <div className="drive-top">
                    <span className="drive-label">{d.label}</span>
                    {!blocked && d.total > 0 && (
                      <span className="drive-usage">{Math.round(usage)}% 사용</span>
                    )}
                  </div>
                  {blocked ? (
                    <div className="drive-blocked">{blocked}</div>
                  ) : (
                    d.total > 0 && (
                      <>
                        <div className="drive-bar">
                          <div className="drive-bar-fill" style={{ width: `${usage}%` }} />
                        </div>
                        <div className="drive-sub">
                          {formatBytes(used)} / {formatBytes(d.total)}
                          {quota !== null && (
                            <span className="drive-quota"> · 쿼터 {formatBytes(quota)}</span>
                          )}
                        </div>
                      </>
                    )
                  )}
                </button>
              );
            })}
          </div>

          {drives.length > 0 && (
            <p className="unit-note" title="1 GiB = 1024 MiB. 윈도우 탐색기가 'GB'로 적는 값과 같은 계산 방식입니다.">
              용량은 GiB(1 GiB = 1024 MiB) 표기입니다 — 탐색기가 'GB'라고 적는 값과 같은 계산입니다.
            </p>
          )}

          <form
            className="target-row"
            onSubmit={(e) => {
              e.preventDefault();
              void startScan();
            }}
          >
            <input
              className="target-input"
              value={target}
              onChange={(e) => setTarget(e.currentTarget.value)}
              placeholder="분석할 경로 (Enter 로 시작)"
              aria-label="분석할 경로"
              disabled={scanning}
            />
            <button type="button" className="btn" onClick={pickFolder} disabled={scanning}>
              폴더 선택
            </button>
            {/* 시작·중단이 같은 자리에서 교체되면 연속 클릭이 취소로 들어간다. 자리를 분리한다. */}
            <button
              type="submit"
              className="btn primary"
              disabled={!target || scanning || targetBlocked !== null}
            >
              {scanning ? "스캔 중…" : "스캔 시작"}
            </button>
          </form>

          {targetBlocked && <p className="target-blocked">{targetBlocked}</p>}

          <p className="reassure">파일을 읽어 크기만 셉니다. 아무것도 지우거나 바꾸지 않습니다.</p>
        </section>
      )}

      {scanning && progress && (
        <div className="progress panel">
          <div className={`progress-spinner${cancelling ? " danger" : ""}`} />
          {/* 150ms마다 바뀌는 숫자를 라이브 리전으로 두면 낭독이 폭주한다.
              보조기술에는 아래 sr-only 요약(5초 간격)만 전달한다. */}
          <div className="progress-body" aria-hidden="true">
            <div className="progress-line">
              <span>
                {cancelling
                  ? "중단 처리 중 — 이미 시작된 폴더를 마무리하고 있습니다"
                  : `${formatCount(progress.files)}개 파일 · ${formatCount(progress.dirs)}개 폴더 · ${formatBytes(progress.bytes)}`}
                {progress.errors > 0 && ` · 접근 불가 ${formatCount(progress.errors)}건`}
                {/* 매 150ms 실려 오면서 화면에는 한 번도 나오지 않던 값이다. */}
                {(progress.skippedLinks ?? 0) > 0 &&
                  ` · 링크 ${formatCount(progress.skippedLinks ?? 0)}건 건너뜀`}
              </span>
              <span className="progress-clock">
                {formatClock(elapsed)}
                {/* 남은 시간을 아는 척하지 않되, 기대치는 미리 준다 — '거의 다 됐다'는
                    가짜 신호 없이도 '한참 걸리는 게 정상'임을 알리는 것이 목적이다. */}
                {" · 큰 드라이브는 1~3분 걸릴 수 있습니다"}
              </span>
            </div>
            {/* 총량을 모르므로 채움 막대로 진척을 흉내 내지 않는다. 무한 막대가 도는
                동안 위의 파일·용량 카운트가 실제 진행을 보여 준다(마무리 단계에서 그
                카운트가 잠깐 멈춰도 막대는 계속 돌아 '멈춘 것 아님'을 전한다). */}
            <div className="progress-track">
              <div className="progress-indeterminate" />
            </div>
            {progress.currentPath && (
              <div className="progress-path">{middlePath(progress.currentPath, 72)}</div>
            )}
          </div>
          <button type="button" className="btn danger" onClick={cancelScan} disabled={cancelling}>
            {cancelling ? "중단 중…" : "중단"}
          </button>
        </div>
      )}

      {/* 낭독 채널은 이 두 리전뿐이다. 토스트는 시각 채널만 담당한다. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live}
      </p>
      <p className="sr-only" role="alert" aria-atomic="true">
        {alertLive}
      </p>

      {/* 패널 흐름에서 빼내면 나타났다 사라질 때 아래 콘텐츠를 밀지 않는다. */}
      {toast && (
        <div
          className={`toast ${toastTone}`}
          onMouseEnter={holdToast}
          onMouseLeave={resumeToast}
          onFocus={holdToast}
          onBlur={resumeToast}
        >
          <span className="toast-text">{toast}</span>
          {/*
            닫기 버튼은 정보 톤에도 상시 둔다.
            정보 토스트는 3.5초 뒤 자동 소멸하는데, 일시정지가 onMouseEnter/onFocus 로만
            걸리고 정보 토스트에는 포커스할 내부 대상이 없어 마우스 없는 키보드 사용자는
            타이머를 멈출 수단이 없었다(WCAG 2.2.1). 이 버튼이 포커스 대상이 되어
            onFocus→holdToast 로 타이머가 멈추고, 해제 수단도 함께 제공된다.
          */}
          <button
            type="button"
            className="icon-btn"
            aria-label="알림 닫기"
            onClick={() => setToast("")}
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className={`error-box${isBenignError(error) ? " benign" : ""}`} role="alert">
          <span className="error-icon" aria-hidden="true">
            !
          </span>
          <div className="error-body">
            <p className="error-title">{friendlyError(error)}</p>
            {/* 문제가 된 경로는 코드만큼이나 중요한 정보다. 접지 않고 바로 보인다. */}
            {error.detail && (
              <p className="error-detail" title={error.detail}>
                {middlePath(error.detail, 64)}
              </p>
            )}
            <details>
              <summary>자세한 내용</summary>
              <code>{errorDetail(error)}</code>
            </details>
          </div>
          {/* 몇 번을 눌러도 결과가 같은 오류에 '다시 시도'를 주면 헛수고를 시킨다. */}
          {errorAction(error) === "retry" && (
            <button type="button" className="btn tiny" onClick={() => void startScan()}>
              다시 시도
            </button>
          )}
          {errorAction(error) === "pick" && (
            <button type="button" className="btn tiny" onClick={pickFolder}>
              다른 경로 선택
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="오류 닫기"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {!result && !scanning && (
        <EmptyState
          recent={recent}
          onPick={(p) => void startScan(p)}
          onClearHistory={clearHistory}
        />
      )}

      {result && (
        <div
          className={`results${scanning ? " stale" : ""}`}
          aria-busy={scanning}
          /*
           * 재스캔 중에는 포인터뿐 아니라 키보드도 막는다.
           *
           * `pointer-events: none` 만으로는 Tab 포커스와 Enter 활성화가 그대로 들어가,
           * 흐려진 이전 결과에서 '내보내기 → JSON' 을 키보드로 눌러 새 스캔과 무관한
           * 옛 스냅샷을 저장할 수 있었다. inert 는 포커스·클릭·접근성 트리 노출을
           * 한 번에 막아 시각 표현('지금은 조작할 수 없음')과 동작을 일치시킨다.
           */
          inert={scanning || undefined}
          ref={resultsRef}
          tabIndex={-1}
          role="region"
          aria-label="스캔 결과"
        >
          <h2 className="sr-only">스캔 결과 요약</h2>
          {/* 대상 줄이 펼쳐져 있을 때만 별도 머리 행을 쓴다. 접혀 있으면 내보내기는
              대상 줄 끝에 붙으므로, 버튼 하나만 담은 빈 대역이 남지 않는다. */}
          {targetOpen && <div className="results-head">{exportControl}</div>}

          <ResultHeader
            result={result}
            lowerBound={lowerBound}
            footnote={footnote}
            delta={delta}
            scannedDrive={scannedDrive}
            tipsTotal={tipsTotal}
            tipsLowerBound={tipsLowerBound}
            errorBreakdown={errorBreakdown}
            coverage={coverage}
            linkLine={linkLine}
            cloudLine={cloudLine}
            conditions={conditions}
            conditionsSummaryText={conditionsSummary(result)}
            failedPreview={FAILED_PREVIEW}
          />

          {/*
            파일이 없어도 폴더가 있으면 트리는 그대로 그린다.
            예전 조건(totalFiles === 0)은 빌드 산출물을 지운 직후의 프로젝트 트리처럼
            빈 하위 폴더만 수백 개인 경로에서 '폴더 312' 를 지표에 띄우면서 폴더 목록은
            어디에도 없는 화면을 만들었다 — CSV 내보내기는 그때도 312행을 담아,
            화면과 산출물이 어긋났다. 판정 기준은 개수가 아니라 '그릴 것이 있는가'다
            (읽지 못한 루트는 자식이 없으므로 아래 진단 문구로 그대로 떨어진다).
          */}
          {result.totalFiles === 0 && result.root.children.length === 0 ? (
            <section className="panel">
              <h2 className="panel-title">결과</h2>
              {/*
                사용자가 스스로 중단한 스캔에 '읽지 못했다'는 틀린 원인을 단정하지
                않는다. 스캔 시작 직후(resolve_root 구간)에 중단하면 cancelled=true ·
                total_files=0 · root.incomplete=true 이면서 errors 는 0으로 오는데,
                그때 위쪽 notice 는 '사용자 중단'이라고 맞게 적고 있어 같은 화면에서
                두 문장이 서로 다른 원인을 말하게 된다.
              */}
              {result.cancelled ? (
                <p className="panel-empty">
                  중단하여 집계된 내용이 없습니다 — 다시 스캔하면 처음부터 셉니다.
                </p>
              ) : errorBreakdown || result.root.incomplete ? (
                <>
                  <p className="panel-empty">
                    이 경로를 읽지 못해 내용을 확인할 수 없습니다 — {scannedPath}
                  </p>
                  {errorBreakdown && (
                    <p className="panel-empty">
                      {describeErrors(errorBreakdown)}
                      {errorBreakdown.suggestElevation &&
                        " 관리자 권한으로 다시 실행하면 보일 수 있습니다."}
                    </p>
                  )}
                </>
              ) : (
                <p className="panel-empty">이 경로에는 파일이 없습니다 — {scannedPath}</p>
              )}
            </section>
          ) : (
            <>
              {result.totalFiles === 0 && (
                <section className="panel">
                  <p className="panel-empty">
                    파일은 없고 폴더만 {formatCount(result.totalDirs)}개 있습니다 — 아래
                    ‘폴더별 용량’에서 구조를 확인하실 수 있습니다.
                  </p>
                </section>
              )}
              <CleanupTips
                tips={tips}
                free={scannedDrive && scannedDrive.total > 0 ? scannedDrive.free : null}
                minSize={result.pruneParams?.minSize}
                cacheCategory={cacheCategory}
                onReveal={handleReveal}
                onSearch={handleTipSearch}
              />
              <CategorySummary
                categories={result.categories}
                contentCategories={result.contentCategories}
                extensions={result.extensions}
                otherExtensions={result.otherExtensions}
                totalSize={result.totalSize}
                errors={result.errors}
                errorHint={errorBreakdown ? describeErrors(errorBreakdown) : undefined}
                excludedKeys={excludedCats}
                onToggleExclude={toggleExcludeCat}
              />
              {/* 트리맵은 실제 디스크 구성을 그대로 보여 준다(제외는 폴더 트리 전용 개념). */}
              <Treemap root={result.root} onReveal={handleReveal} onCopyPath={handleCopyPath} />
              <LargestFiles
                files={largestFiles}
                totalSize={result.totalSize}
                onReveal={handleReveal}
                onCopyPath={handleCopyPath}
              />
              <TreeView
                root={folderExcl ? folderExcl.tree : result.root}
                query={treeQuery}
                onQueryChange={setTreeQuery}
                onRescan={handleRescan}
                onReveal={handleReveal}
                onCopyPath={handleCopyPath}
                onToggleExclude={toggleExcludePath}
                onRestoreExcluded={restoreAllPaths}
                excludedSize={folderExcl?.excludedSize ?? 0}
                excludedCount={folderExcl?.items.length ?? 0}
                originalSize={result.totalSize}
              />
              {/* 중복 파일 탐지 + 휴지통 정리. 스캔과 별개의 비싼 작업이라 패널 안에서
                  버튼으로 시작한다. 대상은 방금 스캔한 경로. */}
              <Duplicates
                scannedPath={scannedPath}
                onReveal={handleReveal}
                onCopyPath={handleCopyPath}
                onNotify={notify}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
