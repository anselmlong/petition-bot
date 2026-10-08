// Applies schema.sql (idempotent). Usage: npm run db:migrate
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

const sql = neon(process.env.DATABASE_URL!);
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const statements = schema
  .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  .split(";").map((s) => s.trim()).filter(Boolean);
for (const stmt of statements) await sql.query(stmt);
console.log(`Applied ${statements.length} statements.`);
