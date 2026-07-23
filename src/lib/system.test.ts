import { describe, expect, it } from "vitest";
import { systemFileNote } from "./system";

describe("systemFileNote", () => {
  it("페이지·최대절전 파일에 대체 수단을 함께 준다", () => {
    expect(systemFileNote("C:\\pagefile.sys")!.detail).toContain("가상 메모리");
    expect(systemFileNote("C:\\hiberfil.sys")!.detail).toContain("powercfg");
  });

  it("Windows 하위와 휴지통을 구분해 안내한다", () => {
    expect(systemFileNote("C:\\Windows\\WinSxS\\big.dll")!.label).toBe("시스템 파일");
    expect(systemFileNote("C:\\$Recycle.Bin\\S-1-5\\$RABC.zip")!.label).toBe("휴지통");
  });

  it("이름이 비슷한 사용자 폴더를 시스템으로 오인하지 않는다", () => {
    // 경로 구성요소 단위로 봐야 D:\MyWindowsBackup 이 시스템 파일로 잡히지 않는다.
    expect(systemFileNote("D:\\MyWindowsBackup\\a.zip")).toBeNull();
    expect(systemFileNote("D:\\Movies\\pagefile.sys.bak")).toBeNull();
  });

  it("일반 파일에는 아무 배지도 붙지 않는다", () => {
    expect(systemFileNote("D:\\Videos\\holiday.mp4")).toBeNull();
  });
});
