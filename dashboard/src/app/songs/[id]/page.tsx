export const metadata = { title: "Song details" };
import Link from "next/link";
import { notFound } from "next/navigation";
import { read } from "@/lib/data";
import { stamp } from "@/lib/model";
import { PageHeading, Status } from "@/components/shared";
import { LyricComparison } from "@/components/lyric-comparison";
import { ReportsList } from "@/components/reports-list";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
export default async function SongPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = await read((q) => q.song(id));
  if (!d) notFound();
  return (
    <>
      <Link prefetch={false} href="/songs" className="back-link">
        ← All songs
      </Link>
      <PageHeading
        eyebrow={d.song.artist}
        title={d.song.title}
        description={`${d.song.line_count} lyric occurrences · ${d.song.language.toUpperCase()} → English`}
      />
      <div className="song-meta">
        <Status value={d.song.translation_id ? "ready" : "missing"} />
        <span>Saved {stamp(d.song.translated_at ?? d.song.created_at)}</span>
      </div>
      <Card className="comparison-card">
        <CardContent>
          <LyricComparison language={d.song.language} lines={d.lines} />
        </CardContent>
      </Card>
      <details className="provenance">
        <summary>Saved version details</summary>
        <dl>
          <dt>Document</dt>
          <dd>{d.song.id}</dd>
          <dt>Source hash</dt>
          <dd>{d.song.source_hash}</dd>
          <dt>Source selection</dt>
          <dd>{d.song.selection_revision}</dd>
          <dt>Translation recipe</dt>
          <dd>{d.song.recipe ?? "Not translated"}</dd>
          <dt>Translation ID</dt>
          <dd>{d.song.translation_id ?? "—"}</dd>
        </dl>
      </details>
      {d.reports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Reports on this song</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportsList reports={d.reports} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
