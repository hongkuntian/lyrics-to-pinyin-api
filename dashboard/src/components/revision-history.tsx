import Link from "next/link";
import { stamp, type Revision } from "@/lib/model";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
export function RevisionHistory({ revisions }: { revisions: Revision[] }) {
  return (
    <Card className="history-card">
      <CardHeader>
        <CardTitle>Translation history</CardTitle>
      </CardHeader>
      <CardContent>
        {revisions.length ? (
          <ol className="revision-list">
            {revisions.map((r) => (
              <li key={r.id}>
                <div>
                  <Link
                    prefetch={false}
                    href={`/songs/${r.document_id}/revisions/${r.id}`}
                    className="entity-link"
                  >
                    Version {r.sequence} ·{" "}
                    {r.origin === "rollback"
                      ? "Restored"
                      : r.origin === "correction"
                        ? "Correction"
                        : "Original translation"}
                  </Link>
                  <p>{r.reason}</p>
                  <small>
                    {stamp(r.created_at)} · {r.actor}
                  </small>
                </div>
                <span>{r.current ? "Current" : "View & compare →"}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="page-note">No saved translation yet.</p>
        )}
        {revisions.length === 100 && (
          <p className="page-note">Showing the most recent 100 versions.</p>
        )}
      </CardContent>
    </Card>
  );
}
