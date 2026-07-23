import { describe, expect, it } from "vitest";
// Vite 의 ?raw 로 읽는다. @types/node 를 의존성에 추가하지 않고도 원본 소스를 볼 수 있다.
import scanRs from "../../src-tauri/src/scan.rs?raw";
import libRs from "../../src-tauri/src/lib.rs?raw";
import categoryRs from "../../src-tauri/src/category.rs?raw";
import typesTs from "../types.ts?raw";
import useScanTs from "./useScan.ts?raw";
import appTsx from "../App.tsx?raw";
import { CATEGORY_COLORS, ScanResult } from "../types";
import { BACKEND_ERROR_CODES, errorDetail, friendlyError } from "./errors";
import {
  allocBasisOf,
  allocatedNote,
  basisLines,
  describeCoverage,
  FAILED_KIND_HINTS,
  FAILED_KIND_LABELS,
  totalFootnote,
} from "./notice";

/**
 * 경계 타입 드리프트 감시.
 *
 * types.ts 는 Rust 구조체를 손으로 옮겨 적은 것이라 필드가 하나 늘어도 컴파일러가
 * 아무 말도 하지 않는다. 실제로 그 침묵 때문에 skippedCloud·failedPaths·extensions 가
 * IPC 로 실려 오면서도 화면에 도달하지 못했다. 근본 해결은 ts-rs/specta 로 .d.ts 를
 * 생성하는 것이지만 그것은 Rust 빌드 파이프라인 변경이라, 그 전까지는 두 정의의
 * 직렬화 키 목록을 나란히 비교해 다음 드리프트를 테스트 실패로 만든다.
 */

/** Rust 구조체가 실제로 내보내는 JSON 키. serde(rename) 이 있으면 그쪽이 진짜 이름이다. */
function rustKeys(src: string, structName: string): string[] {
  const start = src.indexOf(`struct ${structName} {`);
  if (start < 0) throw new Error(`Rust 구조체를 찾지 못했습니다: ${structName}`);
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);

  const keys: string[] = [];
  let renamed: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const rename = /#\[serde\(rename\s*=\s*"([^"]+)"\)\]/.exec(line);
    if (rename) {
      renamed = rename[1];
      continue;
    }
    if (line.startsWith("#[") || line.startsWith("//")) continue;
    const field = /^(?:pub\s+)?([a-z_0-9]+)\s*:/.exec(line);
    if (field) {
      keys.push(renamed ?? field[1]);
      renamed = null;
    }
  }
  return keys;
}

/** TS 인터페이스가 선언한 속성 이름. */
function tsKeys(src: string, name: string): string[] {
  const start = src.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`TS 인터페이스를 찾지 못했습니다: ${name}`);
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]);
}

describe("IPC 계약", () => {
  it.each([
    ["ScanResult", "ScanResult", () => scanRs],
    ["Node", "ScanNode", () => scanRs],
    ["FileEntry", "LargeFile", () => scanRs],
    ["ExtStat", "ExtStat", () => scanRs],
    ["FailedPath", "FailedPath", () => scanRs],
    ["CategoryStat", "CategoryStat", () => scanRs],
    ["PruneParams", "PruneParams", () => scanRs],
    ["DriveInfo", "DriveInfo", () => libRs],
    ["ProgressPayload", "ScanProgress", () => libRs],
    // 오류 구조체가 목록에서 빠져 있던 탓에 모든 오류가 "[object Object]" 로
    // 표시되는 회귀가 그대로 통과했다. 계약 감시는 성공 경로만의 것이 아니다.
    ["CommandError", "CommandError", () => libRs],
  ])("Rust %s 의 모든 직렬화 키가 TS %s 에 있다", (rustName, tsName, source) => {
    const missing = rustKeys(source(), rustName).filter(
      (k) => !tsKeys(typesTs, tsName).includes(k),
    );
    expect(missing, `TS ${tsName} 에 없는 백엔드 필드: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * 오류 코드는 구조체 키가 아니라 값이라 위 검사에 걸리지 않는다.
   * lib.rs 의 `CommandError::new("<code>", ...)` 호출을 그대로 긁어 대조한다.
   */
  it("백엔드가 만드는 모든 오류 코드가 프런트 사전에 있다", () => {
    const emitted = new Set(
      [...libRs.matchAll(/CommandError::new\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
    );
    expect(emitted.size, "lib.rs 에서 CommandError 를 찾지 못했습니다").toBeGreaterThan(0);
    const missing = [...emitted].filter((c) => !BACKEND_ERROR_CODES.includes(c as never));
    expect(missing, `errors.ts 에 없는 코드: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * FailedPath.kind 는 구조체 '키'가 아니라 '값'이라 위 검사에 걸리지 않는다.
   * 실제로 그 침묵 때문에 백엔드가 새로 만든 notReady·locked 가 프런트 사전에
   * 없는 채 CI 를 통과했고, 한국어 UI 한복판에 영문 키가 배지로 찍히면서
   * 원인을 정확히 아는 오류에 '원인을 특정하지 못했습니다'가 안내됐다.
   * error_kind 의 `=> "<kind>"` 리터럴과 record_failure 인자를 그대로 긁어 대조한다.
   */
  it("백엔드가 만드는 모든 실패 갈래가 프런트 사전에 있다", () => {
    // error_kind 함수 본문만 잘라 낸다 — 파일 전체를 긁으면 무관한 문자열 매치가 섞인다.
    const fnStart = scanRs.indexOf("fn error_kind(");
    expect(fnStart, "scan.rs 에서 error_kind 를 찾지 못했습니다").toBeGreaterThan(0);
    const fnBody = scanRs.slice(fnStart, scanRs.indexOf("\n}", fnStart));

    const emitted = new Set<string>([
      ...[...fnBody.matchAll(/=>\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
      ...[...scanRs.matchAll(/record_failure\([^)]*?,\s*"([a-zA-Z]+)"\s*\)/g)].map((m) => m[1]),
      // `return "tooLong";` 같은 이른 반환도 갈래를 만든다.
      ...[...fnBody.matchAll(/return\s+"([a-zA-Z]+)"/g)].map((m) => m[1]),
    ]);
    expect(emitted.size, "scan.rs 에서 실패 갈래 리터럴을 찾지 못했습니다").toBeGreaterThan(4);

    const known = Object.keys(FAILED_KIND_LABELS);
    const missing = [...emitted].filter((k) => !known.includes(k));
    expect(missing, `notice.ts 사전에 없는 갈래: ${missing.join(", ")}`).toEqual([]);
    // 라벨만 있고 처방이 없으면 화면은 사유를 말하고도 조치를 말하지 못한다.
    expect(Object.keys(FAILED_KIND_HINTS).sort()).toEqual(known.sort());
    // 유니온 자체도 대조한다 — 사전만 늘리고 타입을 두면 다음 사람이 헷갈린다.
    const union = /export type FailedKind =([\s\S]*?);/.exec(typesTs)?.[1] ?? "";
    const declared = [...union.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(known.sort());
  });

  /**
   * 커맨드 이름과 **인자 이름**. 여기가 어긋나면 컴파일은 모두 통과하고 런타임에만
   * 호출이 실패한다(Tauri 2 는 JS 의 camelCase 를 Rust 의 snake_case 로 바꿔 받는다).
   *
   * 프런트가 실제로 부르는 호출을 표로 적고, Rust 쪽은 원본에서 긁어 대조한다 —
   * 표만 있으면 그것 역시 손으로 맞춘 미러가 되어 같은 드리프트를 반복한다.
   */
  const FRONTEND_CALLS: { cmd: string; args: string[] }[] = [
    { cmd: "list_drives", args: [] },
    { cmd: "start_scan", args: ["path"] },
    // scanId 는 Option 이라 생략될 수 있다(세대를 모를 때 `{}` 로 부른다).
    { cmd: "cancel_scan", args: ["scanId"] },
  ];

  /** Tauri 2 의 인자 이름 변환 규칙. */
  const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  /** `#[tauri::command]` 이 붙은 함수의 이름과 인자(주입 인자 제외). */
  function rustCommands(): { name: string; params: { name: string; ty: string }[] }[] {
    const out: { name: string; params: { name: string; ty: string }[] }[] = [];
    for (const m of libRs.matchAll(
      /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g,
    )) {
      const params = m[2]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const [name, ...rest] = p.split(":");
          return { name: name.trim(), ty: rest.join(":").trim() };
        })
        // AppHandle·State·Window 는 Tauri 가 주입한다. 프런트가 보내는 인자가 아니다.
        .filter((p) => !/AppHandle|State\s*<|Window/.test(p.ty));
      out.push({ name: m[1], params });
    }
    return out;
  }

  it("프런트가 부르는 커맨드가 invoke_handler 에 등록되어 있다", () => {
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(libRs)?.[1] ?? "";
    const registered = handler
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(registered.length).toBeGreaterThan(0);
    for (const { cmd } of FRONTEND_CALLS) {
      expect(registered, `invoke_handler 에 없는 커맨드: ${cmd}`).toContain(cmd);
    }
  });

  it("프런트가 보내는 인자 이름이 Rust 인자와 (camelCase→snake_case) 대응한다", () => {
    const commands = new Map(rustCommands().map((c) => [c.name, c.params]));
    for (const { cmd, args } of FRONTEND_CALLS) {
      const params = commands.get(cmd);
      expect(params, `lib.rs 에 없는 커맨드: ${cmd}`).toBeDefined();
      const names = params!.map((p) => p.name);
      for (const a of args) {
        expect(names, `${cmd} 에 없는 인자: ${a} (→ ${toSnake(a)})`).toContain(toSnake(a));
      }
      // Option 이 아닌 인자를 프런트가 빠뜨리면 호출 자체가 실패한다.
      const required = params!.filter((p) => !p.ty.startsWith("Option<")).map((p) => p.name);
      const sent = args.map(toSnake);
      expect(required.filter((r) => !sent.includes(r)), `${cmd} 의 필수 인자 누락`).toEqual([]);
    }
  });

  it("소스에 있는 모든 invoke 호출이 위 표에 있다", () => {
    // 표에 없는 호출이 늘면 그 커맨드는 아무 대조도 받지 못한 채 배포된다.
    const called = new Set(
      [useScanTs, appTsx].flatMap((src) =>
        [...src.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]),
      ),
    );
    expect(called.size).toBeGreaterThan(0);
    const known = FRONTEND_CALLS.map((c) => c.cmd);
    expect([...called].filter((c) => !known.includes(c))).toEqual([]);
  });

  it("백엔드가 emit 하는 이벤트 이름과 프런트가 listen 하는 이름이 같다", () => {
    // 이름이 한 글자만 달라도 진행률이 영원히 0으로 남고, 아무 오류도 나지 않는다.
    const emitted = new Set(
      [...libRs.matchAll(/\.emit\(\s*"([a-zA-Z-]+)"/g)].map((m) => m[1]),
    );
    const listened = new Set(
      [useScanTs, appTsx].flatMap((src) =>
        [...src.matchAll(/listen(?:<[^>]*>)?\(\s*"([a-zA-Z-]+)"/g)].map((m) => m[1]),
      ),
    );
    expect(emitted.size, "lib.rs 에서 emit 을 찾지 못했습니다").toBeGreaterThan(0);
    expect([...listened].sort()).toEqual([...emitted].sort());
  });

  /**
   * 구조체 '키'가 아니라 '값'으로 분기하는 필드들.
   *
   * 3라운드의 "[object Object]" 와 같은 갈래의 결함이다 — 백엔드가 값 집합을 늘려도
   * 키 대조는 초록이고 tsc 도 통과하는데, 화면에서는 그 값을 비교하던 분기가 전부
   * 거짓이 되어 안내가 조용히 사라진다(실제로 alloc_basis 가 Windows 에서
   * "allocationSize" 로 바뀌면서 할당량 안내가 실사용 전량에서 사라졌다).
   * 리터럴을 Rust 원본에서 긁어 화면 함수에 그대로 통과시킨다.
   */
  function literalsBetween(src: string, from: string, to: string): string[] {
    const start = src.indexOf(from);
    expect(start, `Rust 원본에서 ${from} 을 찾지 못했습니다`).toBeGreaterThan(0);
    const end = src.indexOf(to, start);
    expect(end, `Rust 원본에서 ${to} 을 찾지 못했습니다`).toBeGreaterThan(start);
    return [...new Set([...src.slice(start, end).matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]))];
  }

  function make(over: Partial<ScanResult> = {}): ScanResult {
    return {
      root: { name: "C:\\", path: "C:\\", size: 0, files: 0, isDir: true, children: [], truncated: 0 },
      categories: [],
      totalSize: 100 * 1024 ** 3,
      totalFiles: 10,
      totalDirs: 2,
      errors: 0,
      elapsedMs: 100,
      cancelled: false,
      ...over,
    };
  }

  it("백엔드 alloc_basis 의 모든 값을 화면이 알아본다", () => {
    const values = literalsBetween(scanRs, "alloc_basis: if", "elevated:");
    expect(values).toContain("unknown");
    expect(values.length).toBeGreaterThan(1);
    for (const v of values) {
      expect(
        allocBasisOf(make({ allocBasis: v })),
        `notice.ts 의 allocBasisOf 가 모르는 값입니다: ${v}`,
      ).toBe(v);
    }
  });

  it("산출된 할당량은 어떤 alloc_basis 에서도 화면에서 사라지지 않는다", () => {
    const values = literalsBetween(scanRs, "alloc_basis: if", "elevated:").filter(
      (v) => v !== "unknown",
    );
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      // 차액 10% — 타일 각주와 집계 조건이 모두 말해야 하는 구간이다.
      const r = make({ totalSize: 10 * 1024 ** 3, allocatedEstimate: 11 * 1024 ** 3, allocBasis: v });
      expect(totalFootnote(r), `alloc_basis=${v} 에서 타일 각주가 비었습니다`).not.toBeNull();
      const note = allocatedNote(r);
      expect(note, `alloc_basis=${v} 에서 할당량 안내가 비었습니다`).not.toBeNull();
      // 한국어 화면에 백엔드 키가 그대로 찍히면 안 된다(아는 값인 한).
      expect(note).not.toContain(v);
      expect(basisLines(r).join("\n")).toContain("디스크 점유");
    }
  });

  it("백엔드 dedup 의 모든 값이 우리말 문구로 나온다", () => {
    const values = literalsBetween(scanRs, "dedup: if", "dedup_disabled_reason:");
    expect(values.sort()).toEqual(["hardlink", "none"]);
    for (const v of values) {
      const lines = basisLines(
        make({ dedup: v, hardlinkDedupedFiles: 12, hardlinkDedupedBytes: 1024 ** 3 }),
      ).join("\n");
      expect(lines, `dedup=${v} 의 문구에 백엔드 키가 그대로 있습니다`).not.toContain(v);
      expect(lines).toContain("하드링크");
    }
  });

  it("dedup 을 끈 모든 사유에 우리말 설명이 있다", () => {
    const fnStart = scanRs.indexOf("fn dedup_disabled_reason(");
    expect(fnStart).toBeGreaterThan(0);
    const body = scanRs.slice(fnStart, scanRs.indexOf("\n}", fnStart));
    // 빈 문자열(=끄지 않음)은 [a-zA-Z]+ 에 걸리지 않아 자연히 빠진다.
    const reasons = [...new Set([...body.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]))].filter(
      (r) => r !== "NTFS" && r !== "REFS",
    );
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      const lines = basisLines(make({ dedup: "none", dedupDisabledReason: reason })).join("\n");
      expect(lines, `사유 ${reason} 의 설명이 없습니다`).toContain("하드링크 중복 제거를 하지 않았습니다");
      expect(lines, `사유 ${reason} 의 키가 화면에 그대로 나옵니다`).not.toContain(reason);
    }
  });

  it("중복 제거가 켜진 볼륨에서 초과분을 '중복 계수 탓'으로 돌리지 않는다", () => {
    // 이미 뺀 몫을 원인으로 지목하면 사용자는 존재하지 않는 문제를 찾게 된다.
    const on = describeCoverage(
      make({
        totalSize: 520 * 1024 ** 3,
        dedup: "hardlink",
        hardlinkDedupedFiles: 1200,
        hardlinkDedupedBytes: 8 * 1024 ** 3,
      }),
      499 * 1024 ** 3,
    )!;
    expect(on.text).toContain("한 번만 셌으므로");
    expect(on.text).not.toContain("각각 계수되고");
  });

  /**
   * 오류는 **객체**로 reject 된다. 그 객체를 문자열화하는 코드가 한 줄이라도 남으면
   * 모든 오류 화면이 "[object Object]" 가 된다 — 3라운드에 실제로 일어난 회귀이고
   * cargo check 도 tsc 도 통과시킨 갈래다. 백엔드가 만드는 코드 전량을 실제 화면
   * 문자열까지 통과시켜 그 회귀를 값으로 잠근다.
   */
  it("백엔드 모양의 오류 객체가 사람이 읽을 수 있는 문구로 표시된다", () => {
    const codes = [...new Set([...libRs.matchAll(/CommandError::new\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]))];
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      // Tauri 2 가 넘겨주는 모양 그대로(직렬화된 CommandError).
      const raw = { code, detail: "Z:\\보고서", message: "백엔드 원문" };
      const shown = friendlyError(raw);
      expect(shown, `code=${code}`).not.toContain("[object Object]");
      expect(shown, `code=${code}`).not.toContain("undefined");
      // 영문 키만 찍히는 것도 사람이 읽을 수 있는 문구가 아니다.
      expect(/[가-힣]/.test(shown), `code=${code} 의 문구가 한국어가 아닙니다: ${shown}`).toBe(true);
      expect(shown.length, `code=${code}`).toBeGreaterThan(8);
      // '자세한 내용' 도 같은 방어를 받는다(원문이 사라지면 감사 기록이 끊긴다).
      expect(errorDetail(raw)).toContain("Z:\\보고서");
    }
  });

  it("모양이 어긋난 오류(문자열·code 없는 객체)도 문자열화로 뭉개지지 않는다", () => {
    for (const raw of ["os error 1392", { message: "볼륨을 열지 못했습니다" }, {}, null]) {
      const shown = friendlyError(raw as never);
      expect(shown).not.toContain("[object Object]");
      expect(shown.length).toBeGreaterThan(8);
    }
  });

  /**
   * 화면에 실제로 칠해지는 색은 백엔드가 실어 보내는 category.rs 의 값이고
   * CATEGORY_COLORS 는 폴백이다. 두 목록이 갈리면 대비 테스트가 초록인 채로
   * 화면 대비만 무너지므로, 색 자체를 여기서 잠근다(라벨 차이는 의도된 것이라 제외).
   */
  it("category.rs 의 분야 색과 types.ts 의 폴백 팔레트가 일치한다", () => {
    // `Category::Video => "#ff6b7a",` 형태를 뽑는다.
    const pairs = [...categoryRs.matchAll(/Category::(\w+)\s*=>\s*"(#[0-9a-fA-F]{6})"/g)];
    const rust = new Map<string, string>();
    for (const [, variant, color] of pairs) rust.set(variant.toLowerCase(), color.toLowerCase());
    expect(rust.size, "category.rs 에서 색 매핑을 찾지 못했습니다").toBeGreaterThan(0);

    for (const [variant, color] of rust) {
      const ts = CATEGORY_COLORS[variant];
      expect(ts, `types.ts 에 없는 분야 키: ${variant}`).toBeTruthy();
      expect(ts?.toLowerCase(), `분야 ${variant} 의 색이 다릅니다`).toBe(color);
    }
  });
});
