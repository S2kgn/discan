import { describe, expect, it } from "vitest";
import { ScanNode, ScanResult } from "../types";
import {
  buildCategoryCsv,
  buildExtensionCsv,
  buildFailedPathsCsv,
  buildJson,
  buildTreeCsv,
  exportDisclosure,
  timestampSlug,
} from "./export";

const result: ScanResult = {
  root: {
    name: "root",
    path: "C:\\ro,ot",
    size: 300,
    files: 2,
    isDir: true,
    children: [
      { name: "big.iso", path: "C:\\big.iso", size: 200, files: 1, isDir: false, children: [], truncated: 0 },
      {
        /*
         * 백엔드가 실제로 만드는 형태: size = (남긴 자식 합) + truncated_bytes.
         * 예전 픽스처는 size 100 · 자식 없음 · truncated_bytes 40 이라 60바이트가
         * 어디에도 귀속되지 않는, 백엔드가 결코 만들지 않는 트리였다. 그 픽스처가
         * self_bytes 열의 오류(실데이터에서는 늘 0)를 가리고 있었다.
         */
        name: "sub",
        path: "C:\\sub",
        size: 100,
        files: 1,
        isDir: true,
        children: [
          { name: "a.bin", path: "C:\\sub\\a.bin", size: 60, files: 1, isDir: false, children: [], truncated: 0 },
        ],
        truncated: 3,
        truncatedBytes: 40,
        truncatedBytesDeep: 40,
        truncatedDeep: 3,
        truncatedReason: "depth",
        incomplete: true,
      },
    ],
    truncated: 0,
  } as ScanNode,
  categories: [{ key: "video", size: 200, files: 1 }],
  extensions: [{ ext: "iso", size: 200, files: 1 }],
  totalSize: 300,
  totalFiles: 2,
  totalDirs: 1,
  errors: 0,
  elapsedMs: 12,
  cancelled: false,
  volumeSerial: "1A2B-3C4D",
  failedPaths: [{ path: "C:\\Users\\alice\\비밀 프로젝트\\x.docx", kind: "denied" }],
  pruneParams: { minSize: 64, maxDepth: 12, maxChildren: 80 },
};

/** 따옴표를 존중하는 최소 CSV 파서. 경로에 쉼표가 들어가면 split(',') 은 어긋난다. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function body(csv: string): string[] {
  return csv
    .replace(/^\ufeff/, "")
    .trim()
    .split("\r\n")
    .filter((l) => !l.startsWith("#"));
}

describe("buildTreeCsv", () => {
  const csv = buildTreeCsv(result, "C:\\");
  const lines = body(csv);

  it("헤더와 모든 노드를 싣는다", () => {
    expect(lines[0]).toBe(
      "path,name,kind,size_bytes,files,depth,incomplete,truncated_children,truncated_bytes," +
        "truncated_small,truncated_capped,truncated_deep," +
        "truncated_bytes_small,truncated_bytes_capped,truncated_bytes_deep," +
        "truncate_reason_primary",
    );
    expect(lines).toHaveLength(5);
  });

  it("행이 계층적이라는 사실과 집계 조건을 프리앰블에 남긴다", () => {
    // cluster_slack 은 total_size_bytes 에 걸리는 조건이라 그 수치 옆에 묶어 적는다.
    expect(csv).toContain("# size_basis=logical(cluster_slack_not_counted) dedup=none");
    expect(csv).toContain("min_size=64 max_depth=12 max_children=80");
    expect(csv).toContain("a dir row already contains its descendants");
  });

  it("프리앰블이 권하는 총량 복원법이 실제 데이터에서 성립한다", () => {
    // 예전 지침('sum kind=file rows, or sum self_bytes')은 둘 다 틀린 값을 냈다:
    // self_bytes 합계는 늘 0이고, kind=file 행은 디렉터리당 상위 N개만 실린다.
    const header = cells(lines[0]);
    const rows = lines.slice(1).map(cells);
    const at = (row: string[], name: string) => Number(row[header.indexOf(name)]);

    const depth0 = rows.filter((r) => at(r, "depth") === 0);
    expect(depth0.reduce((a, r) => a + at(r, "size_bytes"), 0)).toBe(result.totalSize);

    // 같은 depth 의 size_bytes 합 + 그 위 depth 의 truncated_bytes 합.
    const depth1 = rows.filter((r) => at(r, "depth") === 1);
    const restored =
      depth1.reduce((a, r) => a + at(r, "size_bytes"), 0) +
      depth0.reduce((a, r) => a + at(r, "truncated_bytes"), 0);
    expect(restored).toBe(result.totalSize);

    expect(csv).toContain("# NOTE: total = size_bytes of the depth=0 row");
    expect(csv).not.toContain("self_bytes");
  });

  it("읽지 못한 서브트리를 '용량 0인 정상 폴더'와 구분할 수 있다", () => {
    expect(csv).toContain("# NOTE: incomplete=1 rows are lower bounds");
    const header = cells(lines[0]);
    const i = header.indexOf("incomplete");
    // sub 는 incomplete=true, 나머지는 0.
    expect(lines.slice(1).map((l) => cells(l)[i])).toEqual(["0", "0", "1", "0"]);
  });

  it("총량 차이를 파일만 보고 소명할 수 있게 할당·권한 축을 싣는다", () => {
    // allocated 0 이 '점유 없음'인지 '클러스터 미상'인지는 alloc_basis 로만 갈린다.
    expect(csv).toContain("alloc_basis=unknown");
    expect(csv).toContain("elevated=unknown");
  });

  it("사유별 생략 바이트를 개수와 함께 싣는다", () => {
    // 깊이 절단(큰 폴더가 통째로 숨음)과 비중 과소(정의상 작은 것들)를 합산해 두면
    // '이 CSV 가 놓친 용량이 어디에 있을 법한가'에 답할 수 없다.
    expect(lines[3]).toContain(",,,3,,,40,");
    expect(csv).toContain("# CHECK: truncated_bytes_small");
  });

  it("쉼표가 든 경로를 따옴표로 감싼다", () => {
    expect(lines[1].startsWith('"C:\\ro,ot"')).toBe(true);
  });

  it("파일 노드와 생략 사유를 구분해 기록한다", () => {
    expect(lines[2]).toContain(",file,200,1,1,0,0,0,");
    // 사유별 열이 비어 있어도 대표 사유 열은 자기 이름으로 끝에 남는다.
    expect(lines[3]).toContain(",dir,100,1,1,1,3,40,");
    expect(lines[3].endsWith("depthLimit")).toBe(true);
  });

  it("표시용 축약이 아니라 원시 바이트를 쓴다", () => {
    expect(csv).not.toContain("GiB");
  });
});

describe("buildCategoryCsv", () => {
  it("프런트 사전의 표시 이름과 축 안에서의 비중을 쓴다", () => {
    // 분모는 축 합계다. 두 축은 분류 규칙이 달라 합계가 서로 다를 수 있다.
    expect(buildCategoryCsv(result)).toContain("hint,video,영상,200,1,100.000");
  });

  it("화면에서 가장 분석적으로 쓰이는 축(내용 기준)도 함께 싣는다", () => {
    const csv = buildCategoryCsv({
      ...result,
      contentCategories: [{ key: "cache", size: 120, files: 3 }],
    });
    expect(csv).toContain("axis,key,label,size_bytes,files,percent_of_axis");
    expect(csv).toContain("content,cache,캐시·빌드 산출물,120,3,100.000");
  });
});

describe("buildFailedPathsCsv", () => {
  it("실패 목록을 표 산출물로도 낸다", () => {
    const csv = buildFailedPathsCsv(result, "C:\\");
    const lines = body(csv);
    expect(lines[0]).toBe("path,kind,label");
    expect(lines[1]).toContain("denied,권한 거부");
    // 행 수를 발생 건수로 읽으면 감사 결론이 뒤집힌다.
    expect(csv).toContain("# NOTE: rows are unique (path, kind) pairs");
    expect(csv).toContain("failed_paths_total=");
  });
});

describe("경로 익명화", () => {
  const scoped: ScanResult = {
    ...result,
    rootPath: "C:\\Users\\alice",
    largestFiles: [{ name: "x.docx", path: "C:\\Users\\alice\\비밀 프로젝트\\x.docx", size: 1 }],
    root: {
      ...result.root,
      path: "C:\\Users\\alice",
      children: [
        {
          name: "비밀 프로젝트",
          path: "C:\\Users\\alice\\비밀 프로젝트",
          size: 1,
          files: 1,
          isDir: true,
          children: [],
          truncated: 0,
        },
      ],
    },
  };

  it("켜면 트리·상위 파일·실패 목록·프리앰블이 모두 상대 경로가 된다", () => {
    // 예전 옵션은 failedPaths 만 축약해, 20~500건이 익명화되고 수천 건이 그대로 나갔다.
    const parsed = JSON.parse(buildJson(scoped, "C:\\Users\\alice", { anonymizePaths: true }));
    expect(JSON.stringify(parsed)).not.toContain("alice");
    expect(parsed.root.children[0].path).toBe("<root>\\비밀 프로젝트");
    expect(parsed.largestFiles[0].path).toBe("<root>\\비밀 프로젝트\\x.docx");
    expect(parsed.pathBasis).toBe("relativeToRoot");

    const csv = buildTreeCsv(scoped, "C:\\Users\\alice", { anonymizePaths: true });
    expect(csv).not.toContain("alice");
    expect(csv).toContain("# target=C:\\");
  });

  it("끄면 고지대로 절대 경로가 그대로 나간다", () => {
    const parsed = JSON.parse(buildJson(scoped, "C:\\Users\\alice"));
    expect(parsed.root.children[0].path).toContain("alice");
    expect(parsed.failedPaths[0].path).toContain("비밀 프로젝트");
    expect(parsed.pathBasis).toBe("absolute");
  });
});

describe("buildExtensionCsv", () => {
  it("상위 목록 밖의 나머지를 residual 행으로 채워 100%를 설명한다", () => {
    const lines = body(buildExtensionCsv(result));
    expect(lines[0]).toBe("ext,label,category,size_bytes,files,percent_of_total");
    expect(lines[1]).toBe("iso,iso,,200,1,66.667");
    expect(lines[2].startsWith("__residual,")).toBe(true);
    expect(lines[2]).toContain(",100,");
  });

  it("키 열은 로케일 독립 ASCII 센티널만 담는다", () => {
    // 백엔드가 __overflow/__none 을 ASCII 로 못 박은 이유(하류가 표시 문구를
    // 하드코딩하지 않게 한다)가 마지막 단계에서 무너지면 안 된다.
    const withSentinels = buildExtensionCsv({
      ...result,
      extensions: [
        { ext: "__overflow", size: 100, files: 2 },
        { ext: "__none", size: 50, files: 1 },
      ],
    });
    for (const line of body(withSentinels).slice(1)) {
      const key = line.split(",")[0];
      expect(key, `ext 열이 ASCII 가 아닙니다: ${key}`).toMatch(/^[ -~]*$/);
    }
    // 표시 문구는 별도 label 열에서만 나온다.
    expect(withSentinels).toContain("__overflow,그 밖의 확장자");
  });
});

describe("부분 집계 표식", () => {
  const partial: ScanResult = {
    ...result,
    cancelled: true,
    errors: 900,
    failedPaths: [{ path: "C:\\x", kind: "denied" }],
    failedPathsTotal: 900,
    failedPathsTruncated: true,
    skippedCloud: 3,
    skippedCloudBytes: 4096,
    skippedLinks: 7,
  };

  it("중단된 결과를 내보내면 세 산출물 모두에 표식이 있다", () => {
    for (const csv of [
      buildTreeCsv(partial, "C:\\"),
      buildCategoryCsv(partial, "C:\\"),
      buildExtensionCsv(partial, "C:\\"),
    ]) {
      expect(csv).toContain("cancelled=true");
      expect(csv).toContain("WARNING: partial scan");
      expect(csv).toContain("skipped_cloud=3");
      expect(csv).toContain("failed_paths_truncated=true");
    }
    const parsed = JSON.parse(buildJson(partial, "C:\\"));
    expect(parsed.partial).toBe(true);
    expect(parsed.totals.failedPathsTotal).toBe(900);
    expect(parsed.totals.failedPathsTruncated).toBe(true);
  });

  it("프리앰블 첫 줄이 자기 산출물 종류를 밝힌다", () => {
    expect(buildTreeCsv(result).split("\r\n")[0]).toContain("tree export");
    expect(buildCategoryCsv(result).split("\r\n")[0]).toContain("category export");
    expect(buildExtensionCsv(result).split("\r\n")[0]).toContain("extension export");
  });
});

describe("buildJson", () => {
  it("메타데이터와 집계 조건을 함께 남긴다", () => {
    const parsed = JSON.parse(buildJson(result, "C:\\"));
    expect(parsed.target).toBe("C:\\");
    expect(parsed.formatVersion).toBe(4);
    expect(parsed.totals.totalSize).toBe(300);
    expect(parsed.basis.dedup).toBe("none");
    // 0 이 '점유 없음'인지 '클러스터 미상'인지 구분할 근거가 산출물에도 있어야 한다.
    expect(parsed.basis.allocBasis).toBe("unknown");
    expect(typeof parsed.scannedAt).toBe("string");
  });

  it("두 스냅샷의 차이를 소명할 실행 권한을 함께 남긴다", () => {
    const parsed = JSON.parse(buildJson({ ...result, elevated: true }, "C:\\"));
    expect(parsed.basis.elevated).toBe(true);
  });

  it("기본값에서는 볼륨 식별자를 싣지 않는다", () => {
    const parsed = JSON.parse(buildJson(result, "C:\\"));
    expect(parsed.basis.volumeSerial).toBeUndefined();
    expect(parsed.failedPaths[0].kind).toBe("denied");
  });

  it("감사 목적으로 명시했을 때만 볼륨 식별자를 싣는다", () => {
    const parsed = JSON.parse(buildJson(result, "C:\\", { includeVolumeSerial: true }));
    expect(parsed.basis.volumeSerial).toBe("1A2B-3C4D");
  });

  it("백엔드에 필드가 추가돼도 자동으로 실리지 않는다(화이트리스트)", () => {
    const sneaky = { ...result, secretNewField: "leak" } as ScanResult & { secretNewField: string };
    expect(buildJson(sneaky, "C:\\")).not.toContain("secretNewField");
  });
});

describe("exportDisclosure", () => {
  it("포함 항목을 옵션에 따라 다르게 고지한다", () => {
    expect(exportDisclosure()).toContain("절대 경로");
    expect(exportDisclosure()).not.toContain("볼륨");
    expect(exportDisclosure({ includeVolumeSerial: true })).toContain("볼륨 식별 정보");
    // 고지와 체크박스 라벨이 서로 다른 이야기를 하면 사용자는 어느 쪽도 믿을 수 없다.
    expect(exportDisclosure({ anonymizePaths: true })).toContain("절대 경로 제외");
  });
});

describe("timestampSlug", () => {
  it("YYYYMMDD-HHmm", () => {
    expect(timestampSlug(new Date(2026, 6, 23, 9, 5))).toBe("20260723-0905");
  });
});
