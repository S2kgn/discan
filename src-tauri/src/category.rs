//! 파일을 "분야"로 분류한다.
//!
//! 분류는 두 단계다. 디렉터리를 내려가면서 이름으로 힌트를 잡고(`hint_from_dir`),
//! 힌트가 잡힌 하위 트리는 확장자를 무시한 채 그 힌트를 따른다.
//! `node_modules` 안의 `.js`는 코드가 아니라 의존성 캐시이기 때문이다.
//!
//! 다만 힌트가 확장자 정보를 지워 버리면 '캐시 7GB'의 내부를 다시 볼 수 없다.
//! 그래서 `scan`은 힌트를 적용한 축과 확장자만 본 축을 함께 집계한다.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Video,
    Image,
    Audio,
    Document,
    Archive,
    Code,
    Executable,
    Game,
    Cache,
    Database,
    Dataset,
    Font,
    DiskImage,
    Other,
}

pub const CATEGORY_COUNT: usize = 14;

pub const ALL_CATEGORIES: [Category; CATEGORY_COUNT] = [
    Category::Video,
    Category::Image,
    Category::Audio,
    Category::Document,
    Category::Archive,
    Category::Code,
    Category::Executable,
    Category::Game,
    Category::Cache,
    Category::Database,
    Category::Dataset,
    Category::Font,
    Category::DiskImage,
    Category::Other,
];

// `index()`가 `self as usize`인 이상, 변형을 추가하고 상수·목록을 잊으면
// 런타임 배열 인덱스 초과로 터진다. 컴파일러가 대신 잡게 한다.
const _: () = assert!(ALL_CATEGORIES.len() == CATEGORY_COUNT);
const _: () = {
    let mut i = 0;
    while i < CATEGORY_COUNT {
        assert!(
            ALL_CATEGORIES[i] as usize == i,
            "ALL_CATEGORIES 순서가 Category 정의 순서와 어긋났다"
        );
        i += 1;
    }
};

impl Category {
    pub fn index(self) -> usize {
        self as usize
    }

    /// 프런트엔드가 색상·아이콘 매핑에 쓰는 안정적인 키.
    pub fn key(self) -> &'static str {
        match self {
            Category::Video => "video",
            Category::Image => "image",
            Category::Audio => "audio",
            Category::Document => "document",
            Category::Archive => "archive",
            Category::Code => "code",
            Category::Executable => "executable",
            Category::Game => "game",
            Category::Cache => "cache",
            Category::Database => "database",
            Category::Dataset => "dataset",
            Category::Font => "font",
            Category::DiskImage => "diskimage",
            Category::Other => "other",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Category::Video => "영상",
            Category::Image => "이미지",
            Category::Audio => "음악",
            Category::Document => "문서",
            Category::Archive => "압축",
            Category::Code => "코드",
            Category::Executable => "프로그램",
            Category::Game => "게임",
            Category::Cache => "캐시·빌드 산출물",
            Category::Database => "데이터베이스",
            Category::Dataset => "모델·데이터셋",
            Category::Font => "폰트",
            Category::DiskImage => "디스크 이미지",
            Category::Other => "기타",
        }
    }

    /// 분야 색까지 여기서 정한다.
    ///
    /// 프런트에 매핑표만 두면 변형을 추가할 때 색이 조용히 빠져 새 분야가
    /// '기타'와 같은 회색으로 그려지고 아무도 눈치채지 못한다. `match`는
    /// 변형을 빠뜨리면 컴파일이 되지 않으므로 그 드리프트가 원천 차단된다.
    ///
    /// 값은 프런트(`types.ts`)의 대비 조정 팔레트와 일치시켜 둔다 —
    /// 여기가 우선하므로 한쪽만 고치면 조정이 조용히 되돌아간다.
    pub fn color(self) -> &'static str {
        match self {
            Category::Video => "#ff6b7a",
            Category::Image => "#f2994a",
            Category::Audio => "#6b5400",
            Category::Document => "#7fc0ff",
            Category::Archive => "#c49bf5",
            Category::Code => "#4fe0a5",
            Category::Executable => "#2a4fae",
            Category::Game => "#eb5fc0",
            Category::Cache => "#4ec9d4",
            Category::Database => "#0d6b66",
            Category::Dataset => "#8fb339",
            Category::Font => "#6b3fa0",
            Category::DiskImage => "#77380f",
            Category::Other => "#4a5464",
        }
    }
}

/// 디렉터리 이름만 보고 하위 전체에 적용할 분류 힌트를 결정한다.
/// 상위에서 이미 힌트가 잡혔으면 그것을 유지한다 — 첫 판정이 가장 넓은 맥락이다.
pub fn hint_from_dir(name: &str, inherited: Option<Category>) -> Option<Category> {
    if inherited.is_some() {
        return inherited;
    }

    // 대소문자 구분 없이 비교하되, 흔한 경우를 위해 소문자 변환은 한 번만.
    let lower = name.to_ascii_lowercase();

    const CACHE_DIRS: [&str; 21] = [
        "node_modules",
        ".git",
        ".svn",
        ".hg",
        "__pycache__",
        ".venv",
        "venv",
        ".cache",
        "cache",
        "caches",
        "temp",
        "tmp",
        ".gradle",
        ".nuget",
        ".m2",
        ".cargo",
        ".next",
        ".turbo",
        "inetcache",
        "webcache",
        "crashdumps",
    ];

    const GAME_DIRS: [&str; 6] = [
        "steamapps",
        "epic games",
        "gog galaxy",
        "origin games",
        "riot games",
        "battle.net",
    ];

    if CACHE_DIRS.contains(&lower.as_str()) {
        return Some(Category::Cache);
    }
    if GAME_DIRS.contains(&lower.as_str()) {
        return Some(Category::Game);
    }

    None
}

/// 이름만으로는 캐시라고 단정할 수 없는 빌드 산출물 디렉터리.
///
/// `target`·`obj`는 너무 흔한 단어다. `D:\Photos\target`을 '캐시'로 적어 두면
/// 정리하러 온 사용자가 지운다 — 호출자가 빌드 지문을 확인한 뒤에만 힌트를 준다.
pub fn is_conditional_cache_dir(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "target" | "obj")
}

/// 확장자로 분류한다. 확장자는 소문자, 점 없이 전달할 것.
pub fn classify_ext(ext: &str) -> Category {
    match ext {
        // 영상. `.ts`는 MPEG 전송 스트림이기도 하지만 TypeScript 쪽 빈도가 압도적이라
        // 코드로 넘긴다. 영상 컨테이너는 `.m2ts`/`.mts`로 대개 커버된다.
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg"
        | "m2ts" | "vob" | "rmvb" | "3gp" | "mts" => Category::Video,

        // 이미지. 최신 코덱(avif·jxl)과 제조사별 RAW 확장이 빠져 있으면 사진 디스크
        // 수십 GB가 통째로 '기타'로 떨어진다.
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "svg" | "heic"
        | "heif" | "ico" | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "psd" | "ai" | "xcf"
        | "avif" | "jxl" | "jfif" | "orf" | "rw2" | "raf" | "sr2" | "pef" | "srw" => {
            Category::Image
        }

        // 음악
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "aiff" | "alac"
        | "mid" | "midi" | "ape" => Category::Audio,

        // 문서. `.msg`/`.eml`은 메일 한 통(첨부 포함)이라 문서 쪽이 맞고,
        // 메일 **저장소**(.pst/.ost)는 아래 데이터베이스로 간다.
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "hwp" | "hwpx" | "txt"
        | "md" | "rtf" | "odt" | "ods" | "odp" | "epub" | "mobi" | "azw3" | "csv" | "tsv"
        | "tex" | "pages" | "numbers" | "key" | "chm" | "xps" | "djvu" | "msg" | "eml" => {
            Category::Document
        }

        // 압축·패키지. `.jar`/`.nupkg`는 사실상 zip 컨테이너다.
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "lz4" | "cab" | "arj"
        | "tgz" | "egg" | "whl" | "jar" | "war" | "ear" | "nupkg" | "crate" => Category::Archive,

        // 코드
        "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "rs" | "go" | "py" | "js" | "mjs" | "cjs"
        | "ts" | "tsx" | "jsx" | "java" | "kt" | "swift" | "rb" | "php" | "cs" | "vb" | "sh"
        | "ps1" | "sql" | "json" | "xml" | "yaml" | "yml" | "toml" | "html" | "htm" | "css"
        | "scss" | "sass" | "less" | "lua" | "pl" | "ipynb" | "m" | "jl" | "dart" | "scala"
        | "clj" | "ex" | "exs" | "hs" | "asm" | "gradle" | "cmake" => Category::Code,

        // 프로그램·라이브러리
        "exe" | "msi" | "dll" | "sys" | "msix" | "appx" | "bat" | "cmd" | "com" | "scr" | "ocx"
        | "drv" | "efi" | "so" | "dylib" | "deb" | "rpm" | "apk" | "dmg" | "pkg" | "wasm"
        | "node" => Category::Executable,

        // 게임 에셋
        "pak" | "vpk" | "uasset" | "umap" | "upk" | "bsa" | "ba2" | "esm" | "esp" | "wad"
        | "gcf" | "sav" | "rpf" | "big" | "forge" | "assets" | "bundle" => Category::Game,

        // 데이터베이스. Outlook 데이터 파일(.pst/.ost)은 업무 PC 에서 단일 파일이
        // 10~50GB 에 이르는 대표적인 덩어리인데 통째로 '기타'에 떨어져 있었다.
        "db" | "sqlite" | "sqlite3" | "mdb" | "accdb" | "mdf" | "ldf" | "frm" | "ibd" | "myd"
        | "realm" | "edb" | "pst" | "ost" => Category::Database,

        // 모델 가중치·데이터셋. 요즘 개인 디스크에서 가장 빠르게 자라는 축인데
        // 통째로 '기타'에 떨어져 있었다. 직렬화(.pkl 계열)와 줄 단위 교환 포맷도
        // 같은 축이다 — 학습 파이프라인이 GB 단위로 쏟아 내는 것들이다.
        "safetensors" | "gguf" | "ggml" | "onnx" | "ckpt" | "pt" | "pth" | "pb" | "tflite"
        | "parquet" | "h5" | "hdf5" | "npy" | "npz" | "arrow" | "feather" | "orc" | "tfrecord"
        | "mlmodel" | "pkl" | "pickle" | "joblib" | "jsonl" | "ndjson" | "msgpack" => {
            Category::Dataset
        }

        // 폰트
        "ttf" | "otf" | "woff" | "woff2" | "eot" | "fon" | "ttc" | "pfb" => Category::Font,

        // 디스크 이미지·가상 디스크. 가상 머신의 **런타임 상태**(.vmem/.vmsn/.vmss/
        // .nvram/.avhdx)도 여기 둔다 — 스냅샷 하나가 게스트 메모리 크기만큼 잡히므로
        // 사용자가 찾는 덩어리는 대개 이쪽이다.
        // `.bin`은 펌웨어·모델 가중치·게임 데이터가 더 흔해 디스크 이미지로 단정하지 않는다.
        "iso" | "vhd" | "vhdx" | "vmdk" | "vdi" | "qcow2" | "img" | "cue" | "nrg" | "wim"
        | "esd" | "vmem" | "vmsn" | "vmss" | "nvram" | "avhdx" | "avhd" => Category::DiskImage,

        // 캐시·임시·로그·빌드 중간 산출물. 이벤트 로그(.evtx)·크래시 덤프(.mdmp/.wer)·
        // 공통 로그 파일 시스템(.blf)은 C: 에서 수 GB 를 조용히 차지한다.
        // `.pack`/`.idx`는 git 오브젝트 팩이라 .git 힌트 밖(bare 저장소 등)에서도 잡아야 한다.
        "tmp" | "temp" | "cache" | "log" | "dmp" | "etl" | "bak" | "old" | "crdownload"
        | "part" | "partial" | "pyc" | "pyo" | "o" | "obj" | "pdb" | "ilk" | "lock" | "swp"
        | "lib" | "rlib" | "rmeta" | "exp" | "gcda" | "gcno" | "evtx" | "mdmp" | "wer" | "blf"
        | "pack" | "idx" => Category::Cache,

        _ => Category::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_labels_cover_every_variant() {
        for (i, c) in ALL_CATEGORIES.iter().enumerate() {
            assert_eq!(c.index(), i);
            assert!(!c.key().is_empty());
            assert!(!c.label().is_empty());
            // 색은 7자리 hex 여야 한다 — 오타가 나면 프런트에서 조용히 검게 그려진다.
            assert_eq!(c.color().len(), 7, "{} 색상 표기가 이상하다", c.key());
            assert!(c.color().starts_with('#'));
        }
    }

    #[test]
    fn classifies_representative_extensions() {
        assert_eq!(classify_ext("mkv"), Category::Video);
        assert_eq!(classify_ext("dng"), Category::Image);
        assert_eq!(classify_ext("flac"), Category::Audio);
        assert_eq!(classify_ext("hwp"), Category::Document);
        assert_eq!(classify_ext("7z"), Category::Archive);
        assert_eq!(classify_ext("rs"), Category::Code);
        assert_eq!(classify_ext("dll"), Category::Executable);
        assert_eq!(classify_ext("uasset"), Category::Game);
        assert_eq!(classify_ext("sqlite3"), Category::Database);
        assert_eq!(classify_ext("woff2"), Category::Font);
        assert_eq!(classify_ext("vhdx"), Category::DiskImage);
        assert_eq!(classify_ext("pyc"), Category::Cache);
        assert_eq!(classify_ext("safetensors"), Category::Dataset);
        assert_eq!(classify_ext("parquet"), Category::Dataset);
        assert_eq!(classify_ext("jar"), Category::Archive);
        assert_eq!(classify_ext("rlib"), Category::Cache);
        assert_eq!(classify_ext(""), Category::Other);
        assert_eq!(classify_ext("zzz"), Category::Other);
    }

    /// 실사용 디스크에서 단일 파일이 GB 단위를 차지하는 확장자 표.
    ///
    /// 커버리지를 회귀 대상으로 만든다 — 여기서 `Other` 가 나오면 '분야별 구성'
    /// 패널이 그만큼 의사결정에 기여하지 못하고, '기타'가 구조적으로 부풀려진다.
    /// 사전을 늘릴 때 근거가 코드 안에 남도록 분야까지 못 박는다.
    #[test]
    fn known_space_hogs_are_never_unclassified() {
        const KNOWN: [(&str, Category); 30] = [
            // 업무 PC 에서 10~50GB 에 이르는 메일 저장소.
            ("pst", Category::Database),
            ("ost", Category::Database),
            ("edb", Category::Database),
            // 시스템 로그·크래시 덤프.
            ("evtx", Category::Cache),
            ("mdmp", Category::Cache),
            ("wer", Category::Cache),
            ("blf", Category::Cache),
            ("pack", Category::Cache),
            ("idx", Category::Cache),
            // 가상 머신 런타임 상태. 스냅샷 하나가 게스트 메모리만큼 잡힌다.
            ("vmem", Category::DiskImage),
            ("vmsn", Category::DiskImage),
            ("vmss", Category::DiskImage),
            ("nvram", Category::DiskImage),
            ("avhdx", Category::DiskImage),
            // 학습 파이프라인 산출물.
            ("pkl", Category::Dataset),
            ("pickle", Category::Dataset),
            ("joblib", Category::Dataset),
            ("jsonl", Category::Dataset),
            ("ndjson", Category::Dataset),
            ("msgpack", Category::Dataset),
            // 최신 이미지 코덱과 제조사 RAW.
            ("avif", Category::Image),
            ("jxl", Category::Image),
            ("jfif", Category::Image),
            ("orf", Category::Image),
            ("rw2", Category::Image),
            ("raf", Category::Image),
            ("sr2", Category::Image),
            // 문서·메일 한 통.
            ("chm", Category::Document),
            ("xps", Category::Document),
            ("msg", Category::Document),
        ];

        for (ext, expected) in KNOWN {
            assert_eq!(
                classify_ext(ext),
                expected,
                "'{}' 이(가) 분류표에서 빠졌다 — '기타'가 그만큼 부풀려진다",
                ext
            );
        }
    }

    #[test]
    fn bin_is_not_assumed_to_be_a_disk_image() {
        // 펌웨어·모델 가중치·게임 데이터가 훨씬 흔하다. 단정하느니 미분류가 낫다.
        assert_eq!(classify_ext("bin"), Category::Other);
        // `.dat` 도 같은 이유로 남겨 둔다 — 브라우저 캐시 컨테이너부터 게임 세이브,
        // 계측 장비 출력까지 무엇이든 될 수 있어 한 분야로 적으면 거짓말이 된다.
        // 되짚을 경로는 `otherExtensions` 목록이 대신 연다.
        assert_eq!(classify_ext("dat"), Category::Other);
    }

    #[test]
    fn directory_hint_matches_known_names() {
        assert_eq!(hint_from_dir("node_modules", None), Some(Category::Cache));
        assert_eq!(hint_from_dir(".GIT", None), Some(Category::Cache));
        assert_eq!(hint_from_dir("SteamApps", None), Some(Category::Game));
        assert_eq!(hint_from_dir("Documents", None), None);
    }

    #[test]
    fn inherited_hint_wins_over_child_name() {
        // 첫 판정이 가장 넓은 맥락이다. node_modules 안의 steamapps 는 여전히 캐시다.
        assert_eq!(
            hint_from_dir("steamapps", Some(Category::Cache)),
            Some(Category::Cache)
        );
        assert_eq!(
            hint_from_dir("아무이름", Some(Category::Game)),
            Some(Category::Game)
        );
    }

    #[test]
    fn ambiguous_build_dirs_need_a_fingerprint() {
        // 이름만으로는 힌트가 붙지 않아야 한다.
        assert_eq!(hint_from_dir("target", None), None);
        assert_eq!(hint_from_dir("obj", None), None);
        assert!(is_conditional_cache_dir("Target"));
        assert!(is_conditional_cache_dir("OBJ"));
        assert!(!is_conditional_cache_dir("temp"));
    }
}
