import "server-only";
import pg from "pg";
import type { OwnerInput } from "./control-input";
let pool: pg.Pool | undefined;
export async function operate(subject: string, input: OwnerInput) {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.LYRA_DASHBOARD_OPERATOR_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      statement_timeout: 8000,
      allowExitOnIdle: true,
    });
    pool.on("error", () => {});
  }
  const db = await pool.connect();
  try {
    const identity = await db.query("SELECT current_user AS role");
    if (identity.rows[0]?.role !== "lyra_dashboard_operator")
      throw new Error("owner_required");
    if (input.kind === "control") {
      await db.query(
        "SELECT lyra_dashboard_control.set_control($1,$2,$3,$4,$5)",
        [subject, input.requestID, input.version, input.control, input.enabled],
      );
    } else {
      await db.query(
        "SELECT lyra_dashboard_control.rollback_translation($1,$2,$3,$4,$5,$6,$7)",
        [
          subject,
          input.requestID,
          input.document,
          input.source,
          input.expected,
          input.restore,
          input.reason,
        ],
      );
    }
  } finally {
    db.release();
  }
}
