import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TreeView } from "./TreeView";
import { ScanNode } from "../types";

function dir(name: string, over: Partial<ScanNode> = {}): ScanNode {
  return {
    name,
    path: `C:\\${name}`,
    size: 1000,
    files: 10,
    isDir: true,
    children: [],
    truncated: 0,
    ...over,
  };
}

const ROOT: ScanNode = {
  name: "C:\\",
  path: "C:\\",
  size: 3000,
  files: 30,
  isDir: true,
  truncated: 0,
  children: [
    dir("node_modules", {
      children: [dir("react"), dir("vite")],
    }),
    dir("photos"),
  ],
};

const noop = () => {};

describe("검색 중 펼치기", () => {
  it("검색어가 있어도 행 클릭으로 펼치고 접을 수 있다", async () => {
    // 예전에는 검색 중 expanded 를 참조하지 않아 클릭·Enter 가 전부 무반응이었다.
    render(
      <TreeView root={ROOT} query="photos" onRescan={noop} onReveal={noop} onCopyPath={noop} />,
    );

    const row = await screen.findByRole("row", { name: /C:\\/ });
    expect(row).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
  });
});

describe("클릭 반응", () => {
  it("펼치기는 지연 없이 즉시 반영된다", async () => {
    render(<TreeView root={ROOT} onRescan={noop} onReveal={noop} onCopyPath={noop} />);
    const row = screen.getByRole("row", { name: /node_modules/ });
    const before = row.getAttribute("aria-expanded");
    await userEvent.click(row);
    // 220ms 타이머가 있으면 이 시점에는 아직 바뀌지 않는다.
    expect(row.getAttribute("aria-expanded")).not.toBe(before);
  });
});

describe("단축키", () => {
  it("Ctrl+C 는 가로채지 않는다", async () => {
    const onCopyPath = vi.fn();
    render(<TreeView root={ROOT} onRescan={noop} onReveal={noop} onCopyPath={onCopyPath} />);
    const row = screen.getByRole("row", { name: /photos/ });
    row.focus();

    await userEvent.keyboard("{Control>}c{/Control}");
    expect(onCopyPath).not.toHaveBeenCalled();

    await userEvent.keyboard("c");
    expect(onCopyPath).toHaveBeenCalledWith("C:\\photos");
  });

  it("표준 문자가 아닌 행에서 O/C 는 조용한 no-op 대신 이유를 낭독한다", async () => {
    // 예전에는 lossyPath 행에서 O/C 가 알림 없이 return 해, 키보드·낭독 사용자는
    // '왜 안 되는지'를 알 수 없었다. 행 이름에도 조작 불가 사실을 싣는다.
    const onReveal = vi.fn();
    const onCopyPath = vi.fn();
    const lossy: ScanNode = { ...dir("weird"), lossyPath: true };
    render(
      <TreeView
        root={{ ...ROOT, children: [lossy] }}
        onRescan={noop}
        onReveal={onReveal}
        onCopyPath={onCopyPath}
      />,
    );
    const row = screen.getByRole("row", { name: /weird/ });
    // 포커스 낭독만으로 이 행이 조작 불가임이 전달돼야 한다.
    expect(row).toHaveAccessibleName(/열기·복사 불가/);
    row.focus();

    await userEvent.keyboard("o");
    expect(onReveal).not.toHaveBeenCalled();
    await userEvent.keyboard("c");
    expect(onCopyPath).not.toHaveBeenCalled();
    // 라이브 리전으로 이유를 알린다(무피드백 no-op 이 아니다).
    expect(screen.getByText(/열기·복사를 지원하지 않습니다/)).toBeInTheDocument();
  });
});

describe("검색 종료", () => {
  it("검색어를 지우면 검색이 연 조상만 다시 접힌다", async () => {
    // 합쳐 넣기만 하고 되돌리지 않으면, 초기 깊이 2로 정돈돼 있던 트리가 검색을
    // 끝낸 직후에 오히려 더 펼쳐진 상태로 돌아온다.
    const deep: ScanNode = {
      ...dir("node_modules"),
      children: [{ ...dir("react"), children: [dir("dist")] }],
    };
    const root: ScanNode = { ...ROOT, children: [deep, dir("photos")] };

    const { rerender } = render(
      <TreeView root={root} query="dist" onRescan={noop} onReveal={noop} onCopyPath={noop} />,
    );
    // 깊이 2를 넘는 조상이 검색으로 열린다.
    const react = await screen.findByRole("row", { name: /react/ });
    await waitFor(() => expect(react).toHaveAttribute("aria-expanded", "true"));

    rerender(
      <TreeView root={root} query="" onRescan={noop} onReveal={noop} onCopyPath={noop} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("row", { name: /react/ })).toHaveAttribute("aria-expanded", "false"),
    );
  });

  it("사용자가 직접 펼친 노드는 검색을 끝내도 남는다", async () => {
    const root: ScanNode = {
      ...ROOT,
      children: [{ ...dir("node_modules"), children: [{ ...dir("react"), children: [dir("dist")] }] }],
    };
    const { rerender } = render(
      <TreeView root={root} query="dist" onRescan={noop} onReveal={noop} onCopyPath={noop} />,
    );
    const react = await screen.findByRole("row", { name: /react/ });
    await waitFor(() => expect(react).toHaveAttribute("aria-expanded", "true"));

    // 접었다 다시 펴면 그 순간부터 사용자의 상태다.
    await userEvent.click(react);
    await userEvent.click(react);

    rerender(<TreeView root={root} query="" onRescan={noop} onReveal={noop} onCopyPath={noop} />);
    await waitFor(() =>
      expect(screen.getByRole("row", { name: /react/ })).toHaveAttribute("aria-expanded", "true"),
    );
  });
});

describe("키보드 모델", () => {
  it("깊이 제한 행에서 R 키가 재스캔을 부른다", async () => {
    // ⟳ 버튼은 tabIndex=-1 이라 Tab 으로 도달할 수 없고, ↗·⧉ 와 달리 대체 키가 없었다.
    const onRescan = vi.fn();
    const cut: ScanNode = {
      ...dir("deep"),
      truncated: 4,
      truncatedDeep: 4,
      truncatedBytes: 1024,
      truncatedReason: "depth",
    };
    render(
      <TreeView
        root={{ ...ROOT, children: [cut] }}
        onRescan={onRescan}
        onReveal={noop}
        onCopyPath={noop}
      />,
    );
    const row = screen.getByRole("row", { name: /깊이 제한으로/ });
    row.focus();
    await userEvent.keyboard("r");
    expect(onRescan).toHaveBeenCalledWith("C:\\deep");
  });

  it("R 키는 깊이 제한 행이 아닌 곳에서는 아무 일도 하지 않는다", async () => {
    const onRescan = vi.fn();
    render(<TreeView root={ROOT} onRescan={onRescan} onReveal={noop} onCopyPath={noop} />);
    screen.getByRole("row", { name: /photos/ }).focus();
    await userEvent.keyboard("r");
    expect(onRescan).not.toHaveBeenCalled();
  });

  it("Home·End·ArrowLeft 이 실제로 포커스를 옮긴다", async () => {
    render(<TreeView root={ROOT} onRescan={noop} onReveal={noop} onCopyPath={noop} />);
    const first = screen.getByRole("row", { name: /^C:\\/ });
    first.focus();

    await userEvent.keyboard("{End}");
    const last = document.activeElement as HTMLElement;
    expect(last.getAttribute("data-row")).toBe(String(screen.getAllByRole("row").length - 2));

    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(first);

    // node_modules 는 깊이 2까지 펼쳐져 있으므로 자식 행에서 ← 는 부모로 올라간다.
    screen.getByRole("row", { name: /react/ }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("row", { name: /node_modules/ }));
  });

  // 3,001행을 만드는 픽스처라 jsdom 렌더가 수 초 걸린다. userEvent 대신 fireEvent 를
  // 쓰고 타임아웃을 넉넉히 둔다(이 검사가 없어 회귀가 두 번 났다).
  it(
    "행 상한을 넘기면 cap 행이 생기고 로빙 tabindex 가 정확히 하나 남는다",
    () => {
      // End 키가 cap 행을 가리키면서 모든 행의 tabIndex 가 -1 이 되던 회귀가 있었다.
      const many: ScanNode = {
        ...ROOT,
        children: Array.from({ length: 3100 }, (_, i) => ({
          ...dir(`d${i}`),
          path: `C:\\d${i}`,
          size: 3100 - i,
        })),
      };
      const { container } = render(
        <TreeView root={many} onRescan={noop} onReveal={noop} onCopyPath={noop} />,
      );
      expect(screen.getByText(/3,000행까지만 그렸습니다/)).toBeInTheDocument();

      const body = container.querySelector(".tree-body")!;
      const first = body.querySelector<HTMLElement>('[data-row="0"]')!;
      first.focus();
      fireEvent.keyDown(first, { key: "End" });
      expect(body.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    },
    30_000,
  );
});

describe("생략 행", () => {
  it("사유가 둘이어도 생략된 바이트가 화면에서 사라지지 않는다", () => {
    const node: ScanNode = {
      name: "big",
      path: "C:\\big",
      size: 5000,
      files: 5000,
      isDir: true,
      truncated: 5270,
      truncatedBytes: 1024 * 1024 * 300,
      truncatedSmall: 280,
      truncatedCapped: 4990,
      children: [],
    };
    render(
      <TreeView
        root={{ ...ROOT, children: [node] }}
        onRescan={noop}
        onReveal={noop}
        onCopyPath={noop}
      />,
    );

    expect(screen.getByText(/표시 한도로 4,990개/)).toBeInTheDocument();
    expect(screen.getByText(/용량이 작아 280개/)).toBeInTheDocument();
    // 부모 용량과 보이는 자식 합의 차액이 설명되지 않은 채 남으면 안 된다.
    expect(screen.getByText(/이 폴더에서 생략된 합계/)).toBeInTheDocument();
  });
});
