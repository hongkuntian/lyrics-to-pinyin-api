// Vercel: exit 0 skips, exit 1 builds. Unknown revisions/paths always build.
import { execFileSync } from "node:child_process";
export function shouldSkip(target, paths) {
  if (!paths.length) return true;
  if (target === "backend")
    return paths.every(
      (p) => p.startsWith("dashboard/") || p === "docs/DASHBOARD.md",
    );
  return false;
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    const before = process.env.VERCEL_GIT_PREVIOUS_SHA,
      after = process.env.VERCEL_GIT_COMMIT_SHA;
    if (
      !before ||
      !after ||
      ![before, after].every((x) => /^[a-f0-9]{40}$/.test(x))
    )
      process.exit(1);
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "-z", before, after],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    process.exit(shouldSkip(process.argv[2], paths) ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
