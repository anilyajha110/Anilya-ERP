import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

interface Migration {
  id: string; // e.g. "0001_schema_migrations_bootstrap"
  upPath: string;
  downPath: string;
}

function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const byId = new Map<string, Partial<Migration>>();
  for (const f of files) {
    const isDown = f.endsWith(".down.sql");
    const id = f.replace(/\.(up|down)\.sql$/, "");
    const entry = byId.get(id) ?? { id };
    if (isDown) entry.downPath = join(MIGRATIONS_DIR, f);
    else entry.upPath = join(MIGRATIONS_DIR, f);
    byId.set(id, entry);
  }
  const migrations = [...byId.values()].sort((a, b) => (a.id! < b.id! ? -1 : 1));
  for (const m of migrations) {
    if (!m.upPath) throw new Error(`Migration ${m.id} is missing its .up.sql file`);
    if (!m.downPath) throw new Error(`Migration ${m.id} is missing its .down.sql file — every migration must be reversible`);
  }
  return migrations as Migration[];
}

async function ensureMigrationsTable(client: import("pg").PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function up() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    const migrations = loadMigrations();
    let appliedCount = 0;

    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      const sql = readFileSync(m.upPath, "utf8");
      console.log(`Applying ${m.id} ...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        appliedCount++;
        console.log(`  OK`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED — rolled back. ${(err as Error).message}`);
        throw err;
      }
    }
    console.log(appliedCount === 0 ? "Already up to date. No migrations applied." : `Applied ${appliedCount} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function down() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1");
    if (rows.length === 0) {
      console.log("No migrations to roll back.");
      return;
    }
    const lastId = rows[0]!.id;
    const migrations = loadMigrations();
    const m = migrations.find((mm) => mm.id === lastId);
    if (!m) throw new Error(`Cannot find migration file for applied migration ${lastId} — do not edit history`);

    const sql = readFileSync(m.downPath, "utf8");
    console.log(`Rolling back ${m.id} ...`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE id = $1", [m.id]);
      await client.query("COMMIT");
      console.log("  OK");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`  FAILED — rolled back. ${(err as Error).message}`);
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

const direction = process.argv[2];
if (direction === "up") await up();
else if (direction === "down") await down();
else {
  console.error("Usage: tsx src/migrate.ts <up|down>");
  process.exit(1);
}
