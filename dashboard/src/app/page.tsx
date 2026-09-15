import Link from "next/link";
import {
  ArrowUpRight,
  Library,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { read } from "@/lib/data";
import { money, remaining, percent, stamp } from "@/lib/model";
import { PageHeading, Empty } from "@/components/shared";
import { JobList } from "@/components/job-list";
import { SpendChart } from "@/components/spend-chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
export default async function OverviewPage() {
  const {d,alerts} = await read(async(q) => ({d:await q.overview(),alerts:await q.alerts()}));
  return (
    <>
      <PageHeading
        eyebrow="YOUR TRANSLATION WORKSPACE"
        title="Overview"
        description="Every saved song. Every request. A clear view of your budget."
      />
      {(alerts.active.length>0||!alerts.monitor.email_configured)&&<p className="overview-alert">
        <Link href="/automation#alerts">{alerts.active.length>0?`${alerts.active.length} operational ${alerts.active.length===1?'issue needs':'issues need'} attention`:'Set up email alerts'} →</Link>
      </p>}
      <div className="overview-status">
        <span>
          <ShieldCheck size={16} />
          {d.settings.enabled
            ? "New translations enabled"
            : "New translations paused"}
        </span>
        <small>Updated {stamp(d.updated)}</small>
      </div>
      <div className="stats-grid">
        {[
          {
            title: "Today’s budget",
            used: d.today,
            limit: d.settings.daily_micros,
          },
          {
            title: "Monthly budget",
            used: d.month,
            limit: d.settings.monthly_micros,
          },
        ].map((c) => (
          <Card key={c.title}>
            <CardHeader>
              <CardDescription>{c.title}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="budget-value">
                {money(c.used)}
                <span> / {money(c.limit, 2)}</span>
              </div>
              <div className="budget-track">
                <span style={{ width: percent(c.used, c.limit) + "%" }} />
              </div>
              <p className="card-note">
                {money(remaining(c.limit, c.used))} available
              </p>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader>
            <CardDescription>Saved translations</CardDescription>
            <Library className="stat-icon" size={18} />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{d.translations}</div>
            <Link
              prefetch={false}
              className="card-note inline-link"
              href="/songs"
            >
              Across {d.songs} lyric documents <ArrowUpRight size={14} />
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Pending reports</CardDescription>
            <MessageSquare className="stat-icon" size={18} />
          </CardHeader>
          <CardContent>
            <div className="stat-value">{d.reports}</div>
            <Link
              prefetch={false}
              className="card-note inline-link"
              href="/reports"
            >
              Review listener feedback <ArrowUpRight size={14} />
            </Link>
          </CardContent>
        </Card>
      </div>
      <div className="overview-middle">
        <Card>
          <CardHeader>
            <CardTitle>Budget activity</CardTitle>
            <CardDescription>Last seven days · UTC</CardDescription>
          </CardHeader>
          <CardContent>
            <SpendChart data={d.trend} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>At a glance</CardTitle>
            <CardDescription>Current month</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="detail-list">
              <div>
                <dt>Usage-based estimates</dt>
                <dd>{money(d.estimated, 6)}</dd>
              </div>
              <div>
                <dt>Reserved / uncertain</dt>
                <dd>{money(d.reserved, 6)}</dd>
              </div>
              <div>
                <dt>Jobs needing attention</dt>
                <dd>
                  <Link prefetch={false} href="/jobs">
                    {d.attention}
                  </Link>
                </dd>
              </div>
              <div>
                <dt>New requests per user</dt>
                <dd>
                  {d.settings.user_daily}/day · {d.settings.user_monthly}/month
                </dd>
              </div>
            </dl>
            <p className="context-note">
              Budget usage includes reservations for unfinished or uncertain
              requests. It is not an OpenAI invoice or credit balance.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="section-header">
          <div>
            <CardTitle>Recent requests</CardTitle>
            <CardDescription>The latest translation work</CardDescription>
          </div>
          <Link prefetch={false} href="/jobs" className="inline-link">
            View all <ArrowUpRight size={15} />
          </Link>
        </CardHeader>
        <CardContent>
          {d.recent.length ? (
            <JobList rows={d.recent} compact />
          ) : (
            <Empty
              title="No translation requests yet"
              detail="New requests from Lyra will appear here."
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
