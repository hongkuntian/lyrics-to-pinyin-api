import { money, stamp } from "@/lib/model";
import type { ReviewProgress } from "@/lib/model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ReviewProgressCard({ progress: p }: { progress: ReviewProgress }) {
  const issue = p.error_code ?? (p.last_outcome?.includes("exhausted") ? p.last_outcome : null);
  return <Card className="report-detail">
    <CardHeader><CardTitle>Automatic review</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p>{p.review_enabled ? "Scheduled daily · Luna only" : "New assessments paused"}</p>
      <div className="song-meta">
        <span>{p.pending} waiting</span><span>{p.processing} processing</span>
        <span>{p.assessed} assessed</span><span>{p.blocked} deferred by policy</span>
      </div>
      <p>Review allowance: {money(p.review_daily)} / {money(p.review_daily_micros)} today · {money(p.review_monthly)} / {money(p.review_monthly_micros)} this month · up to {p.review_max_daily} song versions per day.</p>
      <p className="text-sm text-muted-foreground">Allowances include outstanding reservations and sit inside the overall API budget. Duplicate reports share one assessment. An empty queue makes no model calls.</p>
      <p className="text-sm">{p.last_run_at ? `Last check ${stamp(p.last_run_at)}${p.provider_status ? ` · Batch ${p.provider_status.replaceAll("_", " ")}` : ""}` : "Waiting for the first scheduled check."}</p>
      {issue && <p role="status">Processing needs attention: {issue.replaceAll("_", " ")}. Reserved funds remain protected.</p>}
      <p className="text-sm text-muted-foreground">Assessments are saved for the next verification stage. Translation publication is not enabled in this checkpoint.</p>
    </CardContent>
  </Card>;
}
