/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //
  // 포트는 5173(Vite 기본)이다. 원래 템플릿 기본값 1420 은 Windows 동적 포트
  // '제외 범위'(Hyper-V/WSL 예약, 예: 1387–1486)에 들어가는 순간 vite 가 EACCES 로
  // 죽는다 — 재부팅으로 예약 범위가 옮겨 가면 개발 서버가 통째로 안 뜬다.
  // `netsh int ipv4 show excludedportrange protocol=tcp` 로 확인할 수 있다.
  // 5173 이 제외되면 그때 또 옮기면 되고, tauri.conf.json 의 devUrl 도 함께 바꾼다.
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  /*
   * 두 갈래로 나눈다.
   *
   * 순수 로직(.test.ts)은 node 환경에서 1초 안에 끝나야 하고, 컴포넌트(.test.tsx)는
   * 실제로 렌더해 봐야 한다 — 오류 상자가 "[object Object]" 를 그리는 결함은 렌더
   * 없이는 드러나지 않는 갈래였고, 실제로 그렇게 통과했다.
   */
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "lib",
          environment: "node",
          include: ["src/**/*.test.ts"],
          // 계약 드리프트 테스트가 src-tauri 의 Rust 원본을 ?raw 로 읽는다.
          server: { deps: { inline: [/\.rs$/] } },
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["src/test/setup.ts"],
        },
      },
    ],
  },
}));
