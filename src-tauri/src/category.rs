//! 파일을 "분야"로 분류한다.
//!
//! 분류는 두 단계다. 디렉터리를 내려가면서 이름으로 힌트를 잡고(`hint_from_dir`),
//! 힌트가 잡힌 하위 트리는 확장자를 무시한 채 그 힌트를 따른다.
//! `node_modules` 안의 `.js`는 코드가 아니라 의존성 캐시이기 때문이다.

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
    Font,
    DiskImage,
    Other,
}

pub const CATEGORY_COUNT: usize = 13;

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
    Category::Font,
    Category::DiskImage,
    Category::Other,
];

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
            Category::Font => "폰트",
            Category::DiskImage => "디스크 이미지",
            Category::Other => "기타",
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
    // Rust/Java 빌드 산출물. `target`은 흔한 단어라 하위에 빌드 흔적이 있는지까지는
    // 보지 않는다 — 오분류 위험보다 미분류 위험이 크다고 판단.
    if lower == "target" || lower == "obj" || lower == "__pycache__" {
        return Some(Category::Cache);
    }

    None
}

/// 확장자로 분류한다. 확장자는 소문자, 점 없이 전달할 것.
pub fn classify_ext(ext: &str) -> Category {
    match ext {
        // 영상. `.ts`는 MPEG 전송 스트림이기도 하지만 TypeScript 쪽 빈도가 압도적이라
        // 코드로 넘긴다. 영상 컨테이너는 `.m2ts`/`.mts`로 대개 커버된다.
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg"
        | "m2ts" | "vob" | "rmvb" | "3gp" | "mts" => Category::Video,

        // 이미지
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "svg" | "heic"
        | "heif" | "ico" | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "psd" | "ai"
        | "xcf" => Category::Image,

        // 음악
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "aiff" | "alac"
        | "mid" | "midi" | "ape" => Category::Audio,

        // 문서
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "hwp" | "hwpx" | "txt"
        | "md" | "rtf" | "odt" | "ods" | "odp" | "epub" | "mobi" | "azw3" | "csv" | "tex"
        | "pages" | "numbers" | "key" => Category::Document,

        // 압축
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "lz4" | "cab" | "arj"
        | "tgz" | "egg" | "whl" => Category::Archive,

        // 코드
        "c" | "cpp" | "cc" | "cxx" | "h" | "hpp" | "rs" | "go" | "py" | "js" | "mjs" | "cjs"
        | "ts" | "tsx" | "jsx" | "java" | "kt" | "swift" | "rb" | "php" | "cs" | "vb" | "sh"
        | "ps1" | "sql" | "json" | "xml" | "yaml" | "yml" | "toml" | "html" | "htm" | "css"
        | "scss" | "sass" | "less" | "lua" | "pl" | "ipynb" | "m" | "jl" | "dart"
        | "scala" | "clj" | "ex" | "exs" | "hs" | "asm" | "gradle" | "cmake" => Category::Code,

        // 프로그램·라이브러리
        "exe" | "msi" | "dll" | "sys" | "msix" | "appx" | "bat" | "cmd" | "com" | "scr"
        | "ocx" | "drv" | "efi" | "so" | "dylib" | "deb" | "rpm" | "apk" | "dmg"
        | "pkg" => Category::Executable,

        // 게임 에셋
        "pak" | "vpk" | "uasset" | "umap" | "upk" | "bsa" | "ba2" | "esm" | "esp" | "wad"
        | "gcf" | "sav" | "rpf" | "big" | "forge" | "assets" | "bundle" => Category::Game,

        // 데이터베이스
        "db" | "sqlite" | "sqlite3" | "mdb" | "accdb" | "mdf" | "ldf" | "frm" | "ibd"
        | "myd" | "realm" | "edb" => Category::Database,

        // 폰트
        "ttf" | "otf" | "woff" | "woff2" | "eot" | "fon" | "ttc" | "pfb" => Category::Font,

        // 디스크 이미지·가상 디스크
        "iso" | "vhd" | "vhdx" | "vmdk" | "vdi" | "qcow2" | "img" | "bin" | "cue" | "nrg"
        | "wim" | "esd" => Category::DiskImage,

        // 캐시·임시·로그
        "tmp" | "temp" | "cache" | "log" | "dmp" | "etl" | "bak" | "old" | "crdownload"
        | "part" | "partial" | "pyc" | "pyo" | "o" | "obj" | "pdb" | "ilk" | "lock"
        | "swp" => Category::Cache,

        _ => Category::Other,
    }
}
