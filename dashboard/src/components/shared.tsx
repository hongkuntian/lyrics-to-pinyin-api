import Link from "next/link";
import { ArrowLeft, ArrowRight, Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PAGE_SIZE } from "@/lib/model";
export function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={`status status-${value}`}>
      <span />
      {value === "ready"
        ? "Saved"
        : value === "unknown"
          ? "Needs review"
          : value.charAt(0).toUpperCase() + value.slice(1)}
    </Badge>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Inbox size={28} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
export function Pager({
  total,
  page,
  base,
  params = {},
}: {
  total: number;
  page: number;
  base: string;
  params?: Record<string, string>;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const url = (n: number) =>
    base + "?" + new URLSearchParams({ ...params, page: String(n) });
  return (
    <div className="pager">
      <span>
        {total} {total === 1 ? "result" : "results"} · Page {page} of {pages}
      </span>
      <div>
        {page > 1 && (
          <Button asChild variant="outline">
            <Link prefetch={false} href={url(page - 1)}>
              <ArrowLeft />
              Previous
            </Link>
          </Button>
        )}
        {page < pages && (
          <Button asChild variant="outline">
            <Link prefetch={false} href={url(page + 1)}>
              Next
              <ArrowRight />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
