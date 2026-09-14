import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Status } from "./shared";
import type { Job } from "@/lib/model";
import { money, stamp, seconds } from "@/lib/model";
export function JobList({
  rows,
  compact = false,
}: {
  rows: Job[];
  compact?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Song</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Budget usage</TableHead>
          {!compact && (
            <>
              <TableHead>Timing</TableHead>
              <TableHead>Details</TableHead>
            </>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((j) => (
          <TableRow key={j.id}>
            <TableCell>
              <Link
                prefetch={false}
                className="entity-link"
                href={"/songs/" + j.document_id}
              >
                {j.title}
              </Link>
              <small className="cell-sub">{j.artist}</small>
            </TableCell>
            <TableCell>
              <Status value={j.state} />
            </TableCell>
            <TableCell>
              <span className="metric-small">
                {money(j.accounted_micros, 6)}
              </span>
              <small className="cell-sub">
                {j.cost_kind === "estimated"
                  ? "Usage estimate"
                  : "Reserved / uncertain"}
              </small>
            </TableCell>
            {!compact && (
              <>
                <TableCell>
                  <small className="cell-sub">
                    Queued {seconds(j.created_at, j.started_at)}
                  </small>
                  <small className="cell-sub">
                    Worker {seconds(j.started_at, j.finished_at)}
                  </small>
                  {j.stalled && (
                    <small className="attention-text">May be stalled</small>
                  )}
                </TableCell>
                <TableCell className="job-details">
                  <span>{j.error_code ?? "—"}</span>
                  <small className="cell-sub">{stamp(j.created_at)}</small>
                  <small className="cell-sub break-all">{j.id}</small>
                </TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
