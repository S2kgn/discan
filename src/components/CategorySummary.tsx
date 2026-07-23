import { CATEGORY_COLORS, CategoryStat } from "../types";
import { formatBytes, formatCount, percent } from "../lib/format";

interface Props {
  categories: CategoryStat[];
  totalSize: number;
}

export function CategorySummary({ categories, totalSize }: Props) {
  if (categories.length === 0) return null;

  return (
    <section className="panel">
      <h2 className="panel-title">분야별 구성</h2>

      <div className="stacked-bar" role="img" aria-label="분야별 용량 비중">
        {categories.map((c) => {
          const width = percent(c.size, totalSize);
          if (width < 0.1) return null;
          return (
            <div
              key={c.key}
              className="stacked-seg"
              style={{
                width: `${width}%`,
                background: CATEGORY_COLORS[c.key] ?? CATEGORY_COLORS.other,
              }}
              title={`${c.label} · ${formatBytes(c.size)} (${width.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      <ul className="cat-list">
        {categories.map((c) => (
          <li key={c.key} className="cat-row">
            <span
              className="cat-dot"
              style={{ background: CATEGORY_COLORS[c.key] ?? CATEGORY_COLORS.other }}
            />
            <span className="cat-label">{c.label}</span>
            <span className="cat-pct">{percent(c.size, totalSize).toFixed(1)}%</span>
            <span className="cat-size">{formatBytes(c.size)}</span>
            <span className="cat-files">{formatCount(c.files)}개</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
