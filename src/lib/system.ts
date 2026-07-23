/**
 * 큰 파일 목록 맨 위에는 C: 스캔 시 거의 확실히 시스템 파일이 올라온다.
 * 이 앱에서 가장 크고 가장 눌러 보고 싶은 목록이 하필 가장 위험하므로,
 * '지우지 말라'는 것과 '대신 무엇을 하면 되는가'를 같은 줄에서 말해야 한다.
 */
export interface SystemFileNote {
  /** 배지에 들어갈 짧은 말. */
  label: string;
  /** 대체 수단. 지우지 말라고만 하면 사용자는 여전히 공간이 필요하다. */
  detail: string;
}

interface Rule {
  label: string;
  detail: string;
  match: (name: string, path: string) => boolean;
}

const nameIs = (...names: string[]) => (name: string) => names.includes(name);
/** 경로 구성요소 단위로 본다 — `D:\MyWindows\x` 를 시스템 파일로 적으면 안 된다. */
const underDir = (dir: string) => (_name: string, path: string) =>
  path.toLowerCase().split(/[\\/]/).includes(dir);

const RULES: Rule[] = [
  {
    label: "시스템 파일",
    detail: "가상 메모리 파일입니다. 설정 > 시스템 > 정보 > 고급 시스템 설정에서 조절하십시오.",
    match: nameIs("pagefile.sys", "swapfile.sys"),
  },
  {
    label: "시스템 파일",
    detail:
      "최대 절전 모드 파일입니다. 관리자 명령 프롬프트에서 powercfg /h off 로만 제거하십시오.",
    match: nameIs("hiberfil.sys"),
  },
  {
    label: "시스템 파일",
    detail: "사용자 프로필 레지스트리입니다. 지우면 로그인 설정이 깨집니다.",
    match: nameIs("ntuser.dat", "usrclass.dat"),
  },
  {
    label: "복원 지점",
    detail: "시스템 복원 데이터입니다. 설정 > 시스템 > 시스템 보호에서 용량을 줄이십시오.",
    match: (_n, p) => underDir("system volume information")(_n, p),
  },
  {
    label: "휴지통",
    detail: "휴지통 안의 파일입니다. 휴지통 비우기로 지우십시오.",
    match: (_n, p) => underDir("$recycle.bin")(_n, p),
  },
  {
    label: "시스템 파일",
    detail: "Windows 구성 요소입니다. 직접 지우지 말고 설정 > 시스템 > 저장 공간을 쓰십시오.",
    match: (_n, p) => underDir("windows")(_n, p),
  },
];

export function systemFileNote(path: string, name?: string): SystemFileNote | null {
  const lowerPath = path.toLowerCase();
  const lowerName = (name ?? path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const rule = RULES.find((r) => r.match(lowerName, lowerPath));
  return rule ? { label: rule.label, detail: rule.detail } : null;
}
