import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../src/db/migrate.js';
import { salarySourceToken } from '../src/services/financial-planning-types.js';
import { backfillFourPurposeFunds } from '../src/db/migrations/021-four-purpose-funds.js';
import { fundGrantNeedsReview } from '../src/services/financial-fund-store.js';
import type { Db } from '../src/db/index.js';

const ratios = { growth: 2500, reserve: 1500, essentials: 5000, joy: 1000 };
const targets = { growth: 1, reserve: 0, essentials: 1, joy: 0 };
let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, null, MIGRATIONS.filter((m) => m.version <= 20));
});
afterEach(() => db.close());

function salary(id: string, amountCents = 1) {
  db.prepare(`INSERT INTO salary_records (id,amount_cents,date,note,deleted,updated_at,account_id)
    VALUES (?,?,946684800100,'salary note',0,1,'a')`).run(id, amountCents);
  const row = { id, amount_cents: amountCents, date: 946684800100, account_id: 'a' };
  return { salaryId: id, amountCents, date: 946684800100, accountId: 'a', sourceToken: salarySourceToken(row), confirmedAt: 200 };
}
function group(amounts: [number, number] = [1, 1], frozenTargets = targets) {
  const sources = [salary('s1', amounts[0]), salary('s2', amounts[1])];
  db.prepare(`INSERT INTO financial_periods VALUES ('p','2000-01','cycle',1,200,200)`).run();
  const incomeCents = amounts[0] + amounts[1];
  const decision = { incomeCents, ratiosBps: ratios, targets: frozenTargets, configRevision: 0, mappingRevision: 0 };
  db.prepare(`INSERT INTO financial_period_revisions
    (id,period_id,revision,group_month,cycle_key,window_json,decision_json,sources_json,warnings_json,reason,config_revision,mapping_revision,confirmed_income_cents,created_at)
    VALUES ('r','p',1,'2000-01','cycle',?,?,?,'[]','salary-confirmation',0,0,?,200)`)
    .run(JSON.stringify({start: 946684800000, end: 946684801000, cycleKey: 'cycle', groupMonth: '2000-01', timeZone: 'UTC', cycle: {kind:'natural-month'}, anchorSalaryId:'s1', groupingRule:'financial-cycle-frozen-month-v1', legacyWindow:null, warnings:[]}), JSON.stringify(decision), JSON.stringify(sources), incomeCents);
  const insert = db.prepare(`INSERT INTO financial_period_sources VALUES ('p',?,1,1,?,200,200)`);
  for (const source of sources) insert.run(source.salaryId, JSON.stringify(source));
}
function mapping(revision: number, purpose: 'joy' | 'essentials') {
  db.prepare(`INSERT INTO financial_mapping_revisions (id,revision,rules_json,topology_json,topology_token,created_at)
    VALUES (?,?,?,?,?,1)`).run(`m${revision}`, revision, JSON.stringify([{categoryId:'c',purpose}]),
      JSON.stringify([{id:'c',parentId:null,deleted:false}]), 'x');
}
function transaction(id = 't', deleted = 0) {
  db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
    VALUES (?,0,42,'c','a',946684800100,'','[]',0,?,1)`).run(id, deleted);
}
function activeMapping(revision: number) {
  db.prepare(`UPDATE financial_period_revisions SET mapping_revision=?, decision_json=json_set(decision_json,'$.mappingRevision',?) WHERE id='r'`).run(revision, revision);
}
function savedConfig(revision: number, ratiosJson: string, zone = 'Asia/Shanghai') {
  db.prepare(`INSERT INTO financial_config_revisions (id,revision,enabled,ratios_json,essential_monthly_cents,target_months,cycle_json,time_zone,created_at)
    VALUES (?,?,1,?,NULL,5,?, ?,1)`).run(`config${revision}`, revision, ratiosJson, JSON.stringify({kind:'natural-month'}), zone);
}
function migrate() { return runMigrations(db, null); }
function rows(table: string) { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }

describe('four-purpose historical migration', () => {
  it('verifiedLegacyGroupKeepsAggregateTargets and reruns hook twice without duplicates', () => {
    group();
    // Derived from MIGRATIONS: the property is "everything above schema 20 runs", so
    // a later migration must not force an edit here.
    expect(migrate().applied).toEqual(
      MIGRATIONS.filter((m) => m.version > 20).map((m) => m.version),
    );
    expect(migrate().applied).toEqual([]);
    db.transaction(() => backfillFourPurposeFunds(db))();
    db.transaction(() => backfillFourPurposeFunds(db))();
    expect(rows('financial_fund_grants')).toHaveLength(1);
    expect(rows('financial_fund_grant_sources')).toHaveLength(2);
    const revisions = rows('financial_fund_grant_revisions') as { targets_json: string }[];
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0]!.targets_json)).toEqual(targets);
  });
  it('rejects matching forged snapshots whose salary token does not match live facts', () => {
    group();
    db.exec(`UPDATE financial_period_revisions SET sources_json=json_set(sources_json,'$[0].sourceToken','forged');
      UPDATE financial_period_sources SET snapshot_json=json_set(snapshot_json,'$.sourceToken','forged') WHERE salary_id='s1'`);
    migrate();
    expect(rows('financial_fund_grants')).toHaveLength(0);
  });
  it('enforces unique origin and salary claims at the database boundary', () => {
    group(); migrate();
    expect(() => db.prepare("INSERT INTO financial_fund_grants VALUES ('other','legacy-group','p',1,'active')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO financial_fund_grant_sources VALUES ('s1','other','token',1,100,'a','active')").run()).toThrow();
  });
  it('legacyGrantSourceEditRequiresReview without rewriting the frozen targets', () => {
    group(); migrate();
    expect(fundGrantNeedsReview(db, 'legacy-group:p')).toBe(false);
    const before = rows('financial_fund_grant_revisions');
    db.prepare("UPDATE salary_records SET amount_cents=3 WHERE id='s1'").run();
    expect(fundGrantNeedsReview(db, 'legacy-group:p')).toBe(true);
    expect(rows('financial_fund_grant_revisions')).toEqual(before);
  });
  it('stale or inconsistent membership and unconfirmed salary stay unallocated', () => {
    group(); salary('unconfirmed');
    db.prepare("UPDATE financial_period_sources SET revision=2 WHERE salary_id='s1'").run();
    migrate();
    expect(rows('financial_fund_grants')).toHaveLength(0);
    expect(rows('financial_fund_grant_sources')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues').length).toBeGreaterThanOrEqual(2);
  });
  it.each([
    ['missing membership', "DELETE FROM financial_period_sources WHERE salary_id='s1'"],
    ['extra membership', "INSERT INTO financial_period_sources VALUES ('p','extra',1,1,'{}',200,200)"],
    ['mismatched snapshot', "UPDATE financial_period_sources SET snapshot_json='{}' WHERE salary_id='s1'"],
    ['changed salary fact', "UPDATE salary_records SET amount_cents=2 WHERE id='s1'"],
    ['deleted salary', "UPDATE salary_records SET deleted=1 WHERE id='s1'"],
    ['wrong total', "UPDATE financial_period_revisions SET confirmed_income_cents=3"],
    ['wrong targets', `UPDATE financial_period_revisions SET decision_json=json_set(decision_json,'$.targets.growth',0)`],
    ['wrong ratios', `UPDATE financial_period_revisions SET decision_json=json_set(decision_json,'$.ratiosBps.growth',2)`],
    ['wrong source token', `UPDATE financial_period_revisions SET sources_json=json_set(sources_json,'$[0].sourceToken','fake')`],
  ])('refuses %s rather than inventing funding', (_name, mutation) => {
    group(); db.exec(mutation); migrate();
    expect(rows('financial_fund_grants')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'period', source_id:'p'}));
  });
  it('inactiveRevisionNeverAddsFunding', () => {
    group();
    db.prepare(`INSERT INTO financial_period_revisions
      SELECT 'older',period_id,2,group_month,cycle_key,window_json,decision_json,sources_json,warnings_json,reason,config_revision,mapping_revision,confirmed_income_cents,actor_id,operation_id,created_at
      FROM financial_period_revisions WHERE id='r'`).run();
    migrate();
    expect(rows('financial_fund_grant_revisions')).toHaveLength(1);
    expect(rows('financial_fund_grant_sources')).toHaveLength(2);
  });
  it('overlapping conflicting frozen mappings remain unassigned; revision zero is not evidence', () => {
    group();
    db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
      VALUES ('t',0,42,'c','a',946684800100,'note','[]',0,0,1)`).run();
    const addMapping = db.prepare(`INSERT INTO financial_mapping_revisions
      (id,revision,rules_json,topology_json,topology_token,created_at) VALUES (?,?,?,?,?,1)`);
    const topology = JSON.stringify([{id:'c',parentId:null,deleted:false}]);
    addMapping.run('m1',1,JSON.stringify([{categoryId:'c',purpose:'joy'}]),topology,'x');
    addMapping.run('m2',2,JSON.stringify([{categoryId:'c',purpose:'essentials'}]),topology,'x');
    db.prepare("UPDATE financial_period_revisions SET mapping_revision=1 WHERE id='r'").run();
    db.prepare("UPDATE financial_period_revisions SET decision_json=json_set(decision_json,'$.mappingRevision',1) WHERE id='r'").run();
    db.prepare("INSERT INTO financial_periods VALUES ('p2','2000-01','cycle2',1,200,200)").run();
    db.prepare(`INSERT INTO financial_period_revisions
      SELECT 'r2','p2',1,group_month,'cycle2',json_set(window_json,'$.cycleKey','cycle2'),json_set(decision_json,'$.mappingRevision',2),sources_json,warnings_json,reason,config_revision,2,confirmed_income_cents,actor_id,operation_id,created_at
      FROM financial_period_revisions WHERE id='r'`).run();
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t',purpose:null,source:'unresolved'}));
  });
  it('uses unique frozen mapping but not revision zero', () => {
    group();
    db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
      VALUES ('t',0,42,'c','a',946684800100,'','[]',0,0,1)`).run();
    db.prepare(`INSERT INTO financial_mapping_revisions (id,revision,rules_json,topology_json,topology_token,created_at)
      VALUES ('m',1,?,?, 'x',1)`).run(JSON.stringify([{categoryId:'c',purpose:'joy'}]), JSON.stringify([{id:'c',parentId:null,deleted:false}]));
    activeMapping(1);
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t', purpose:'joy', source:'legacy-mapping'}));
  });
  it('revision zero is never frozen mapping evidence', () => {
    group();
    db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
      VALUES ('t',0,42,'c','a',946684800100,'','[]',0,0,1)`).run();
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t', purpose:null}));
  });
  it('ignores conflicting or malformed inactive revisions', () => {
    group(); transaction(); mapping(1, 'joy'); mapping(2, 'essentials'); activeMapping(1);
    db.prepare(`INSERT INTO financial_period_revisions
      SELECT 'inactive',period_id,2,group_month,cycle_key,window_json,decision_json,sources_json,warnings_json,reason,config_revision,2,confirmed_income_cents,actor_id,operation_id,created_at
      FROM financial_period_revisions WHERE id='r'`).run();
    db.prepare(`INSERT INTO financial_period_revisions
      SELECT 'malformed',period_id,3,group_month,cycle_key,'{',decision_json,sources_json,warnings_json,reason,config_revision,2,confirmed_income_cents,actor_id,operation_id,created_at
      FROM financial_period_revisions WHERE id='r'`).run();
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t',purpose:'joy'}));
  });
  it('uses active evidence despite a conflicting inactive revision', () => {
    group(); transaction(); mapping(1, 'joy'); mapping(2, 'essentials'); activeMapping(1);
    db.prepare(`INSERT INTO financial_period_revisions
      SELECT 'inactive',period_id,2,group_month,cycle_key,window_json,json_set(decision_json,'$.mappingRevision',2),sources_json,warnings_json,reason,config_revision,2,confirmed_income_cents,actor_id,operation_id,created_at
      FROM financial_period_revisions WHERE id='r'`).run();
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t',purpose:'joy'}));
  });
  it('does not infer from an orphan revision', () => {
    group(); transaction(); mapping(1, 'joy'); activeMapping(1);
    db.prepare("DELETE FROM financial_periods WHERE id='p'").run();
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t',purpose:null}));
  });
  it.each([
    ['invalid JSON', "window_json='{'"],
    ['foreign cycle', "window_json=json_set(window_json,'$.cycleKey','foreign')"],
    ['foreign group', "window_json=json_set(window_json,'$.groupMonth','1999-01')"],
    ['foreign revision identity', "cycle_key='foreign'"],
    ['invalid timezone', "window_json=json_set(window_json,'$.timeZone','not/a-zone')"],
    ['invalid grouping rule', "window_json=json_set(window_json,'$.groupingRule','foreign')"],
    ['missing grouping rule', "window_json=json_remove(window_json,'$.groupingRule')"],
    ['invalid anchor', "window_json=json_set(window_json,'$.anchorSalaryId','')"],
    ['missing anchor', "window_json=json_remove(window_json,'$.anchorSalaryId')"],
    ['invalid cycle metadata', "window_json=json_set(window_json,'$.cycle.kind','foreign')"],
    ['missing cycle', "window_json=json_remove(window_json,'$.cycle')"],
    ['invalid warnings', "window_json=json_set(window_json,'$.warnings',42)"],
    ['missing warnings', "window_json=json_remove(window_json,'$.warnings')"],
    ['decision mapping mismatch', "decision_json=json_set(decision_json,'$.mappingRevision',2)"],
  ])('does not infer from malformed active window: %s', (_name, update) => {
    group(); transaction(); mapping(1, 'joy'); activeMapping(1);
    db.exec(`UPDATE financial_period_revisions SET ${update} WHERE id='r'`);
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t',purpose:null,source:'unresolved'}));
    expect(rows('financial_fund_grants')).toHaveLength(0);
    expect(rows('financial_fund_grant_sources')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'period',source_id:'p',reason:'unverified-group',status:'open'}));
  });
  it.each([
    ['one zero salary in a positive group', [0, 1] as [number, number], {growth:0,reserve:0,essentials:1,joy:0}],
    ['all salaries and group income zero', [0, 0] as [number, number], {growth:0,reserve:0,essentials:0,joy:0}],
  ])('does not fund %s despite matching snapshots and targets', (_name, amounts, frozenTargets) => {
    group(amounts, frozenTargets); migrate();
    expect(rows('financial_fund_grants')).toHaveLength(0);
    expect(rows('financial_fund_grant_sources')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'period',source_id:'p',reason:'unverified-group',status:'open'}));
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'salary',source_id:'s1',reason:'unallocated',status:'open'}));
  });
  it('unknown malformed active window prevents guessing from another active window', () => {
    group(); transaction(); mapping(1, 'joy'); activeMapping(1);
    db.exec(`INSERT INTO financial_periods VALUES ('p2','2000-01','cycle2',1,200,200);
      INSERT INTO financial_period_revisions SELECT 'r2','p2',1,group_month,'cycle2','{',decision_json,sources_json,warnings_json,reason,config_revision,mapping_revision,confirmed_income_cents,actor_id,operation_id,created_at FROM financial_period_revisions WHERE id='r'`);
    migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'t',purpose:null}));
  });
  it('does not substitute an older config for corrupt latest saved config', () => {
    savedConfig(1, JSON.stringify(ratios)); savedConfig(2, '{'); migrate();
    expect(rows('financial_fund_config_revisions')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'config',reason:'invalid-current-config',status:'open'}));
  });
  it('rejects corrupt non-ratio latest config and retains the issue after correction', () => {
    savedConfig(1, JSON.stringify(ratios)); savedConfig(2, JSON.stringify(ratios));
    db.exec("UPDATE financial_config_revisions SET cycle_json='{}' WHERE revision=2"); migrate();
    const issues = rows('financial_fund_migration_issues');
    db.exec(`UPDATE financial_config_revisions SET cycle_json='{"kind":"natural-month"}' WHERE revision=2`);
    db.transaction(() => backfillFourPurposeFunds(db))();
    expect(rows('financial_fund_config_revisions')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toEqual(issues);
  });
  it('leaves absent config virtual instead of persisting UTC', () => {
    migrate();
    expect(rows('financial_fund_config_revisions')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).not.toContainEqual(expect.objectContaining({source_kind:'config'}));
  });
  it('imports a valid latest saved config unchanged', () => {
    savedConfig(1, JSON.stringify(ratios)); migrate();
    expect(rows('financial_fund_config_revisions')).toContainEqual(expect.objectContaining({time_zone:'Asia/Shanghai',ratios_json:JSON.stringify(ratios)}));
  });
  it('reports a corrupt existing fund config without silently replacing it', () => {
    migrate();
    db.prepare("INSERT INTO financial_fund_config_revisions VALUES (1,'{}','Asia/Shanghai',NULL,NULL,1)").run();
    const saved = rows('financial_fund_config_revisions');
    db.transaction(() => backfillFourPurposeFunds(db))();
    expect(rows('financial_fund_config_revisions')).toEqual(saved);
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'fund-config',reason:'invalid-current-config',status:'open'}));
  });
  it('requires review after an invalid group is corrected before rerun', () => {
    group(); db.exec("UPDATE financial_period_sources SET revision=2 WHERE salary_id='s1'"); migrate();
    const issues = rows('financial_fund_migration_issues');
    db.exec("UPDATE financial_period_sources SET revision=1 WHERE salary_id='s1'");
    db.transaction(() => backfillFourPurposeFunds(db))();
    expect(rows('financial_fund_grants')).toHaveLength(0);
    expect(rows('financial_fund_grant_sources')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toEqual(issues);
  });
  it('does not fund a previously unallocated salary when a group appears on rerun', () => {
    const sources = [salary('s1'), salary('s2')]; migrate();
    db.prepare("INSERT INTO financial_periods VALUES ('p','2000-01','cycle',1,200,200)").run();
    db.prepare(`INSERT INTO financial_period_revisions
      (id,period_id,revision,group_month,cycle_key,window_json,decision_json,sources_json,warnings_json,reason,config_revision,mapping_revision,confirmed_income_cents,created_at)
      VALUES ('r','p',1,'2000-01','cycle',?,?,?,'[]','salary-confirmation',0,0,2,200)`)
      .run(JSON.stringify({start:946684800000,end:946684801000,cycleKey:'cycle',groupMonth:'2000-01',timeZone:'UTC',cycle:{kind:'natural-month'},anchorSalaryId:'s1',groupingRule:'financial-cycle-frozen-month-v1',legacyWindow:null,warnings:[]}),
        JSON.stringify({incomeCents:2,ratiosBps:ratios,targets,configRevision:0,mappingRevision:0}), JSON.stringify(sources));
    for (const source of sources) db.prepare("INSERT INTO financial_period_sources VALUES ('p',?,1,1,?,200,200)").run(source.salaryId, JSON.stringify(source));
    db.transaction(() => backfillFourPurposeFunds(db))();
    expect(rows('financial_fund_grants')).toHaveLength(0);
    expect(rows('financial_fund_grant_sources')).toHaveLength(0);
    expect(rows('financial_fund_migration_issues')).toContainEqual(expect.objectContaining({source_kind:'salary',source_id:'s1',reason:'unallocated'}));
  });
  it('preserves deleted unresolved purpose evidence without creating a current issue', () => {
    transaction('deleted', 1); migrate();
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({transaction_id:'deleted',purpose:null}));
    expect(rows('financial_fund_purpose_events')).toContainEqual(expect.objectContaining({transaction_id:'deleted',purpose:null}));
    expect(rows('financial_fund_migration_issues')).not.toContainEqual(expect.objectContaining({source_kind:'transaction',source_id:'deleted'}));
    db.exec("UPDATE transactions SET deleted=0 WHERE id='deleted'");
    const unresolvedLive = db.prepare(`SELECT t.id FROM transactions t JOIN financial_fund_purposes p ON p.transaction_id=t.id
      WHERE t.deleted=0 AND t.is_refund=0 AND p.purpose IS NULL`).all();
    expect(unresolvedLive).toEqual([{ id: 'deleted' }]);
  });
  it('copies explicit purpose without period and preserves base facts', () => {
    db.prepare("INSERT INTO accounts VALUES ('a','account',0,77,0,0,0,1)").run();
    db.prepare("INSERT INTO manual_goal_openings VALUES ('reserve',100,10,1,NULL,NULL,1,1)").run();
    db.prepare("INSERT INTO manual_goal_entries VALUES ('g','reserve','deposit',5,100,'note',1,NULL,NULL,1,1,NULL)").run();
    db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at,financial_purpose,financial_purpose_revision)
      VALUES ('t',0,42,'c','a',100,'note','["tag"]',0,0,1,'joy',1)`).run();
    db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
      VALUES ('refund',1,10,'c','a',101,'refund','[]',1,0,1)`).run();
    db.prepare("INSERT INTO refund_links (id,refund_tx_id,original_tx_id,created_at) VALUES ('link','refund','t',1)").run();
    const tables = ['transactions','accounts','manual_goal_openings','manual_goal_entries','refund_links'];
    const before = tables.map(rows);
    migrate();
    expect(tables.map(rows)).toEqual(before);
    expect(rows('financial_fund_purposes')).toContainEqual(expect.objectContaining({ transaction_id: 't', purpose: 'joy' }));
  });
});
