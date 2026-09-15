import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { read } from "@/lib/data";
import { owner } from "@/lib/owner";
import { stamp } from "@/lib/model";
import { PageHeading } from "@/components/shared";
import { OwnerStatus } from "@/components/owner-status";
import { OwnerForm } from "@/components/owner-form";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
export const metadata = { title: "Translation version" };
export default async function RevisionPage({
  params,
}: {
  params: Promise<{ id: string; revisionID: string }>;
}) {
  const { id, revisionID } = await params;
  const d = await read((q) => q.revision(id, revisionID));
  if (!d) notFound();
  const identity = await owner(),
    saved = new Map(d.saved.map((l) => [l.source_id, l]));
  const changed = d.lines.filter(
    (l) => l.translation !== saved.get(l.source_id)?.translation,
  ).length;
  const canRestore =
    !d.revision.current &&
    d.revision.source_hash === d.song.source_hash &&
    changed > 0 &&
    !!d.song.translation_id;
  return (
    <>
      <Link prefetch={false} href={`/songs/${id}`} className="back-link">
        ← Song & history
      </Link>
      <PageHeading
        eyebrow={d.song.title}
        title={`Version ${d.revision.sequence}`}
        description={`${d.revision.origin} · ${stamp(d.revision.created_at)}`}
      />
      <p className="revision-reason">{d.revision.reason}</p>
      <OwnerStatus />
      <Card className="comparison-card">
        <CardHeader>
          <CardTitle>
            {d.revision.current
              ? "Current saved translation"
              : `Compare with current · ${changed} changed ${changed === 1 ? "line" : "lines"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="revision-comparison">
            {d.lines.map((line) => (
              <div
                key={line.source_id}
                className={
                  line.translation !== saved.get(line.source_id)?.translation
                    ? "revision-row changed"
                    : "revision-row"
                }
              >
                <div>
                  <small>{line.source_id} · Original</small>
                  <p lang={d.song.language}>{line.lyric_text}</p>
                </div>
                <div>
                  <small>Current translation</small>
                  <p>{line.translation ?? "Not saved"}</p>
                </div>
                <div>
                  <small>
                    Version {d.revision.sequence}
                    {!d.revision.current ? " · Restore this wording" : ""}
                  </small>
                  <p>{saved.get(line.source_id)?.translation ?? "Not saved"}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      {canRestore ? (
        <Card>
          <CardHeader>
            <CardTitle>Restore this saved version</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="control-description">
              Save the exact version shown above as a new revision. The current
              version stays in history. No translation API call is made.
            </p>
            <OwnerForm
              disabled={!identity}
              reason
              label="Restore this version"
              fields={{
                kind: "rollback",
                requestID: randomUUID(),
                document: id,
                source: d.song.source_hash,
                expected: d.song.translation_id!,
                restore: revisionID,
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="page-note">
          {d.revision.current
            ? "This is already the current version."
            : changed === 0
              ? "This wording already matches the current translation."
              : "The source has changed; this saved version cannot be restored."}
        </p>
      )}
    </>
  );
}
