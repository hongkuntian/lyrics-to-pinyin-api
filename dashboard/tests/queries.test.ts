import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DashboardQueries, type Database } from "../src/lib/queries";
const id = "a".repeat(64),
  job = "00000000-0000-4000-8000-000000000001";
async function setup() {
  const db = new PGlite();
  await db.exec(
    await readFile(
      new URL("../../db/001-song-library.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL("../../db/002-dashboard-views.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.query("INSERT INTO library_users(id) VALUES('fixture-user')");
  await db.query(
    "UPDATE library_settings SET enabled=true,daily_micros=1000000,monthly_micros=5000000",
  );
  const response = {
    song: {
      title: { original: "100% night" },
      artist: { original: "Test ensemble" },
      language: "zh",
    },
    lines: [
      { original: "回家", romanized: "huí jiā" },
      { original: "回家", romanized: "huí jiā" },
    ],
  };
  const structure = {
    occurrences: [
      { sourceID: "L0001", lyricText: "回家", sourceText: "回家" },
      { sourceID: "L0002", lyricText: "回家", sourceText: "回家" },
    ],
  };
  await db.query("INSERT INTO lyric_documents VALUES($1,$2,$3,$4,$5,$6)", [
    id,
    "recording",
    "hash",
    "fixture",
    JSON.stringify(response),
    JSON.stringify(structure),
  ]);
  await db.query(
    "INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros,provider_response) VALUES($1,$2,'en','fixture','fixture-user','ready',30000,3200,$3)",
    [
      job,
      id,
      JSON.stringify({
        usage: { input_tokens: 8000, output_tokens: 1000 },
        secret: "must-not-leak",
      }),
    ],
  );
  await db.query(
    "INSERT INTO song_translations(id,document_id,target,recipe,content) VALUES($1,$2,'en','fixture',$3)",
    [
      job,
      id,
      JSON.stringify({
        lines: [
          { sourceID: "L0002", text: "Come back home." },
          { sourceID: "L0001", text: "Go home." },
        ],
      }),
    ],
  );
  return { db, q: new DashboardQueries(db as unknown as Database) };
}
test("views preserve repeated occurrence identity and hide provider payloads", async () => {
  const { db, q } = await setup();
  try {
    const detail = await q.song(id);
    assert.deepEqual(
      detail?.lines.map((x) => [x.source_id, x.translation]),
      [
        ["L0001", "Go home."],
        ["L0002", "Come back home."],
      ],
    );
    const jobs = await q.jobs();
    assert.equal(jobs.rows[0].cost_kind, "estimated");
    assert.ok(!JSON.stringify(jobs).includes("secret"));
    const count = await q.songs("%");
    assert.equal(count.total, 1);
    assert.equal((await q.songs("' OR 1=1 --")).total, 0);
    assert.equal(await q.song("bad"), null);
  } finally {
    await db.close();
  }
});

test("pagination is bounded and reports resolve to the original occurrence", async () => {
  const { db, q } = await setup();
  try {
    await db.query(`INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure)
    SELECT lpad(i::text,64,'0'),'r'||i,'h'||i,'fixture',jsonb_build_object('song',jsonb_build_object('title',jsonb_build_object('original','Extra song '||i),'artist',jsonb_build_object('original','Test'),'language','zh')),
    '{"occurrences":[]}'::jsonb FROM generate_series(1,24) i`);
    assert.equal((await q.songs("%")).total, 1);
    const first = await q.songs("", 1),
      second = await q.songs("", 2);
    assert.equal(first.rows.length, 20);
    assert.equal(second.rows.length, 5);
    assert.equal(first.total, 25);
    assert.equal(
      first.rows.some((a) => second.rows.some((b) => a.id === b.id)),
      false,
    );
    const reportID = "10000000-0000-4000-8000-000000000001";
    await db.query(
      `INSERT INTO correction_reports(id,user_id,document_id,translation_id,source_id,category,detail,fingerprint)
    VALUES($1,'fixture-user',$2,$3,'L0002','translation','Keep the repeated occurrence separate','unique-report')`,
      [reportID, id, job],
    );
    const detail = await q.report(reportID);
    assert.equal(detail?.report.source_id, "L0002");
    assert.equal(detail?.lines[1].translation, "Come back home.");
    assert.equal((await q.reports("pending")).total, 1);
    assert.equal((await q.reports("accepted")).total, 0);
  } finally {
    await db.close();
  }
});
test("accounted totals use UTC creation windows and retain uncertain reservations", async () => {
  const { db, q } = await setup();
  try {
    await db.query("SET TIME ZONE 'Pacific/Honolulu'");
    await db.query(
      "UPDATE translation_jobs SET created_at=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 microsecond'",
    );
    assert.equal((await q.overview()).month, "0");
    await db.query(
      "UPDATE translation_jobs SET created_at=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',state='unknown',accounted_micros=30000",
    );
    const totals = await q.overview();
    assert.equal(totals.today, "30000");
    assert.equal(totals.month, "30000");
    assert.equal(totals.reserved, "30000");
    assert.equal(totals.estimated, "0");
    assert.equal(totals.trend.at(-1)?.accounted, "30000");
    await db.query(
      "UPDATE translation_jobs SET state='ready',provider_response='{}'",
    );
    assert.equal((await q.jobs()).rows[0].cost_kind, "reserved");
  } finally {
    await db.close();
  }
});
test("reader sees views but cannot read tokens, provider payloads or alter records", async () => {
  const { db, q } = await setup();
  try {
    await db.exec(
      "CREATE ROLE dashboard_test_reader; GRANT USAGE ON SCHEMA lyra_dashboard TO dashboard_test_reader; GRANT SELECT ON ALL TABLES IN SCHEMA lyra_dashboard TO dashboard_test_reader; SET ROLE dashboard_test_reader;",
    );
    assert.equal((await q.overview()).songs, 1);
    assert.equal((await q.song(id))?.lines.length, 2);
    for (const sql of [
      "SELECT * FROM public.library_tokens",
      "SELECT provider_response FROM public.translation_jobs",
      "UPDATE lyra_dashboard.settings SET enabled=false",
      "UPDATE lyra_dashboard.jobs SET state='failed'",
      "DELETE FROM public.song_translations",
      "CREATE TABLE lyra_dashboard.unwanted(id integer)",
    ])
      await assert.rejects(db.query(sql));
    await db.exec("RESET ROLE");
    assert.equal(
      (await db.query<{ state: string }>("SELECT state FROM translation_jobs"))
        .rows[0].state,
      "ready",
    );
  } finally {
    await db.close();
  }
});
