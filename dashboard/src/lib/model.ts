export type Settings = {
  enabled: boolean;
  daily_micros: string;
  monthly_micros: string;
  user_daily: number;
  user_monthly: number;
};
export type Song = {
  id: string;
  title: string;
  artist: string;
  language: string;
  line_count: number;
  source_hash: string;
  selection_revision: string;
  created_at: string;
  translation_id: string | null;
  recipe: string | null;
  translated_at: string | null;
};
export type Job = {
  id: string;
  document_id: string;
  title: string;
  artist: string;
  target: string;
  recipe: string;
  state: string;
  stalled: boolean;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  reserved_micros: string;
  accounted_micros: string;
  cost_kind: "reserved" | "estimated";
};
export type Report = {
  id: string;
  document_id: string;
  translation_id: string | null;
  source_id: string;
  title: string;
  artist: string;
  category: string;
  detail: string;
  status: string;
  created_at: string;
};
export type Line = {
  document_id: string;
  position: number;
  source_id: string;
  lyric_text: string;
  source_text: string;
  pronunciation: string;
  translation: string | null;
  translation_id: string | null;
};
export type Page<T> = { rows: T[]; total: number; page: number };
export type Overview = {
  settings: Settings;
  today: string;
  month: string;
  estimated: string;
  reserved: string;
  songs: number;
  translations: number;
  attention: number;
  reports: number;
  recent: Job[];
  trend: { day: string; accounted: string }[];
  updated: string;
};
export const PAGE_SIZE = 20;
export function pageNumber(value?: string) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 10000) : 1;
}
export function searchText(value?: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}
export function money(value: string | bigint, places = 4) {
  const micros = BigInt(value);
  const sign = micros < 0n ? "-" : "";
  const amount = micros < 0n ? -micros : micros;
  const decimals = (amount % 1000000n)
    .toString()
    .padStart(6, "0")
    .slice(0, places);
  return `${sign}$${amount / 1000000n}${places ? "." + decimals : ""}`;
}
export function remaining(limit: string, used: string) {
  const n = BigInt(limit) - BigInt(used);
  return (n > 0n ? n : 0n).toString();
}
export function percent(used: string, limit: string) {
  return BigInt(limit) > 0n
    ? Math.min(100, Number((BigInt(used) * 10000n) / BigInt(limit)) / 100)
    : 0;
}
export function stamp(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "—";
}
export function seconds(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  return `${Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000).toFixed(1)}s`;
}
export type ReviewProgress = {
  review_enabled: boolean; review_daily_micros: string; review_monthly_micros: string; review_max_daily: number;
  review_daily: string; review_monthly: string;
  pending: number; processing: number; assessed: number; blocked: number;
  last_run_at: string | null; last_outcome: string | null;
  batch_state: string | null; provider_status: string | null; error_code: string | null;
};
export type ReviewAssessment = {
  revision_id: string; state: string; reason: string | null; decision: string | null; summary: string | null;
  policy_version: string | null; model: string | null; completed_at: string | null;
};
