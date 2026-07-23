import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * jsdom 에 없는 것들의 최소 대역.
 *
 * ResizeObserver 는 CategorySummary 가 세그먼트 라벨의 실측 폭을 재는 데 쓰고,
 * scrollIntoView 는 정리 후보 카드가 트리로 이동시킬 때 쓴다. 없으면 렌더 자체가
 * 예외로 죽어 테스트가 무엇을 검증하는지 알 수 없게 된다.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

afterEach(() => cleanup());
