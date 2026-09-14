import "server-only";
import { connection } from "next/server";
import pg from "pg";
import { DashboardQueries } from "./queries";
import type { Database } from "./queries";
import { fixtures } from "./fixtures";
import { dataMode } from "./config";

let pool: pg.Pool | undefined;
export async function read<T>(
  fn: (queries: DashboardQueries) => Promise<T>,
): Promise<T> {
  await connection();
  const mode = dataMode(process.env);
  if (mode === "error") throw new Error("dashboard_unavailable");
  if (mode !== "production")
    return fn(fixtures(mode === "empty") as unknown as DashboardQueries);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.LYRA_DASHBOARD_DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 8000,
      allowExitOnIdle: true,
    });
    pool.on("error", quietPoolError);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query("SELECT current_user AS role");
    if (rows[0]?.role !== "lyra_dashboard_reader")
      throw new Error("dashboard_role_required");
    const queries = new DashboardQueries({
      query: async (text, values) => {
        const result = await client.query(text, values);
        return { rows: JSON.parse(JSON.stringify(result.rows)) };
      },
    } as Database);
    const result = await fn(queries);
    await client.query("COMMIT");
    return result;
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("dashboard_unavailable");
  } finally {
    client.release();
  }
}
function quietPoolError() {
  /* Query failures surface as a generic page error; never log connection details. */
}
export function isFixture() {
  return process.env.VERCEL_ENV !== "production";
}
