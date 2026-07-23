import { copyText } from "./export";

/**
 * 탐색기에서 항목 위치를 연다.
 *
 * opener 플러그인 중 쓰는 것은 reveal 하나뿐이다(URL 열기는 이 앱에 필요 없다).
 * 백엔드에서 플러그인이나 권한이 빠져 있으면 호출이 실패하므로, 그때는 경로를
 * 클립보드에 넣어 사용자가 주소창에 붙여 넣을 수 있게 한다.
 */
export async function revealInExplorer(path: string): Promise<"revealed" | "copied" | "failed"> {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
    return "revealed";
  } catch {
    return (await copyText(path)) ? "copied" : "failed";
  }
}
