import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading saved records"
      className="loading-state"
    >
      <Skeleton className="h-9 w-52" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <div className="stats-grid">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
