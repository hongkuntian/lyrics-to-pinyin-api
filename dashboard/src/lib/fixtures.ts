import { PAGE_SIZE, pageNumber, searchText } from "./model";
import type { Song, Job, Report, Line, Overview, ReviewProgress, ReviewAssessment, ReviewChange, Revision, AlertSummary } from "./model";
import type {FixtureControls} from "./fixture-controls";
const now = "2026-09-14T12:00:00.000Z";
export const fixtureSongs: Song[] = Array.from({ length: 24 }, (_, i) => ({
  id: (i + 1).toString(16).padStart(64, "0"),
  title:
    i === 0 ? "夜航练习" : `Practice song ${String(i + 1).padStart(2, "0")}`,
  artist: "Lyra test ensemble",
  language: "zh",
  line_count: 4,
  source_hash: "f".repeat(64),
  selection_revision: "synthetic-fixture-1",
  created_at: now,
  translation_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  recipe: "fixture-song-context",
  translated_at: now,
}));
export const fixtureJobs: Job[] = fixtureSongs.slice(0, 6).map((s, i) => ({
  id: s.translation_id!,
  document_id: s.id,
  title: s.title,
  artist: s.artist,
  target: "en",
  recipe: s.recipe!,
  state: ["ready", "unknown", "failed", "queued", "running", "ready"][i],
  stalled: [3, 4].includes(i),
  error_code:
    i === 1 ? "provider_unavailable" : i === 2 ? "invalid_translation" : null,
  created_at: "2026-09-14T11:30:00.000Z",
  started_at: i === 3 ? null : "2026-09-14T11:30:01.000Z",
  finished_at: [0, 2, 5].includes(i) ? "2026-09-14T11:30:25.000Z" : null,
  reserved_micros: "30000",
  accounted_micros: [0, 2, 5].includes(i) ? "3200" : "30000",
  cost_kind: [0, 2, 5].includes(i) ? "estimated" : "reserved",
}));
export const fixtureReports: Report[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    document_id: fixtureSongs[0].id,
    translation_id: fixtureSongs[0].translation_id,
    source_id: "L0003",
    title: fixtureSongs[0].title,
    artist: fixtureSongs[0].artist,
    category: "translation",
    detail:
      "Fixture report: consider the repeated line in the context of the whole verse. <script>window.injected=true</script>",
    status: "pending",
    created_at: now,
  },
];
export function fixtureLines(id: string): Line[] {
  return [
    "把微光装进口袋",
    "让晚风陪我回家",
    "把微光装进口袋",
    "明天再慢慢出发",
  ].map((text, i) => ({
    document_id: id,
    position: i + 1,
    source_id: `L000${i + 1}`,
    lyric_text: text,
    source_text: text,
    pronunciation: [
      "bǎ wēi guāng zhuāng jìn kǒu dài",
      "ràng wǎn fēng péi wǒ huí jiā",
      "bǎ wēi guāng zhuāng jìn kǒu dài",
      "míng tiān zài màn màn chū fā",
    ][i],
    translation: [
      "Tuck a little light into my pocket.",
      "Let the evening breeze walk me home.",
      "Tuck a little light into my pocket.",
      "Tomorrow, we can set out slowly.",
    ][i],
    translation_id:
      fixtureSongs.find((s) => s.id === id)?.translation_id ?? null,
  }));
}
const paginate = <T>(rows: T[], page = 1) => ({
  rows: rows.slice(
    (pageNumber(String(page)) - 1) * PAGE_SIZE,
    pageNumber(String(page)) * PAGE_SIZE,
  ),
  total: rows.length,
  page: pageNumber(String(page)),
});
export function fixtures(empty = false, state?:FixtureControls) {
  const songs = empty ? [] : fixtureSongs,
    jobs = empty ? [] : fixtureJobs,
    reports = empty ? [] : fixtureReports;
  return {
    async alerts():Promise<AlertSummary> {return {
      active:empty?[]:[{code:"billing_uncertain"},{code:"generation_stalled"}],
      history:empty?[]:[{id:"fixture-incident",code:"billing_uncertain",first_seen_at:now,last_seen_at:now,resolved_at:null,email_state:"accepted",attempted_at:now}],
      monitor:{initialized_at:now,last_checked_at:empty?null:now,email_configured:!empty,daily_attempts:empty?0:1,monthly_attempts:empty?0:1,last_email_state:empty?null:"accepted"},
    };},
    async controlActions() {return state?.actions ?? [];},
    async revisions(document:string):Promise<Revision[]> {
      const song = songs.find(s=>s.id === document);
      if(!song) return [];
      const common = {document_id:document,source_hash:song.source_hash,recipe:song.recipe!,actor:"fixture-worker",reason:"Preserve the recurring image.",created_at:now,restored_from:null};
      const result:Revision[] = [{...common,id:song.translation_id!,sequence:"2",base_revision_id:null,origin:"correction",current:!(state?.head && document === songs[0]?.id)}];
      if(document === songs[0]?.id) {
        result.push({...common,id:"20000000-0000-4000-8000-000000000001",sequence:"1",base_revision_id:null,origin:"initial",reason:"Initial saved translation.",current:false});
        if(state?.head) result.unshift({...common,id:state.head,sequence:"3",base_revision_id:song.translation_id,origin:"rollback",reason:"Owner restored the saved version.",restored_from:result[1].id,current:true});
      }
      return result;
    },
    async revision(document:string,id:string) {
      const revision = (await this.revisions(document)).find(r=>r.id === id), detail = await this.song(document);
      if(!revision || !detail) return null;
      const saved = fixtureLines(document).map(line=>({...line,translation_id:id,
        translation: (revision.sequence === "1" || revision.origin === "rollback") && line.source_id === "L0001" ? "Put a faint light in my pocket." : line.translation}));
      return {...detail,revision,saved};
    },
    async reviewProgress(): Promise<ReviewProgress> {
      return {review_enabled:state?.reviews ?? true,review_publication_enabled:state?.publication ?? true,review_daily_micros:"250000",review_monthly_micros:"1000000",review_max_daily:5,
        review_daily:empty?"0":"22331",review_monthly:empty?"0":"22331",pending:0,processing:0,assessed:0,blocked:0,kept:0,deferred:0,published:empty?0:1,stage:"verification",
        last_run_at:empty?null:now,last_outcome:empty?null:"assessed",batch_state:empty?null:"completed",provider_status:empty?null:"completed",error_code:null};
    },
    async overview(): Promise<Overview> {
      return {
        settings: {
          enabled: state?.paid_work ?? true,
          control_version:state?.version ?? "1",
          daily_micros: "1000000",
          monthly_micros: "5000000",
          user_daily: 10,
          user_monthly: 50,
        },
        today: empty ? "0" : "99600",
        month: empty ? "0" : "99600",
        estimated: empty ? "0" : "9600",
        reserved: empty ? "0" : "90000",
        songs: songs.length,
        translations: songs.length,
        attention: empty ? 0 : 4,
        reports: reports.length,
        recent: jobs.slice(0, 5),
        trend: Array.from({ length: 7 }, (_, i) => ({
          day: `2026-09-${String(i + 8).padStart(2, "0")}`,
          accounted: !empty && i === 6 ? "99600" : "0",
        })),
        updated: now,
      };
    },
    async songs(q = "", page = 1) {
      q = searchText(q).toLowerCase();
      return paginate(
        songs.filter((s) =>
          (s.title + " " + s.artist).toLowerCase().includes(q),
        ),
        page,
      );
    },
    async song(id: string) {
      const song = songs.find((s) => s.id === id);
      const restored = id === songs[0]?.id && state?.head;
      return song
        ? {
            song:{...song,translation_id:restored || song.translation_id},
            lines: fixtureLines(id).map(line=>({...line,translation_id:restored || line.translation_id,
              translation:restored && line.source_id === "L0001" ? "Put a faint light in my pocket." : line.translation})),
            reports: reports.filter((r) => r.document_id === id),
          }
        : null;
    },
    async jobs(state = "", page = 1) {
      return paginate(
        jobs.filter((j) => !state || j.state === state),
        page,
      );
    },
    async reports(status = "pending", page = 1) {
      return paginate(
        reports.filter((r) => !status || r.status === status),
        page,
      );
    },
    async report(id: string) {
      const report = reports.find((r) => r.id === id);
      const detail = report ? await this.song(report.document_id) : null;
      const review: ReviewAssessment | null = report ? {revision_id:report.translation_id!,state:"published",reason:"comparison_passed",
        decision:"correct",summary:"Keep the recurring image consistent. <script>window.modelInjected=true</script>",
        policy_version:"song-review-assessment-1",model:"gpt-5.6-luna",completed_at:now,comparison:"correction_preferred",comparison_summary:"The source supports the exact replacement. <script>window.comparisonInjected=true</script>",disposition:"published",published_revision_id:"20000000-0000-4000-8000-000000000001",closed_at:now} : null;
      const changes: ReviewChange[] = report ? [{source_id:"L0003",source_text:"把微光装进口袋",before:"Put the brilliant sun in my pocket.",after:"Tuck a little light into my pocket.",reason:"The source describes a faint light."}] : [];
      return report && detail ? { ...detail, report, review, changes } : null;
    },
  };
}
