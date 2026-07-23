export interface ScanNode {
  name: string;
  path: string;
  size: number;
  files: number;
  isDir: boolean;
  children: ScanNode[];
  /** 가지치기로 잘려나간 자식 수. 0보다 크면 트리가 일부 생략되었다. */
  truncated: number;
}

export interface CategoryStat {
  key: string;
  label: string;
  size: number;
  files: number;
}

export interface ScanResult {
  root: ScanNode;
  categories: CategoryStat[];
  totalSize: number;
  totalFiles: number;
  totalDirs: number;
  errors: number;
  elapsedMs: number;
  cancelled: boolean;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
}

export interface DriveInfo {
  path: string;
  label: string;
  total: number;
  free: number;
}

/** 분야별 색. Rust 쪽 Category::key() 와 키가 일치해야 한다. */
export const CATEGORY_COLORS: Record<string, string> = {
  video: "#e05263",
  image: "#f2994a",
  audio: "#f2c94c",
  document: "#4a9df2",
  archive: "#9b6ef3",
  code: "#27ae8f",
  executable: "#5b7fff",
  game: "#eb5fc0",
  cache: "#7d8799",
  database: "#00b8a9",
  font: "#c98bdb",
  diskimage: "#d4694a",
  other: "#5a6472",
};
