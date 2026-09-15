import Link from "next/link";
import { randomUUID } from "node:crypto";
import { read } from "@/lib/data";
import { owner } from "@/lib/owner";
import { money, stamp, type ControlAction } from "@/lib/model";
import { PageHeading } from "@/components/shared";
import { OwnerStatus } from "@/components/owner-status";
import { OwnerForm } from "@/components/owner-form";
import { OperationalAlerts } from "@/components/operational-alerts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
export const metadata = { title: "Automation" };
function actionLabel(a: ControlAction) {
  if (a.kind === "rollback")
    return `Restored translation as version ${a.after_state.sequence}`;
  const labels = {
    paid_work: "Paid work",
    reviews: "Report review",
    publication: "Correction publication",
  };
  const field = (Object.keys(labels) as (keyof typeof labels)[]).find(
    (k) => a.before_state[k] !== a.after_state[k],
  );
  return field
    ? `${labels[field]} ${a.after_state[field] ? "resumed" : "paused"}`
    : "Automation controls updated";
}
export default async function AutomationPage() {
  const identity = await owner();
  const { overview, review, actions, alerts } = await read(async (q) => ({
    overview: await q.overview(),
    review: await q.reviewProgress(),
    actions: await q.controlActions(),
    alerts: await q.alerts(),
  }));
  const controls = [
    {
      key: "paid_work",
      title: "Paid work",
      enabled: overview.settings.enabled,
      description:
        "Admit new paid work and apply corrections. Pausing keeps saved content available.",
    },
    {
      key: "reviews",
      title: "Report review",
      enabled: review.review_enabled,
      description:
        "Assess grouped reports and progress automatic corrections. Pausing leaves reports queued.",
    },
    {
      key: "publication",
      title: "Correction publication",
      enabled: review.review_publication_enabled,
      description:
        "Compare proposed corrections and publish those that pass. Pausing keeps current translations in place.",
    },
  ];
  return (
    <>
      <PageHeading
        eyebrow="OPERATIONS"
        title="Automation"
        description="Routine corrections run automatically. These controls are here when you need to intervene."
      />
      <OwnerStatus />
      <OperationalAlerts data={alerts}/>
      <div className="automation-grid">
        {controls.map((c) => (
          <Card key={c.key}>
            <CardHeader>
              <CardTitle>{c.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p
                className={`control-state ${c.enabled ? "control-running" : "control-paused"}`}
              >
                {c.enabled ? "Enabled" : "Paused"}
              </p>
              <p className="control-description">{c.description}</p>
              <OwnerForm
                key={`${c.key}:${overview.settings.control_version}`}
                disabled={!identity}
                label={`${c.enabled ? "Pause" : "Resume"} ${c.title.toLowerCase()}`}
                fields={{
                  kind: "control",
                  requestID: randomUUID(),
                  version: overview.settings.control_version,
                  control: c.key,
                  enabled: String(!c.enabled),
                }}
              />
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="page-note">
        All required switches must be enabled for corrections to publish. Work
        already sent to a provider may finish and remains accounted for. A pause
        does not cancel requests or release reserved funds.
      </p>
      <div className="automation-grid automation-details">
        <Card>
          <CardHeader>
            <CardTitle>Spending protection</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="detail-list">
              <div>
                <dt>All paid work</dt>
                <dd>
                  {money(overview.settings.daily_micros, 2)}/day ·{" "}
                  {money(overview.settings.monthly_micros, 2)}/month
                </dd>
              </div>
              <div>
                <dt>Reviews, within that budget</dt>
                <dd>
                  {money(review.review_daily_micros, 2)}/day ·{" "}
                  {money(review.review_monthly_micros, 2)}/month
                </dd>
              </div>
              <div>
                <dt>New song reviews</dt>
                <dd>At most {review.review_max_daily}/day</dd>
              </div>
              <div>
                <dt>Unsettled reservations</dt>
                <dd>{money(overview.reserved)}</dd>
              </div>
            </dl>
            <p className="page-note">
              Resuming keeps these limits. It does not retry uncertain requests
              or increase your budget.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Worker status</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="detail-list">
              <div>
                <dt>Last run</dt>
                <dd>{stamp(review.last_run_at)}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{review.last_outcome ?? "No run yet"}</dd>
              </div>
              <div>
                <dt>Reports waiting</dt>
                <dd>{review.pending}</dd>
              </div>
              <div>
                <dt>Blocked reviews</dt>
                <dd>{review.blocked}</dd>
              </div>
            </dl>
            {review.error_code && (
              <p className="page-note">Worker issue: {review.error_code}</p>
            )}
            <Link href="/reports" className="inline-link">
              View report review details →
            </Link>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Owner action history</CardTitle>
        </CardHeader>
        <CardContent>
          {actions.length ? (
            <ol className="revision-list">
              {actions.map((a) => (
                <li key={a.id}>
                  <div>
                    <strong>{actionLabel(a)}</strong>
                    <small>
                      {stamp(a.created_at)} · {a.actor}
                    </small>
                    {a.document_id && (
                      <Link
                        className="inline-link"
                        href={`/songs/${a.document_id}`}
                      >
                        Open song →
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="page-note">
              No owner actions recorded. Automatic corrections appear in each
              song’s translation history.
            </p>
          )}
          {actions.length === 50 && (
            <p className="page-note">
              Showing the most recent 50 owner actions.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
