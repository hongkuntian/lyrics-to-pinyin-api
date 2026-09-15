"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  AudioLines,
  LayoutDashboard,
  Library,
  Activity,
  MessageSquare,
  LockKeyhole,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
const navigation = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/songs", label: "Songs", icon: Library },
  { href: "/jobs", label: "Jobs", icon: Activity },
  { href: "/reports", label: "Reports", icon: MessageSquare },
  { href: "/automation", label: "Automation", icon: SlidersHorizontal },
];
export function Shell({
  children,
  fixture,
}: {
  children: React.ReactNode;
  fixture: boolean;
}) {
  const path = usePathname(),
    router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <AudioLines size={24} />
          </span>
          <span>
            Lyra<span className="brand-sub">CONTROL ROOM</span>
          </span>
        </Link>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              prefetch={false}
              href={href}
              aria-current={
                (href === "/" ? path === "/" : path.startsWith(href))
                  ? "page"
                  : undefined
              }
            >
              <Icon size={18} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <LockKeyhole size={15} />
          <div>
            Private workspace<small>Owner sign-in for controls</small>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="topbar-title">Translation library</span>
          <div className="topbar-actions">
            <span className="environment">
              <span />
              {fixture ? "Sample data" : "Production"}
            </span>
            <Button
              variant="outline"
              onClick={() => start(() => router.refresh())}
              disabled={pending}
              aria-label="Refresh data"
            >
              <RefreshCw className={pending ? "animate-spin" : ""} />
              <span className="refresh-label">Refresh</span>
            </Button>
          </div>
        </header>
        <main id="main-content">
          {fixture && (
            <div className="fixture-banner">
              Sample workspace · Synthetic songs and reports for verification
            </div>
          )}
          {children}
        </main>
        <footer className="workspace-footer">
          Lyra · Translation operations
          <span>Budget periods reset at 00:00 UTC</span>
        </footer>
      </div>
    </div>
  );
}
