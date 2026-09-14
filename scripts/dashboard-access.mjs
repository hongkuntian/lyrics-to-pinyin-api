// Provision a dedicated reader after deployment protection has been verified.
// The output is a private env file, never a credential printed to the terminal.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {migrateLibrary} from "./library-migrations.js";
const output = process.argv[2];
let client;
try {
  if (!output || !process.env.LYRA_LIBRARY_DATABASE_URL)
    throw new Error("configuration_required");
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  client = new pg.Client({
    connectionString: process.env.LYRA_LIBRARY_DATABASE_URL,
    statement_timeout: 10000,
  });
  await client.connect();
  const existing = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_reader'",
  );
  if (existing.rowCount)
    throw new Error("reader_already_exists_use_retained_credentials");
  await migrateLibrary({transaction:async fn=> {
    await client.query('BEGIN');
    try {const value=await fn(client);await client.query('COMMIT');return value;}
    catch(error) {await client.query('ROLLBACK');throw error;}
  }});
  const password = randomBytes(36).toString("base64url");
  const url = new URL(process.env.LYRA_LIBRARY_DATABASE_URL);
  url.username = "lyra_dashboard_reader";
  url.password = password;
  url.searchParams.set("sslmode", "verify-full");
  // Reserve the private output before creating the login so an existing file is never replaced.
  await writeFile(path, `LYRA_DASHBOARD_DATABASE_URL=${url.toString()}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE ROLE lyra_dashboard_reader LOGIN PASSWORD ${client.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await client.query(
      "GRANT USAGE ON SCHEMA lyra_dashboard TO lyra_dashboard_reader",
    );
    await client.query(
      "GRANT SELECT ON ALL TABLES IN SCHEMA lyra_dashboard TO lyra_dashboard_reader",
    );
    await client.query(
      "ALTER ROLE lyra_dashboard_reader SET default_transaction_read_only=on",
    );
    await client.query(
      "ALTER ROLE lyra_dashboard_reader SET statement_timeout='8s'",
    );
    await client.query(
      "ALTER ROLE lyra_dashboard_reader SET search_path=lyra_dashboard,pg_catalog",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(
    "Dashboard reader provisioned. Credentials saved to the specified private file.",
  );
} catch (error) {
  console.error(
    [
      "configuration_required",
      "reader_already_exists_use_retained_credentials",
    ].includes(error.message)
      ? error.message
      : "dashboard_provision_failed",
  );
  process.exitCode = 1;
} finally {
  await client?.end();
}
