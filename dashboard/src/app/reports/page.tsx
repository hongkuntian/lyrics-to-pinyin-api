export const metadata = { title: "Reports" };
import Link from "next/link";
import { read } from "@/lib/data";
import { pageNumber } from "@/lib/model";
import { PageHeading, Pager } from "@/components/shared";
import { ReportsList } from "@/components/reports-list";
import { ReviewProgressCard } from "@/components/review-progress";
import { Card, CardContent } from "@/components/ui/card";
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const p = await searchParams,
    status = ["pending", "accepted", "rejected", ""].includes(
      p.status ?? "pending",
    )
      ? (p.status ?? "pending")
      : "pending";
  const {d,progress} = await read(async (q) => ({d:await q.reports(status, pageNumber(p.page)),progress:await q.reviewProgress()}));
  return (
    <>
      <PageHeading
        eyebrow="LISTENER FEEDBACK"
        title="Reports"
        description="Read each report alongside the exact saved lyric and its song context."
      />
      <ReviewProgressCard progress={progress} />
      <nav className="filter-tabs" aria-label="Filter reports">
        {["pending", "accepted", "rejected", ""].map((s) => (
          <Link
            prefetch={false}
            key={s}
            href={"/reports?status=" + s}
            aria-current={s === status ? "page" : undefined}
          >
            {s === "" ? "All reports" : s.charAt(0).toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </nav>
      <Card>
        <CardContent>
          <ReportsList reports={d.rows} />
          <Pager {...d} base="/reports" params={{ status }} />
        </CardContent>
      </Card>
    </>
  );
}
