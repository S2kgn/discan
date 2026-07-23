import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CategorySummary, labelWidthPx } from "./CategorySummary";

const GiB = 1024 ** 3;

const categories = [
  { key: "cache", size: 10 * GiB, files: 23257 },
  { key: "other", size: 2 * GiB, files: 15000 },
];
const contentCategories = [{ key: "code", size: 12 * GiB, files: 38257 }];
const extensions = [
  { ext: "mp4", size: 8 * GiB, files: 10 },
  { ext: "__overflow", size: 4 * GiB, files: 100 },
];

function renderPanel() {
  return render(
    <CategorySummary
      categories={categories}
      contentCategories={contentCategories}
      extensions={extensions}
      totalSize={12 * GiB}
      errors={0}
    />,
  );
}

describe("축 전환", () => {
  it("제목과 차트 대체 텍스트가 축을 따라간다", async () => {
    renderPanel();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("분야별 구성");
    expect(screen.getByRole("img")).toHaveAccessibleName("분야별 용량 비중");

    await userEvent.click(screen.getByRole("button", { name: "확장자" }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("확장자별 구성");
    expect(screen.getByRole("img")).toHaveAccessibleName("확장자별 용량 비중");
  });

  it("확장자 개수에 잔여 합산 행을 넣지 않는다", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "확장자" }));
    // 배열 길이는 2지만 개별 확장자는 하나뿐이다.
    expect(screen.getByText(/용량 상위 1개 확장자/)).toBeInTheDocument();
    // 백엔드의 ASCII 센티널이 화면에 그대로 나가지 않는다.
    expect(screen.queryByText("__overflow")).toBeNull();
    expect(screen.getByText("그 밖의 확장자")).toBeInTheDocument();
  });
});

describe("1위 분야 주의", () => {
  it("'캐시를 지우면 다 생긴다'는 오해를 툴팁이 아닌 본문으로 막는다", async () => {
    renderPanel();
    const warn = screen.getByText(/지워도 되는 것은 아닙니다/);
    expect(warn).toBeVisible();

    // 그 문장에서 곧바로 '내용 기준' 축으로 넘어갈 수 있어야 탭의 용도까지 학습된다.
    await userEvent.click(screen.getByRole("button", { name: "내용 기준으로 확인" }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("내용 기준 구성");
  });
});

describe("'기타' 분해", () => {
  /**
   * 힌트 축(result.categories)의 키를 ExtStat.category 로 조인하면 모집단이 다르다 —
   * ext_category() 는 디렉터리 힌트를 적용하지 않으므로 '캐시 12 GiB' 에서 확장자로
   * 넘어가면 전혀 다른 부분집합이 답으로 돌아간다. 조인은 내용 기준 축에서만 연다.
   */
  it("힌트 축에서는 확장자 교차 대신 축 전환만 시킨다", async () => {
    render(
      <CategorySummary
        categories={[{ key: "other", size: 12 * GiB, files: 15000 }]}
        contentCategories={[{ key: "other", size: 12 * GiB, files: 15000 }]}
        extensions={[{ ext: "bin", size: 8 * GiB, files: 10, category: "other" }]}
        totalSize={12 * GiB}
        errors={0}
      />,
    );

    expect(screen.queryByRole("button", { name: /확장자로 보기/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /내용 기준으로 분해/ }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("내용 기준 구성");
  });

  it("내용 기준 축에서는 그 분야의 확장자만 좁혀 보여 준다", async () => {
    render(
      <CategorySummary
        categories={[{ key: "other", size: 12 * GiB, files: 15000 }]}
        contentCategories={[{ key: "other", size: 8 * GiB, files: 10 }]}
        extensions={[
          { ext: "bin", size: 8 * GiB, files: 10, category: "other" },
          { ext: "mp4", size: 4 * GiB, files: 2, category: "video" },
        ]}
        totalSize={12 * GiB}
        errors={0}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "내용 기준" }));
    await userEvent.click(screen.getByRole("button", { name: /기타 — 확장자로 보기/ }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("확장자별 구성");
    expect(screen.getByText("bin")).toBeInTheDocument();
    expect(screen.queryByText("mp4")).toBeNull();
    // 분모가 걸러낸 합계로 바뀌었음을 문장으로 밝혀야 막대와 목록이 어긋나지 않는다.
    expect(screen.getByText(/이 분야 안에서의 비중/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(screen.getByText("mp4")).toBeInTheDocument();
  });

  it("상위 목록에 없는 분야에는 실패가 예정된 링크를 주지 않는다", async () => {
    render(
      <CategorySummary
        categories={[{ key: "font", size: 12 * GiB, files: 3 }]}
        contentCategories={[{ key: "font", size: 12 * GiB, files: 3 }]}
        extensions={[{ ext: "mp4", size: 4 * GiB, files: 2, category: "video" }]}
        totalSize={12 * GiB}
        errors={0}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "내용 기준" }));
    expect(screen.queryByRole("button", { name: /확장자로 보기/ })).toBeNull();
  });
});

describe("라벨 실폭 추정", () => {
  it("한글 라벨의 추정 폭이 실제 advance 이상이다", () => {
    // 글자당 8px 고정이던 시절에는 추정이 실폭의 70% 라, 잘릴 라벨을 거르려던 판정이
    // 오히려 '캐시·빌드 산…'을 통과시켰다. 전각은 폰트 크기(11px) 이상으로 잡는다.
    const label = "캐시·빌드 산출물";
    expect(labelWidthPx(label)).toBeGreaterThanOrEqual(label.length * 11);
    // 반각은 과대 추정으로 라벨을 통째로 숨기지 않도록 좁게 잡는다.
    expect(labelWidthPx("mp4")).toBeLessThan(labelWidthPx("영상"));
  });
});

describe("열 머리글", () => {
  it("수치 열의 의미가 목록 위에 적혀 있다", () => {
    renderPanel();
    expect(screen.getByText("비중")).toBeInTheDocument();
    expect(screen.getByText("용량")).toBeInTheDocument();
  });
});
