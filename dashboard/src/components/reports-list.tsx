import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Status, Empty } from "./shared";
import type { Report } from "@/lib/model";
import { stamp } from "@/lib/model";
export function ReportsList({ reports }: { reports: Report[] }) {
  return reports.length ? (
    <div className="report-list">
      {reports.map((r) => (
        <Link
          prefetch={false}
          href={"/reports/" + r.id}
          key={r.id}
          className="report-item"
        >
          <div className="report-item-top">
            <div>
              <span className="eyebrow">
                {r.category} · {r.source_id}
              </span>
              <h3>{r.title}</h3>
              <span className="text-sm text-muted-foreground">{r.artist}</span>
            </div>
            <Status value={r.status} />
          </div>
          <p>{r.detail}</p>
          <div className="report-item-bottom">
            <span>{stamp(r.created_at)}</span>
            <span>
              View context <ArrowUpRight size={14} />
            </span>
          </div>
        </Link>
      ))}
    </div>
  ) : (
    <Empty
      title="No reports here"
      detail="Reports will appear here when listeners flag an issue."
    />
  );
}
