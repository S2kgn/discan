import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "./App";
import { DriveInfo, ScanResult } from "./types";

/**
 * 진행 이벤트가 결과 패널을 다시 그리지 않는지 확인한다.
 *
 * 백엔드 송신 스레드는 150ms마다 진행을 방출하고, 재스캔 중에도 이전 결과는
 * 의도적으로 유지된다(레이아웃이 튀지 않아야 비교가 된다). memo 가 없거나 콜백이
 * 매 렌더 새로 만들어지면 최대 3,000행 트리가 초당 6~7회 재조정되어, 스캔이 가장
 * 무거운 순간에 UI 스레드를 그만큼 뺏긴다 — 중단 버튼 반응이 늦어지는 원인이다.
 * TreeView 를 스파이로 갈아 끼워 렌더 횟수를 직접 센다.
 */

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const treeRender = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./components/TreeView", async () => {
  const { memo } = await import("react");
  return {
    TreeView: memo(function TreeViewSpy() {
      treeRender();
      return <div data-testid="tree" />;
    }),
  };
});

const DRIVES: DriveInfo[] = [
  { path: "C:\\", label: "로컬 디스크 (C:)", total: 1000, free: 100, driveType: "fixed" },
];

const RESULT: ScanResult = {
  root: { name: "C:\\", path: "C:\\", size: 100, files: 1, isDir: true, children: [], truncated: 0 },
  categories: [{ key: "video", size: 100, files: 1 }],
  totalSize: 100,
  totalFiles: 1,
  totalDirs: 1,
  errors: 0,
  elapsedMs: 10,
  cancelled: false,
};

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  treeRender.mockReset();
  listen.mockResolvedValue(() => {});
  localStorage.clear();
});

describe("진행 이벤트", () => {
  it("재스캔 중 진행이 갱신돼도 결과 트리는 다시 그리지 않는다", async () => {
    let pending: (r: ScanResult) => void = () => {};
    let done = false;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      if (done) {
        return new Promise<ScanResult>((res) => {
          pending = res;
        });
      }
      done = true;
      return Promise.resolve(RESULT);
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");
    await screen.findByTestId("tree");

    // 재스캔을 걸어 두면 이전 결과가 그대로 마운트된 채 진행 이벤트가 들어온다.
    await userEvent.click(screen.getByRole("button", { name: "다시 스캔" }));
    const emit = await waitFor(() => {
      const call = listen.mock.calls.find((c) => c[0] === "scan-progress");
      if (!call) throw new Error("진행 리스너가 아직 없습니다");
      return call[1] as (e: { payload: unknown }) => void;
    });

    const before = treeRender.mock.calls.length;
    for (let i = 1; i <= 20; i += 1) {
      emit({ payload: { files: i, dirs: i, bytes: i * 1024, errors: 0, scanId: 1 } });
    }
    await waitFor(() => expect(screen.getByText(/20개 파일/)).toBeInTheDocument());
    expect(treeRender.mock.calls.length).toBe(before);

    pending(RESULT);
  });
});
