export const metadata = { title: "Jobs" };
import Link from "next/link";
import { read } from "@/lib/data";
import { pageNumber } from "@/lib/model";
import { PageHeading, Pager, Empty } from "@/components/shared";
import { JobList } from "@/components/job-list";
import { Card, CardContent } from "@/components/ui/card";
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; page?: string }>;
}) {
  const p = await searchParams,
    state = ["ready", "queued", "running", "failed", "unknown"].includes(
      p.state ?? "",
    )
      ? p.state!
      : "";
  const d = await read((q) => q.jobs(state, pageNumber(p.page)));
  return (
    <>
      <PageHeading
        eyebrow="TRANSLATION ACTIVITY"
        title="Jobs"
        description="Inspect saved results, unfinished work, and requests that need review."
      />
      <nav className="filter-tabs" aria-label="Filter jobs">
        {["", "ready", "queued", "running", "failed", "unknown"].map((s) => (
          <Link
            prefetch={false}
            key={s}
            href={"/jobs?state=" + s}
            aria-current={s === state ? "page" : undefined}
          >
            {s === ""
              ? "All requests"
              : s === "unknown"
                ? "Needs review"
                : s.charAt(0).toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </nav>
      <Card>
        <CardContent>
          {d.rows.length ? (
            <JobList rows={d.rows} />
          ) : (
            <Empty
              title="No matching requests"
              detail="Requests with this status will appear here."
            />
          )}
          <Pager {...d} base="/jobs" params={{ state }} />
        </CardContent>
      </Card>
      <p className="page-note">
        Worker duration excludes queue time. Uncertain requests retain their
        budget reservation until reviewed.
      </p>
    </>
  );
}
