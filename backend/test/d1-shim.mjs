// Minimal Cloudflare D1 lookalike over Node's built-in SQLite, for running the Worker in tests.
import { DatabaseSync } from "node:sqlite";

export function makeD1(){
  const db = new DatabaseSync(":memory:");
  const prepare = sql => {
    let args = [];
    const stmt = {
      bind(...a){ args = a.map(v => v === undefined ? null : v); return stmt; },
      async first(col){
        const row = db.prepare(sql).get(...args) ?? null;
        return col ? (row ? row[col] : null) : row;
      },
      async all(){
        const results = db.prepare(sql).all(...args);
        return { success: true, results, meta: {} };
      },
      async run(){
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      }
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts){
      const out = [];
      db.exec("BEGIN");
      try { for (const s of stmts) out.push(await s.all()); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      return out;
    },
    async exec(sql){ db.exec(sql); },
    _raw: db
  };
}
