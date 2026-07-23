import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { CategorySummary } from "./components/CategorySummary";
import { TreeView } from "./components/TreeView";
import { DriveInfo, ScanProgress, ScanResult } from "./types";
import { formatBytes, formatCount, formatDuration, percent } from "./lib/format";
import "./App.css";

function App() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [target, setTarget] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string>("");

  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    invoke<DriveInfo[]>("list_drives")
      .then((d) => {
        setDrives(d);
        if (d.length > 0) setTarget(d[0].path);
      })
      .catch((e) => setError(String(e)));

    return () => {
      unlistenRef.current?.();
    };
  }, []);

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setTarget(picked);
  }

  async function startScan() {
    if (!target || scanning) return;

    setError("");
    setResult(null);
    setProgress({ files: 0, dirs: 0, bytes: 0, errors: 0 });
    setScanning(true);

    unlistenRef.current = await listen<ScanProgress>("scan-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const res = await invoke<ScanResult>("start_scan", { path: target });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setScanning(false);
    }
  }

  function cancelScan() {
    invoke("cancel_scan").catch(() => {});
  }

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◧</span>
          <div>
            <h1>Discan</h1>
            <p className="tagline">디스크 공간 분석기</p>
          </div>
        </div>
      </header>

      <section className="panel">
        <h2 className="panel-title">분석 대상</h2>

        <div className="drive-grid">
          {drives.map((d) => {
            const used = d.total - d.free;
            return (
              <button
                key={d.path}
                className={`drive-card${target === d.path ? " selected" : ""}`}
                onClick={() => setTarget(d.path)}
                disabled={scanning}
              >
                <div className="drive-top">
                  <span className="drive-label">{d.label}</span>
                  {d.total > 0 && (
                    <span className="drive-free">{formatBytes(d.free)} 여유</span>
                  )}
                </div>
                {d.total > 0 && (
                  <>
                    <div className="drive-bar">
                      <div
                        className="drive-bar-fill"
                        style={{ width: `${percent(used, d.total)}%` }}
                      />
                    </div>
                    <div className="drive-sub">
                      {formatBytes(used)} / {formatBytes(d.total)}
                    </div>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="target-row">
          <input
            className="target-input"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            placeholder="분석할 경로"
            disabled={scanning}
          />
          <button className="btn" onClick={pickFolder} disabled={scanning}>
            폴더 선택
          </button>
          {scanning ? (
            <button className="btn danger" onClick={cancelScan}>
              중단
            </button>
          ) : (
            <button className="btn primary" onClick={startScan} disabled={!target}>
              스캔 시작
            </button>
          )}
        </div>

        {scanning && progress && (
          <div className="progress">
            <div className="progress-spinner" />
            <span>
              {formatCount(progress.files)}개 파일 · {formatCount(progress.dirs)}개 폴더 ·{" "}
              {formatBytes(progress.bytes)}
              {progress.errors > 0 && ` · 접근 불가 ${formatCount(progress.errors)}건`}
            </span>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <section className="stat-row">
            <div className="stat">
              <span className="stat-value">{formatBytes(result.totalSize)}</span>
              <span className="stat-label">총 용량</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatCount(result.totalFiles)}</span>
              <span className="stat-label">파일</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatCount(result.totalDirs)}</span>
              <span className="stat-label">폴더</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatDuration(result.elapsedMs)}</span>
              <span className="stat-label">소요</span>
            </div>
          </section>

          {(result.errors > 0 || result.cancelled) && (
            <p className="notice">
              {result.cancelled && "사용자 중단으로 부분 집계된 결과입니다. "}
              {result.errors > 0 &&
                `권한 등의 이유로 ${formatCount(result.errors)}개 항목을 읽지 못했습니다 — 실제 용량은 이보다 큽니다.`}
            </p>
          )}

          <CategorySummary categories={result.categories} totalSize={result.totalSize} />
          <TreeView root={result.root} />
        </>
      )}
    </main>
  );
}

export default App;
