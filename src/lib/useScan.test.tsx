import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useScan } from "./useScan";
import { ScanResult } from "../types";

/**
 * 취소는 이 앱에서 상태가 가장 복잡한 축인데, 예전에는 App 을 통째로 렌더해야만
 * 그 네 갈래를 실행할 수 있었다. 수명주기를 훅으로 떼어 낸 뒤로는 렌더 트리 없이
 * 직접 돌릴 수 있다 — 이 파일이 그 분리의 실질적 이득이다.
 */

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    root: { name: "C:\\", path: "C:\\", size: 100, files: 1, isDir: true, children: [], truncated: 0 },
    categories: [],
    totalSize: 100,
    totalFiles: 1,
    totalDirs: 1,
    errors: 0,
    elapsedMs: 10,
    cancelled: false,
    ...over,
  };
}

/** 스캔을 시작해 두고, 백엔드에 넘겨진 진행 이벤트 콜백을 돌려준다. */
async function pending(cancelResult: unknown) {
  let resolveScan: (r: ScanResult) => void = () => {};
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "cancel_scan") {
      return cancelResult instanceof Error
        ? Promise.reject(cancelResult)
        : Promise.resolve(cancelResult);
    }
    return new Promise<ScanResult>((res) => {
      resolveScan = res;
    });
  });

  const onNotify = vi.fn();
  const hook = renderHook(() => useScan({ onNotify }));
  await act(async () => {
    void hook.result.current.startScan("C:\\");
  });
  const emit = listen.mock.calls.find((c) => c[0] === "scan-progress")![1] as (e: {
    payload: unknown;
  }) => void;
  return { hook, emit, onNotify, finish: () => resolveScan(scanResult()) };
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockResolvedValue(() => {});
});

describe("useScan", () => {
  it("결과가 오면 onResult 를 부르고 진행 상태를 내린다", async () => {
    invoke.mockResolvedValue(scanResult());
    const onResult = vi.fn();
    const { result } = renderHook(() => useScan({ onResult }));

    await act(async () => {
      await result.current.startScan("C:\\");
    });

    expect(onResult).toHaveBeenCalledWith("C:\\", expect.objectContaining({ totalSize: 100 }));
    expect(result.current.scanning).toBe(false);
    expect(result.current.result?.totalSize).toBe(100);
  });

  it("startScan 참조는 렌더가 바뀌어도 그대로다", async () => {
    invoke.mockResolvedValue(scanResult());
    const { result, rerender } = renderHook(() => useScan({ onResult: () => {} }));
    const first = result.current.startScan;
    rerender();
    // 이 안정성이 무너지면 자식 패널의 memo 가 무효가 되어 3,000행이 매초 재조정된다.
    expect(result.current.startScan).toBe(first);
  });

  it("이벤트가 역순으로 도착해도 가장 큰 세대를 취소 대상으로 지목한다", async () => {
    const { hook, emit } = await pending(true);
    act(() => {
      emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 7 } });
      emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 5 } });
    });

    await act(async () => {
      await hook.result.current.cancelScan();
    });
    expect(invoke).toHaveBeenCalledWith("cancel_scan", { scanId: 7 });
  });

  it("취소가 기각되면 상태를 되돌리고 알린다", async () => {
    const { hook, onNotify } = await pending(false);
    await act(async () => {
      await hook.result.current.cancelScan();
    });
    expect(hook.result.current.cancelling).toBe(false);
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("반영되지 않았습니다"), "error");
  });

  it("invoke 가 throw 해도 같은 복구가 일어난다", async () => {
    const { hook, onNotify } = await pending(new Error("ipc down"));
    await act(async () => {
      await hook.result.current.cancelScan();
    });
    expect(hook.result.current.cancelling).toBe(false);
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("보내지 못했습니다"), "error");
  });

  it("구버전 백엔드가 null 을 주면 수락된 것으로 두고 중단 상태를 유지한다", async () => {
    const { hook } = await pending(null);
    await act(async () => {
      await hook.result.current.cancelScan();
    });
    await waitFor(() => expect(hook.result.current.cancelling).toBe(true));
  });

  it("진행 중에는 재진입하지 않는다", async () => {
    const { hook } = await pending(true);
    const before = invoke.mock.calls.filter((c) => c[0] === "start_scan").length;
    await act(async () => {
      await hook.result.current.startScan("D:\\");
    });
    expect(invoke.mock.calls.filter((c) => c[0] === "start_scan")).toHaveLength(before);
  });
});
