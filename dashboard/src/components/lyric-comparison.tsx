import type { Line } from "@/lib/model";
export function LyricComparison({
  lines,
  focus,
  language,
}: {
  lines: Line[];
  focus?: string;
  language: string;
}) {
  return (
    <div className="lyric-comparison">
      <div className="lyric-column-head">
        <span>ORIGINAL & PRONUNCIATION</span>
        <span>ENGLISH TRANSLATION</span>
      </div>
      {lines.map((line) => (
        <div
          id={line.source_id}
          key={line.source_id}
          className={
            "lyric-pair" + (focus === line.source_id ? " lyric-focus" : "")
          }
        >
          <div className="lyric-source">
            <span className="line-index">
              {String(line.position).padStart(2, "0")}
            </span>
            <div>
              <p lang={language}>{line.lyric_text}</p>
              <small>{line.pronunciation}</small>
              <span className="source-id">
                {line.source_id}
                {focus === line.source_id ? " · Reported line" : ""}
              </span>
            </div>
          </div>
          <p className="lyric-translation">
            {line.translation ?? "Translation not saved"}
          </p>
        </div>
      ))}
    </div>
  );
}
