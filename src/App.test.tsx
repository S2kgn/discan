import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App, { pickDefaultDrive } from "./App";
import { DriveInfo, ScanResult } from "./types";

/**
 * 렌더 계층 회귀 방어.
 *
 * 순수 함수는 촘촘히 덮여 있었지만 컴포넌트는 한 줄도 실행되지 않았고, 그래서
 * '모든 오류가 [object Object]' 라는 결함이 그대로 통과했다. 여기서 잠그는 것은
 * 그런 갈래 — 렌더하지 않으면 드러나지 않는 것들이다.
 */

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const DRIVES: DriveInfo[] = [
  { path: "C:\\", label: "로컬 디스크 (C:)", total: 1000, free: 100, driveType: "fixed" },
  { path: "Z:\\", label: "네트워크 (Z:)", total: 500, free: 400, driveType: "remote" },
];

/**
 * 오류 상자. sr-only 라이브 리전도 role="alert" 이라 역할만으로는 지목되지 않는다
 * (그 둘이 같은 문구를 갖는 것이 바로 이중 낭독 결함이었다).
 */
async function findErrorBox(): Promise<HTMLElement> {
  return await waitFor(() => {
    const box = document.querySelector<HTMLElement>(".error-box");
    if (!box) throw new Error("오류 상자가 아직 없습니다");
    return box;
  });
}

function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    root: { name: "C:\\", path: "C:\\", size: 100, files: 1, isDir: true, children: [], truncated: 0 },
    categories: [{ key: "video", size: 100, files: 1 }],
    totalSize: 100,
    totalFiles: 1,
    totalDirs: 1,
    errors: 0,
    elapsedMs: 10,
    cancelled: false,
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  localStorage.clear();
});

describe("오류 표시", () => {
  it("CommandError 객체로 reject 되면 코드에 대응하는 문구가 나온다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.reject({
        code: "uncRejected",
        detail: "\\\\localhost\\share",
        message: "네트워크(UNC) 경로는 분석할 수 없습니다.",
      });
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "\\\\localhost\\share{Enter}");

    const box = await findErrorBox();
    expect(box).toHaveTextContent("네트워크(UNC) 경로는 분석할 수 없습니다");
    // 이 한 줄이 이번 라운드의 critical 을 통째로 막는다.
    expect(box.textContent).not.toContain("[object Object]");
    // 문제가 된 경로가 화면에 남아야 감사 기록이 성립한다.
    expect(box.textContent).toContain("localhost");
  });

  it("되돌릴 수 없는 오류에는 '다시 시도'를 주지 않는다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.reject({ code: "remoteDrive", detail: "Z:\\", message: "" });
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "Z:\\x{Enter}");

    await findErrorBox();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(screen.getByRole("button", { name: "다른 경로 선택" })).toBeInTheDocument();
  });

  it("재진입 방어(busy)는 빨간 오류가 아니라 완화된 상자로 뜬다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.reject({ code: "busy", detail: "", message: "" });
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    const box = await findErrorBox();
    expect(box.className).toContain("benign");
    // 되풀이해도 결과가 같으므로 버튼을 주지 않는다.
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });
});

describe("드라이브 카드", () => {
  it("스캔이 거부될 드라이브는 비활성으로 렌더된다", async () => {
    invoke.mockResolvedValue(DRIVES);
    render(<App />);

    const blocked = await screen.findByRole("button", { name: /네트워크 \(Z:\)/ });
    expect(blocked).toBeDisabled();
    expect(screen.getByRole("button", { name: /로컬 디스크 \(C:\)/ })).toBeEnabled();
  });
});

describe("결과 렌더", () => {
  it("중단된 결과에는 ≥ 표식과 부분 집계 경고가 함께 나온다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(scanResult({ cancelled: true }));
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    await waitFor(() => expect(screen.getByText("총 용량")).toBeInTheDocument());
    expect(screen.getByText(/사용자 중단으로 부분 집계/)).toBeInTheDocument();
    expect(screen.getByText(/≥/)).toBeInTheDocument();
  });

  it("결과가 나오면 '다시 스캔' 버튼이 화면에 하나만 남는다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(scanResult());
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    await waitFor(() => expect(screen.getByText("총 용량")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "다시 스캔" })).toHaveLength(1);
  });

  it("집계 조건은 접힌 채로 시작하되 요약 한 줄은 보인다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(scanResult());
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    const summary = await screen.findByText(/이 숫자는 어떻게 셌나요/);
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });
});

describe("내보내기 팝오버", () => {
  it("Escape 로 닫히고 포커스가 트리거로 돌아온다", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(scanResult());
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    const trigger = await screen.findByRole("button", { name: "내보내기 ▾" });
    await userEvent.click(trigger);
    expect(screen.getByRole("button", { name: /폴더별 표 \(CSV\)/ })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: /폴더별 표 \(CSV\)/ })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("검색어 초기화", () => {
  it("다른 경로를 스캔하면 이전 스캔의 트리 검색어가 남지 않는다", async () => {
    // 남아 있으면 새 결과가 이전 필터로 걸러진 채 그려지고, 그 이름이 없는 대상에서는
    // '일치하는 항목이 없습니다'만 보여 사용자가 스캔 실패로 읽는다.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(scanResult());
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    const search = await screen.findByLabelText("폴더·파일 이름 검색");
    await userEvent.type(search, "cache");
    expect(search).toHaveValue("cache");

    await userEvent.click(screen.getByRole("button", { name: "경로 변경" }));
    const target = screen.getByLabelText("분석할 경로");
    await userEvent.clear(target);
    await userEvent.type(target, "D:\\{Enter}");

    await waitFor(() =>
      expect(screen.getByLabelText("폴더·파일 이름 검색")).toHaveValue(""),
    );
  });
});

describe("빈 결과", () => {
  it("읽지 못한 항목이 있으면 '파일이 없습니다'라고 단정하지 않는다", async () => {
    // 접근 거부된 폴더를 대상으로 잡으면 total_files=0 · root.incomplete=true 로 온다.
    // 그때 '비어 있다'고 적으면 사용자가 얻는 1차 결론이 거짓이 된다.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(
        scanResult({
          totalSize: 0,
          totalFiles: 0,
          errors: 1,
          dirErrors: 1,
          failedPaths: [{ path: "C:\\System Volume Information", kind: "denied" }],
          root: {
            name: "System Volume Information",
            path: "C:\\System Volume Information",
            size: 0,
            files: 0,
            isDir: true,
            children: [],
            truncated: 0,
            incomplete: true,
          },
        }),
      );
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\System Volume Information{Enter}");

    await waitFor(() => expect(screen.getByText("총 용량")).toBeInTheDocument());
    expect(screen.queryByText(/이 경로에는 파일이 없습니다/)).toBeNull();
    expect(screen.getByText(/이 경로를 읽지 못해 내용을 확인할 수 없습니다/)).toBeInTheDocument();
    // 하한 표식은 취소된 결과에만 붙던 것이라, '읽지 못해 0' 인 결과에는 없었다.
    expect(screen.getByText(/≥/)).toBeInTheDocument();
  });

  it("사용자가 중단한 스캔에 '읽지 못했다'는 틀린 원인을 붙이지 않는다", async () => {
    // 시작 직후(resolve_root 구간) 중단하면 cancelled=true · totalFiles=0 ·
    // root.incomplete=true 이면서 errors 는 0으로 온다. 위쪽 notice 는 '사용자 중단'
    // 이라고 맞게 적고 있어, 같은 화면에서 두 문장이 서로 다른 원인을 말하게 된다.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(
        scanResult({
          cancelled: true,
          totalSize: 0,
          totalFiles: 0,
          totalDirs: 0,
          root: {
            name: "D:\\",
            path: "D:\\",
            size: 0,
            files: 0,
            isDir: true,
            children: [],
            truncated: 0,
            incomplete: true,
          },
        }),
      );
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "D:\\{Enter}");

    await waitFor(() => expect(screen.getByText("총 용량")).toBeInTheDocument());
    expect(screen.queryByText(/이 경로를 읽지 못해/)).toBeNull();
    expect(screen.getByText(/중단하여 집계된 내용이 없습니다/)).toBeInTheDocument();
  });

  it("파일이 없고 폴더만 있으면 폴더별 용량 패널이 남는다", async () => {
    // '폴더 312' 를 지표에 띄우면서 폴더 목록은 어디에도 없는 화면이 되면,
    // 무엇이 312개인지 확인할 길이 없는데 CSV 는 여전히 312행을 담는다.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      return Promise.resolve(
        scanResult({
          totalSize: 0,
          totalFiles: 0,
          totalDirs: 2,
          categories: [],
          root: {
            name: "C:\\",
            path: "C:\\",
            size: 0,
            files: 0,
            isDir: true,
            truncated: 0,
            children: [
              { name: "empty", path: "C:\\empty", size: 0, files: 0, isDir: true, children: [], truncated: 0 },
            ],
          },
        }),
      );
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    await waitFor(() => expect(screen.getByText("총 용량")).toBeInTheDocument());
    expect(screen.getByText("폴더별 용량")).toBeInTheDocument();
    expect(screen.queryByText(/이 경로에는 파일이 없습니다/)).toBeNull();
  });
});

describe("재스캔 중 이전 결과", () => {
  it("포인터뿐 아니라 키보드·접근성 트리에서도 차단된다", async () => {
    // pointer-events:none 만으로는 Tab 포커스와 Enter 활성화가 그대로 들어가,
    // 흐려진 옛 결과에서 내보내기를 눌러 새 스캔과 무관한 스냅샷을 저장할 수 있었다.
    let resolveSecond: (r: ScanResult) => void = () => {};
    let call = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      call += 1;
      if (call === 1) return Promise.resolve(scanResult());
      return new Promise<ScanResult>((res) => {
        resolveSecond = res;
      });
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");
    await waitFor(() => expect(screen.getByText("총 용량")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "다시 스캔" }));
    await waitFor(() => {
      const results = document.querySelector(".results")!;
      expect(results.hasAttribute("inert")).toBe(true);
    });
    resolveSecond(scanResult());
  });
});

/**
 * 취소는 상태가 가장 복잡한 축인데 테스트가 한 건도 없었다.
 * listen 이 이미 mock 이라 진행 이벤트 콜백을 직접 부르면 네 갈래를 모두 덮을 수 있다.
 */
describe("취소", () => {
  /** 스캔을 시작해 두고, 백엔드에 넘겨진 진행 이벤트 콜백을 돌려준다. */
  async function startPendingScan(cancelResult: unknown) {
    let resolveScan: (r: ScanResult) => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_drives") return Promise.resolve(DRIVES);
      if (cmd === "cancel_scan") {
        return cancelResult instanceof Error
          ? Promise.reject(cancelResult)
          : Promise.resolve(cancelResult);
      }
      return new Promise<ScanResult>((res) => {
        resolveScan = res;
      });
    });

    render(<App />);
    const input = await screen.findByLabelText("분석할 경로");
    await userEvent.clear(input);
    await userEvent.type(input, "C:\\{Enter}");

    const emit = await waitFor(() => {
      const call = listen.mock.calls.find((c) => c[0] === "scan-progress");
      if (!call) throw new Error("진행 리스너가 아직 없습니다");
      return call[1] as (e: { payload: unknown }) => void;
    });
    return { emit, finish: () => resolveScan(scanResult()) };
  }

  it("이벤트가 역순으로 도착해도 가장 큰 세대를 취소 대상으로 지목한다", async () => {
    const { emit } = await startPendingScan(true);
    emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 7 } });
    emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 5 } });

    await userEvent.click(await screen.findByRole("button", { name: "중단" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("cancel_scan", { scanId: 7 }),
    );
  });

  it("취소가 기각되면 버튼이 '중단'으로 되돌아오고 오류를 알린다", async () => {
    const { emit } = await startPendingScan(false);
    emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 1 } });

    await userEvent.click(await screen.findByRole("button", { name: "중단" }));
    // 시각 토스트와 sr-only 경보 리전이 같은 문장을 갖는다(낭독 채널은 하나뿐이다).
    expect(await screen.findAllByText(/중단 요청이 반영되지 않았습니다/)).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "중단" })).toBeEnabled());
  });

  it("invoke 가 throw 해도 같은 복구가 일어난다", async () => {
    const { emit } = await startPendingScan(new Error("ipc down"));
    emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 1 } });

    await userEvent.click(await screen.findByRole("button", { name: "중단" }));
    expect(await screen.findAllByText(/중단 요청을 보내지 못했습니다/)).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "중단" })).toBeEnabled());
  });

  it("구버전 백엔드가 null 을 주면 수락된 것으로 두고 중단 상태를 유지한다", async () => {
    const { emit } = await startPendingScan(null);
    emit({ payload: { files: 1, dirs: 1, bytes: 1, errors: 0, scanId: 1 } });

    await userEvent.click(await screen.findByRole("button", { name: "중단" }));
    expect(await screen.findByRole("button", { name: "중단 중…" })).toBeDisabled();
  });
});

describe("pickDefaultDrive", () => {
  it("스캔 가능한 고정 디스크 중 사용률이 가장 높은 것을 고른다", () => {
    expect(pickDefaultDrive(DRIVES)).toBe("C:\\");
  });

  it("쓸 수 있는 드라이브가 없으면 첫 항목으로 떨어진다", () => {
    expect(pickDefaultDrive([DRIVES[1]])).toBe("Z:\\");
  });

  it("빈 목록에서는 null", () => {
    expect(pickDefaultDrive([])).toBeNull();
  });
});
