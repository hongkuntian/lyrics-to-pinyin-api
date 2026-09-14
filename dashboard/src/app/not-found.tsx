import Link from "next/link";
import { Empty } from "@/components/shared";
export default function NotFound() {
  return (
    <>
      <Empty
        title="Record not found"
        detail="This saved record could not be found."
      />
      <Link href="/songs" className="back-link">
        Back to songs
      </Link>
    </>
  );
}
