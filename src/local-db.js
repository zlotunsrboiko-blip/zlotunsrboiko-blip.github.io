// Development adapter. The production Worker uses Cloudflare D1.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
export function localDB(filename=':memory:'){
  const db=new DatabaseSync(filename);
  db.exec(fs.readFileSync(new URL('../migrations/0001_inventory.sql',import.meta.url),'utf8'));
  function prepare(sql){
    let args=[];const statement={bind(...values){args=values;return statement;},
      async first(){return db.prepare(sql).get(...args)||null;},
      async all(){return {results:db.prepare(sql).all(...args)};},
      async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};return statement;
  }
  return {prepare,async batch(statements){db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}},close(){db.close();}};
}
