# 릴리스 절차 (Windows)

## 서명 상태

`src-tauri/tauri.conf.json` 의 `bundle.windows` 에는 `digestAlgorithm` 과 `timestampUrl`
만 있고 인증서 연결이 없다. **기본 빌드(`npm run tauri build`)의 산출물은 서명되지
않는다** — 개발·내부 확인용이며, 설치 시 SmartScreen 의 '알 수 없는 게시자' 경고가
뜬다. 디스크 전체를 읽는 권한으로 도는 도구이므로 배포본을 그대로 다른 사람에게
전달해서는 안 된다.

서명 자격을 리포지터리에 넣지 않기 위해, 서명 설정은 기본 설정과 분리된
`src-tauri/tauri.release.conf.json` 에 둔다. 이 파일은 `--config` 로 명시할 때만
병합되므로 로컬 개발 흐름은 영향을 받지 않는다.

## 서명 빌드

```powershell
# 인증서는 CurrentUser\My 저장소에 있어야 한다(CI 라면 시크릿에서 복원한 뒤 import).
$env:DISCAN_SIGN_THUMBPRINT = "<인증서 SHA1 지문, 공백 없이>"
npm run tauri build -- --config src-tauri/tauri.release.conf.json
```

- 서명은 `signtool` 에 위임한다(Windows SDK 필요). 지문은 환경변수로만 주입하며
  설정 파일에는 남기지 않는다.
- 지문이 비어 있으면 `signtool` 이 실패하고 번들 생성도 함께 실패한다 —
  '조용히 서명 없이 나가는' 경로를 남기지 않기 위한 의도된 동작이다.
- HSM·클라우드 서명(azuresigntool 등)을 쓴다면 `signCommand` 의 `args` 만 바꾸면 된다.

## 업데이터 서명 (minisign)

Authenticode 인증서와 **별개**의 서명이다. Authenticode 는 '설치 파일을 만든 것이
누구인가'를, 업데이터의 minisign 서명은 '이 앱이 받아 설치하려는 패키지가 배포자가
만든 것인가'를 답한다. 인증서가 없어도 후자는 지금 닫을 수 있고, 실제로 닫아 두었다.

- 공개키는 `src-tauri/tauri.conf.json` 의 `plugins.updater.pubkey` 에 있다.
- 개인키는 **저장소 바깥**(`~/.tauri/discan.key`)에 있으며 scrypt 비밀번호로 보호된다.
  저장소 안으로 복사하지 않는다.
- `bundle.createUpdaterArtifacts` 가 켜져 있어, 아래 두 환경변수가 있으면
  `tauri build` 가 산출물과 함께 `.sig` 를 만든다. 없으면 서명 없이 지나간다.

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH     = "$env:USERPROFILE\.tauri\discan.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<비밀번호>"
npm run tauri build -- --config src-tauri/tauri.release.conf.json
```

- 비밀번호는 **비밀번호 관리자**에 보관한다. 저장소·CI 설정 파일·셸 히스토리에
  평문으로 남기지 않는다.
- GitHub Actions 로 릴리스를 자동화할 때는 아래로 등록하고 워크플로에서 `secrets`
  로만 참조한다.

```powershell
gh secret set TAURI_SIGNING_PRIVATE_KEY          # 키 파일 내용 그대로
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

- **키와 비밀번호를 잃으면 기존 사용자에게 업데이트를 내보낼 수단이 영구히 사라진다.**
  공개키는 설치된 바이너리에 박혀 있고, 새 키로 서명한 패키지는 그 바이너리가 거부한다.
  복구 경로는 '전원이 수동으로 재설치'뿐이다. 키 파일과 비밀번호를 서로 다른 곳에
  이중으로 백업할 것.

### endpoints 는 아직 비어 있다

`plugins.updater.endpoints` 는 **의도적으로 빈 배열**이다. 배포처(GitHub 릴리스)가
아직 없고, 동작하지 않는 URL 을 진짜인 것처럼 두면 다음 사람이 '설정되어 있다'고
읽는다. 지금 상태에서 갱신 조회는 `EmptyEndpoints` 오류로 즉시 실패한다 — 조용히
성공한 척하지 않는다는 뜻이다.

저장소가 생기면 GitHub 릴리스 규약에 맞춰 아래 한 줄을 채운다.

```json
"endpoints": ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"]
```

같은 시점에 `src-tauri/capabilities/default.json` 에
`updater:allow-download-and-install` 을 추가한다(지금은 조회 권한만 열려 있다 —
설치 흐름이 없는데 설치 권한을 먼저 열 이유가 없다).

## 콘텐츠 보안 정책(CSP)에 대한 메모

`tauri.conf.json` 은 주석을 담을 수 없으므로 근거를 여기 남긴다.

- `img-src 'self'` — 프로덕션에서 `data:`/`blob:` 을 뺐다. 저장소에 `<img>` 도
  CSS `url(...)` 도 없어 두 스킴이 지탱하는 기능이 하나도 없었고, 남겨 두면 훗날
  XSS 가 성립했을 때 데이터 반출 통로만 열어 둔다. 아이콘·이미지를 도입하는 날
  필요한 스킴만 되돌린다. 개발 CSP 는 Vite 의 자산 인라인 때문에 그대로 둔다.
- `style-src 'self'; style-src-attr 'unsafe-inline'` — 두 완화는 **등급이 다르다**.
  React 의 인라인 `style` 속성(막대 폭·분야 색)은 제거할 수 없으므로 속성만 허용하고,
  `<style>` 요소 주입 경로는 닫는다. Vite 프로덕션 빌드는 CSS 를 별도 파일로 링크하므로
  요소 쪽 완화가 필요 없다(개발 서버는 `<style>` 로 주입하므로 devCsp 는 유지).
  **CSP 를 손댄 뒤에는 릴리스 빌드를 한 번 띄워 콘솔에 위반이 없는지 확인할 것** —
  특히 진행 막대와 드라이브 카드의 `style={{ ... }}` 가 검증 대상이다.
- `freezePrototype: true` — 이 앱은 프로토타입 패치에 의존하는 코드가 없다(React 19 +
  자체 유틸뿐). 렌더러에 스크립트 실행이 성립한 뒤 IPC 페이로드를 변조하는 전형적
  후속 단계를 비용 0으로 막는다.

## 빌드 산출물 구성

`[lib] crate-type` 은 `["lib"]` 하나다. Tauri 템플릿 기본값(`staticlib`·`cdylib`·`rlib`)은
모바일 대비인데, 이 프로젝트의 `bundle.targets` 는 `nsis`/`msi` 뿐이고 `mobile` cfg 가
켜지는 빌드가 없다. `[profile.release]` 가 `lto = true` + `codegen-units = 1` 이라
crate-type 하나마다 전체 LTO 를 한 번씩 더 도는 구조여서, 링크되지도 않는 두 산출물이
릴리스 빌드 시간과 CI 캐시를 배로 늘리고 있었다. **안드로이드·iOS 대상을 추가한다면
`crate-type` 을 되돌려야 한다** — 그때는 `lto = "thin"` 을 함께 검토할 것.

`windows-app-manifest.xml` 은 tauri-build 의 기본 매니페스트를 **대체**한다. 즉
기본값에 있던 `trustInfo`(asInvoker)·`compatibility/supportedOS` 도 함께 사라지므로
교체본이 직접 들고 있다. 이 파일을 손댈 때는 ASCII 로만 쓰고 XML 선언을 넣지 않는다
(RT_MANIFEST 로 그대로 박히며, 어기면 실행 파일이 os error 14001 로 아예 뜨지 않는다).
수정 후에는 `cargo build` 로 만든 실행 파일이 실제로 기동하는지 한 번 확인한다.

## 무결성 공개

인증서를 확보하기 전이라도 배포물의 출처를 검증할 수단은 남긴다. 릴리스마다
아래 값을 릴리스 노트에 함께 게시한다.

```powershell
Get-FileHash .\src-tauri\target\release\bundle\nsis\*.exe -Algorithm SHA256
Get-FileHash .\src-tauri\target\release\bundle\msi\*.msi  -Algorithm SHA256
```

받는 쪽은 같은 명령으로 대조한다.

## 릴리스 전 점검

```powershell
npm run check                                   # typecheck + vitest + npm audit
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml
cargo audit --file src-tauri/Cargo.lock         # cargo install cargo-audit
```

빌드 후 서명 산출물을 **눈으로 확인한다**. 서명 명령이 성공했다는 것만으로는
서명 여부가 보증되지 않는다.

```powershell
# minisign(업데이터): 산출물마다 .sig 가 생겼는지
Get-ChildItem .\src-tauri\target\release\bundle -Recurse -Filter *.sig
# Authenticode(설치 파일): 인증서를 확보한 뒤에만 의미가 있다
signtool verify /pa /v .\src-tauri\target\release\bundle\nsis\*.exe
```

두 잠금 파일(`package-lock.json`, `src-tauri/Cargo.lock`)의 해시를 릴리스 태그에
함께 남겨 재현 절차를 고정한다. MSRV 는 `src-tauri/Cargo.toml` 의 `rust-version`
(현재 1.87)이다.
