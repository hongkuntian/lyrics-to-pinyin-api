export const metadata = { title: "Report details" };
import Link from "next/link";
import { notFound } from "next/navigation";
import { read } from "@/lib/data";
import { stamp } from "@/lib/model";
import { PageHeading, Status } from "@/components/shared";
import { LyricComparison } from "@/components/lyric-comparison";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = await read((q) => q.report(id));
  if (!d) notFound();
  const position = d.lines.findIndex((l) => l.source_id === d.report.source_id);
  const context =
    position < 0 ? [] : d.lines.slice(Math.max(0, position - 2), position + 3);
  return (
    <>
      <Link prefetch={false} href="/reports" className="back-link">
        ← All reports
      </Link>
      <PageHeading
        eyebrow={d.report.category + " · " + d.report.source_id}
        title={d.song.title}
        description={d.song.artist}
      />
      <div className="song-meta">
        <Status value={d.report.status} />
        <span>Reported {stamp(d.report.created_at)}</span>
      </div>
      <Card className="report-detail">
        <CardHeader>
          <CardTitle>Listener report</CardTitle>
        </CardHeader>
        <CardContent>
          <p>{d.report.detail}</p>
          <small>
            Report status does not mean a correction has been applied.
          </small>
        </CardContent>
      </Card>
      <Card className="report-detail">
        <CardHeader><CardTitle>Luna assessment</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {d.review ? <>
            <p>{d.review.decision ? `Recommendation: ${d.review.decision}` : `Review ${d.review.state}`}</p>
            {d.review.summary && <p>{d.review.summary}</p>}
            {d.review.reason && <p className="text-sm text-muted-foreground">{d.review.reason.replaceAll("_", " ")}</p>}
            {d.review.comparison && <p>Fresh comparison: {d.review.comparison.replaceAll("_", " ")}</p>}
            {d.review.comparison_summary && <p>{d.review.comparison_summary}</p>}
            <p>{d.review.disposition === "published" ? `Correction published ${stamp(d.review.closed_at)}.` : d.review.disposition ? "The original translation has been retained by this review." : "This review has not published a change."}</p>
            <small>AI assessment of the reported revision. Agreement between model calls does not establish bilingual human validation.</small>
          </> : <p className="text-sm text-muted-foreground">Translation reports with an exact saved revision enter the daily queue. Lyrics, timing and pronunciation reports await a later evidence workflow.</p>}
        </CardContent>
      </Card>
      {d.changes.length > 0 && <Card className="report-detail">
        <CardHeader><CardTitle>{d.review?.disposition === "published" ? "Published correction" : "Proposed correction"}</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          {d.changes.map(change => <div key={change.source_id} className="space-y-2">
            <p className="text-sm text-muted-foreground">{change.source_id}</p>
            <p lang={d.song.language}>{change.source_text}</p>
            <p><strong>Before: </strong>{change.before}</p>
            <p><strong>After: </strong>{change.after}</p>
            <p className="text-sm text-muted-foreground">{change.reason}</p>
          </div>)}
        </CardContent>
      </Card>}
      <Card className="comparison-card">
        <CardHeader className="section-header">
          <CardTitle>Lyric context</CardTitle>
          <Link
            prefetch={false}
            className="inline-link"
            href={"/songs/" + d.song.id + "#" + d.report.source_id}
          >
            Open full song ↗
          </Link>
        </CardHeader>
        <CardContent>
          {context.length ? (
            <LyricComparison
              language={d.song.language}
              lines={context}
              focus={d.report.source_id}
            />
          ) : (
            <p>Reported occurrence is unavailable in this document.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
