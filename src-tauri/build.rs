fn main() {
    // 기본 매니페스트를 대체해 롱 패스를 선언한다.
    //
    // 선언이 없으면 260자를 넘는 경로에서 read_dir 이 실패하고, 그 서브트리가
    // 통째로 집계에서 빠진다 — node_modules 중첩이나 백업 폴더에서 드물지 않은
    // 조건인데, '무엇이 디스크를 차지하는가'를 답하는 앱에서 그 누락은 결과를
    // 뒤집는다. 실제로 켜지려면 레지스트리의 LongPathsEnabled 와 이 선언이
    // **둘 다** 있어야 한다.
    //
    // 대체는 **통째로** 이뤄진다 — 기본 매니페스트의 trustInfo(asInvoker)와
    // compatibility/supportedOS 도 함께 사라지므로 교체본에 다시 적어 둔다.
    // 실행 수준을 선언하지 않은 바이너리는 UAC 설치 관리자 감지 휴리스틱과
    // 호환성 심의 대상이 되고, 디스크 전체를 읽는 도구가 어느 권한으로 도는지
    // 산출물 메타데이터에 남지 않는다(코드는 is_elevated 로 결과에 남기고 있다).
    //
    // 매니페스트는 RT_MANIFEST 리소스로 그대로 박히므로 ASCII 로만 쓴다.
    // 한글 주석이나 XML 선언을 넣으면 활성화 컨텍스트 생성이 실패해
    // (os error 14001) 실행 파일이 아예 뜨지 않는다 — 링크는 성공하므로
    // 빌드 로그만 보고는 알 수 없다.
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
