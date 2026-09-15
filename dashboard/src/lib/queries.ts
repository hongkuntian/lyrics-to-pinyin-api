import { PAGE_SIZE, pageNumber, searchText } from "./model";
import type {
  Settings,
  Song,
  Job,
  Report,
  Line,
  Overview,
  Page,
  ReviewProgress,
  ReviewAssessment,
  ReviewChange,
  Revision,
  ControlAction,
} from "./model";
export type Database = {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};
const one = async <T>(db: Database, sql: string, values: unknown[] = []) =>
  (await db.query<T>(sql, values)).rows[0];
const escaped = (value: string) => value.replace(/[\\%_]/g, "\\$&");
const jobStates = new Set(["queued", "running", "ready", "failed", "unknown"]);
const reportStates = new Set(["pending", "accepted", "rejected"]);
export class DashboardQueries {
  constructor(private db: Database) {}
  async controlActions(): Promise<ControlAction[]> {
    return (await this.db.query<ControlAction>("SELECT * FROM lyra_dashboard.control_actions ORDER BY created_at DESC,id DESC LIMIT 50")).rows;
  }
  async revisions(document: string): Promise<Revision[]> {
    if (!/^[a-f0-9]{64}$/.test(document)) return [];
    return (await this.db.query<Revision>("SELECT * FROM lyra_dashboard.revisions WHERE document_id=$1 ORDER BY sequence::bigint DESC LIMIT 100", [document])).rows;
  }
  async revision(document: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(document) || !/^[a-f0-9-]{36}$/.test(id)) return null;
    const revision = await one<Revision>(this.db, "SELECT * FROM lyra_dashboard.revisions WHERE document_id=$1 AND id=$2", [document,id]);
    if (!revision) return null;
    const detail = await this.song(document);
    if (!detail) return null;
    const saved = (await this.db.query<Line>("SELECT * FROM lyra_dashboard.revision_lines WHERE document_id=$1 AND translation_id=$2 ORDER BY position", [document,id])).rows;
    return {...detail,revision,saved};
  }
  async reviewProgress(): Promise<ReviewProgress> {
    return one<ReviewProgress>(this.db, `SELECT s.review_enabled,s.review_publication_enabled,s.review_daily_micros::text,s.review_monthly_micros::text,s.review_max_daily,
      b.review_daily::text,b.review_monthly::text,w.last_run_at::text,w.last_outcome,w.batch_state,w.provider_status,w.error_code,w.stage,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state='pending') AS pending,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state IN ('reserved','submitted')) AS processing,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state='assessed') AS assessed,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state='blocked') AS blocked,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state='kept') AS kept,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state='deferred') AS deferred,
      (SELECT count(*)::integer FROM lyra_dashboard.review_queue WHERE state='published') AS published
      FROM lyra_dashboard.settings s CROSS JOIN lyra_dashboard.budget b CROSS JOIN lyra_dashboard.review_worker w`);
  }
  async overview(): Promise<Overview> {
    const settings = await one<Settings>(
      this.db,
      "SELECT * FROM lyra_dashboard.settings",
    );
    if (!settings) throw new Error("dashboard_unavailable");
    const totals = await one<{
      today: string;
      month: string;
      estimated: string;
      reserved: string;
      attention: number;
    }>(
      this.db,
      `SELECT
      (SELECT daily::text FROM lyra_dashboard.budget) AS today,
      (SELECT monthly::text FROM lyra_dashboard.budget) AS month,
      coalesce(sum(accounted_micros) FILTER(WHERE state='settled' AND settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS estimated,
      coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown')),0)::text AS reserved,
      (SELECT count(*)::integer FROM lyra_dashboard.jobs WHERE state IN ('failed','unknown') OR (state IN ('running','queued') AND coalesce(started_at,created_at)<now()-interval '6 minutes')) AS attention
      FROM lyra_dashboard.spend`,
    );
    const counts = await one<{
      songs: number;
      translations: number;
      reports: number;
      updated: string;
    }>(
      this.db,
      `SELECT count(*)::integer AS songs,count(translation_id)::integer AS translations,
      (SELECT count(*)::integer FROM lyra_dashboard.reports WHERE status='pending') AS reports,now()::text AS updated FROM lyra_dashboard.songs`,
    );
    const recent = (
      await this.db.query<Job>(
        "SELECT * FROM lyra_dashboard.jobs ORDER BY created_at DESC,id DESC LIMIT 5",
      )
    ).rows;
    const trend = (
      await this.db.query<{
        day: string;
        accounted: string;
      }>(`SELECT to_char(d,'YYYY-MM-DD') AS day,coalesce(sum(j.accounted_micros),0)::text AS accounted
      FROM generate_series((now() AT TIME ZONE 'UTC')::date-6,(now() AT TIME ZONE 'UTC')::date,interval '1 day') d
      LEFT JOIN lyra_dashboard.spend j ON (coalesce(j.settled_at,j.created_at) AT TIME ZONE 'UTC')::date=d::date GROUP BY d ORDER BY d`)
    ).rows;
    return { ...totals, ...counts, settings, recent, trend };
  }
  async songs(q = "", page = 1): Promise<Page<Song>> {
    page = pageNumber(String(page));
    q = escaped(searchText(q));
    const values = [`%${q}%`];
    const where = "WHERE title ILIKE $1 OR artist ILIKE $1";
    const count = await one<{ n: number }>(
      this.db,
      `SELECT count(*)::integer AS n FROM lyra_dashboard.songs ${where}`,
      values,
    );
    const rows = (
      await this.db.query<Song>(
        `SELECT * FROM lyra_dashboard.songs ${where} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
        [...values, PAGE_SIZE, (page - 1) * PAGE_SIZE],
      )
    ).rows;
    return { rows, total: count.n, page };
  }
  async song(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const song = await one<Song>(
      this.db,
      "SELECT * FROM lyra_dashboard.songs WHERE id=$1",
      [id],
    );
    if (!song) return null;
    const lines = (
      await this.db.query<Line>(
        "SELECT * FROM lyra_dashboard.lines WHERE document_id=$1 ORDER BY position",
        [id],
      )
    ).rows;
    const reports = (
      await this.db.query<Report>(
        "SELECT * FROM lyra_dashboard.reports WHERE document_id=$1 ORDER BY created_at DESC LIMIT 100",
        [id],
      )
    ).rows;
    return { song, lines, reports };
  }
  async jobs(state = "", page = 1): Promise<Page<Job>> {
    page = pageNumber(String(page));
    const selected = jobStates.has(state) ? state : "";
    const where = "WHERE ($1='' OR state=$1)";
    const count = await one<{ n: number }>(
      this.db,
      `SELECT count(*)::integer AS n FROM lyra_dashboard.jobs ${where}`,
      [selected],
    );
    const rows = (
      await this.db.query<Job>(
        `SELECT * FROM lyra_dashboard.jobs ${where} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
        [selected, PAGE_SIZE, (page - 1) * PAGE_SIZE],
      )
    ).rows;
    return { rows, total: count.n, page };
  }
  async reports(status = "pending", page = 1): Promise<Page<Report>> {
    page = pageNumber(String(page));
    const selected = reportStates.has(status) ? status : "";
    const where = "WHERE ($1='' OR status=$1)";
    const count = await one<{ n: number }>(
      this.db,
      `SELECT count(*)::integer AS n FROM lyra_dashboard.reports ${where}`,
      [selected],
    );
    const rows = (
      await this.db.query<Report>(
        `SELECT * FROM lyra_dashboard.reports ${where} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
        [selected, PAGE_SIZE, (page - 1) * PAGE_SIZE],
      )
    ).rows;
    return { rows, total: count.n, page };
  }
  async report(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const report = await one<Report>(
      this.db,
      "SELECT * FROM lyra_dashboard.reports WHERE id=$1",
      [id],
    );
    if (!report) return null;
    const detail = await this.song(report.document_id);
    if (detail && report.translation_id) {
      detail.lines = (
        await this.db.query<Line>(
          "SELECT * FROM lyra_dashboard.revision_lines WHERE document_id=$1 AND translation_id=$2 ORDER BY position",
          [report.document_id, report.translation_id],
        )
      ).rows;
    }
    const review = report.translation_id ? await one<ReviewAssessment>(this.db,
      "SELECT revision_id,state,reason,decision,summary,policy_version,model,completed_at::text,comparison,comparison_summary,disposition,published_revision_id,closed_at::text FROM lyra_dashboard.review_queue WHERE revision_id=$1", [report.translation_id]) ?? null : null;
    const changes = report.translation_id ? (await this.db.query<ReviewChange>("SELECT source_id,source_text,before,after,reason FROM lyra_dashboard.review_changes WHERE revision_id=$1 ORDER BY position", [report.translation_id])).rows : [];
    return detail ? { ...detail, report, review, changes } : null;
  }
}
