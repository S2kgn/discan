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
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
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
