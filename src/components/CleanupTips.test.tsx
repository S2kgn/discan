import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CleanupTips } from "./CleanupTips";
import { CleanupTip } from "../lib/cleanup";

const GiB = 1024 ** 3;

const tip: CleanupTip = {
  id: "app-cache",
  title: "앱 캐시",
  hint: "앱이 다시 만듭니다.",
  risk: "caution",
  size: 1.57 * GiB,
  count: 80,
  path: "C:\\Users\\a\\AppData\\Local\\Slack\\Cache",
  label: "Slack",
  paths: [
    { path: "C:\\Users\\a\\AppData\\Local\\Slack\\Cache", size: 1.2 * GiB, label: "Slack" },
    { path: "C:\\Users\\a\\AppData\\Local\\Chrome\\Cache", size: 0.37 * GiB, label: "Chrome" },
  ],
  query: "cache",
  isLowerBound: true,
};

describe("CleanupTips", () => {
  it("후보가 없으면 패널 자체를 그리지 않는다", () => {
    const { container } = render(<CleanupTips tips={[]} onReveal={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("합계가 여러 곳을 더한 값이면 나머지에 도달할 길을 준다", async () => {
    const onReveal = vi.fn();
    const onSearch = vi.fn();
    render(<CleanupTips tips={[tip]} onReveal={onReveal} onSearch={onSearch} />);

    // 접힌 상태에서는 대표 한 곳만.
    expect(screen.queryByTitle("C:\\Users\\a\\AppData\\Local\\Chrome\\Cache")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /가장 큰 2곳 보기/ }));
    await userEvent.click(screen.getByTitle("C:\\Users\\a\\AppData\\Local\\Chrome\\Cache"));
    expect(onReveal).toHaveBeenCalledWith("C:\\Users\\a\\AppData\\Local\\Chrome\\Cache");

    // 상위 목록으로 다 담기지 않으면 트리 검색으로 넘긴다.
    await userEvent.click(screen.getByRole("button", { name: /검색/ }));
    expect(onSearch).toHaveBeenCalledWith("cache");
  });

  it("안전 항목이 하나도 없어도 도달점을 낸다", () => {
    // 실사용에서 가장 흔한 후보(캐시·다운로드·.git·가상환경)는 모두 '주의' 등급이라,
    // 안전 합계가 0인 화면이 예외가 아니라 표준이다. 그때 목표치 줄이 통째로
    // 사라지면 이 앱을 켠 이유에 대한 답이 화면 어디에도 없다.
    render(<CleanupTips tips={[tip]} free={933 * GiB} onReveal={() => {}} />);
    expect(screen.getByText(/후보를 모두 정리하면 최대 약/)).toBeInTheDocument();
    expect(screen.getByText(/모두 ‘주의’ 등급이라/)).toBeInTheDocument();
  });

  it("안전 항목이 있으면 두 도달점을 나란히 낸다", () => {
    const safe = { ...tip, id: "temp", risk: "safe" as const, size: 1 * GiB };
    render(<CleanupTips tips={[tip, safe]} free={10 * GiB} onReveal={() => {}} />);
    expect(screen.getByText(/‘안전’ 항목만 정리하면 약 11.0 GiB/)).toBeInTheDocument();
    expect(screen.getByText(/후보를 모두 정리하면 약 12.6 GiB/)).toBeInTheDocument();
  });

  it("접힘 라벨이 실제 표시 개수와 1위의 크기를 함께 가리킨다", () => {
    // '80곳 모두 보기'를 눌러 5곳을 받으면 나머지가 사라졌다고 읽는다.
    // 1위 크기가 없으면 합계가 한 곳에 몰렸는지 흩어졌는지를 펼치기 전에 알 수 없다.
    render(<CleanupTips tips={[tip]} onReveal={() => {}} />);
    const btn = screen.getByRole("button", { name: /곳 보기/ });
    expect(btn.textContent).not.toContain("모두");
    expect(btn.textContent).toContain("전체 80곳");
    expect(btn.textContent).toContain("최대 1.20 GiB");
  });

  it("굵은 식별자는 규칙 이름이 아니라 판별에 쓰이는 조상이다", () => {
    render(<CleanupTips tips={[tip]} onReveal={() => {}} />);
    // 'Cache' 는 규칙에 걸린 모든 항목의 baseName 이라 정보량이 0이다.
    expect(screen.getByText("Slack")).toBeInTheDocument();
  });

  it("후보 합계가 분야 합계와 어긋나는 이유를 같은 문장에서 화해시킨다", () => {
    render(
      <CleanupTips
        tips={[tip]}
        minSize={7 * 1024 * 1024}
        cacheCategory={{ label: "캐시·빌드 산출물", size: 12.8 * GiB }}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText(/이름으로 확실히 알아볼 수 있는 폴더/)).toBeInTheDocument();
    expect(screen.getByText(/‘캐시·빌드 산출물’로 분류된 12.8 GiB 중/)).toBeInTheDocument();
    expect(screen.getByText(/후보 합계 최소/)).toBeInTheDocument();
  });

  it("면책은 호버가 아니라 눌러서 여는 팝오버로 도달한다", async () => {
    render(<CleanupTips tips={[tip]} onReveal={() => {}} />);
    expect(screen.queryByText(/이 앱은 아무것도 지우지 않습니다/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "이 목록을 읽는 조건" }));
    expect(screen.getByText(/이 앱은 아무것도 지우지 않습니다/)).toBeInTheDocument();
  });
});
