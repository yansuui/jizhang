import { assistantJsonObject, type AssistantJsonObject } from './assistant-types.js';
import type { AssistantToolContext } from './assistant-tool-registry.js';
import { dayScope, workspaceError } from './assistant-workspace-store.js';

/** Authoritative full-day totals. Never sum the first query/salary page. */
export function dailyReviewFacts(c: AssistantToolContext, args: AssistantJsonObject): AssistantJsonObject {
  const scope = dayScope(args['date'], args['timeZone']);
  const day = c.services.transactions.dailySummary({ from: scope.from, to: scope.to, timeZone: scope.timeZone }).items[0];
  const salaries = c.services.salaries.listInWindow(scope.from, scope.to);
  const salaryCents = salaries.reduce((sum, value) => sum + value.amountCents, 0);
  const ordinaryIncomeCents = day?.incomeCents ?? 0;
  const expenseCents = day?.expenseCents ?? 0;
  const incomeCents = ordinaryIncomeCents + salaryCents;
  if (![salaryCents, incomeCents, incomeCents - expenseCents].every(Number.isSafeInteger)) workspaceError(400, 'LIMIT', '当日金额超出安全范围，请查看明细。');
  const categories = c.services.stats.categoryShare(scope.from, scope.to);
  const accountRows = c.services.masterData.listAccounts(true).map((account) => {
    const totals = c.services.transactions.dailySummary({ from: scope.from, to: scope.to, timeZone: scope.timeZone, accountId: account.id }).items[0];
    const salary = c.db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS total FROM salary_records WHERE deleted=0 AND account_id=? AND date>=? AND date<?').get(account.id, scope.from, scope.to) as { total: number };
    return { accountId: account.id, name: account.name, incomeCents: (totals?.incomeCents ?? 0) + salary.total, salaryCents: salary.total, expenseCents: totals?.expenseCents ?? 0, count: totals?.count ?? 0 };
  }).filter((v) => v.count || v.salaryCents);
  const possibleDuplicates = c.db.prepare(`SELECT amount_cents AS amountCents,type,account_id AS accountId,COUNT(*) AS count
    FROM transactions WHERE deleted=0 AND date>=? AND date<? GROUP BY amount_cents,type,account_id HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC,amount_cents,type,account_id LIMIT 20`).all(scope.from, scope.to) as { amountCents: number; type: number; accountId: string; count: number }[];
  const issueCount = c.db.prepare(`SELECT COUNT(*) AS total FROM (SELECT 1 FROM transactions WHERE deleted=0 AND date>=? AND date<? GROUP BY amount_cents,type,account_id HAVING COUNT(*)>1)`).get(scope.from, scope.to) as { total: number };
  const evidence = possibleDuplicates.map((group) => {
    const ids = c.db.prepare('SELECT id FROM transactions WHERE deleted=0 AND date>=? AND date<? AND amount_cents=? AND type=? AND account_id=? ORDER BY date,id LIMIT 20').all(scope.from, scope.to, group.amountCents, group.type, group.accountId) as { id: string }[];
    return { ...group, transactionIds: ids.map((v) => v.id), idCount: group.count, idsOmitted: group.count > ids.length };
  });
  return assistantJsonObject({ ...scope, calculatedAt: c.now(), totals: { incomeCents, ordinaryIncomeCents, salaryCents, salaryCount: salaries.length,
    expenseCents, refundIncomeCents: categories.refundIncomeCents, netCents: incomeCents - expenseCents, transactionCount: day?.count ?? 0 },
    categories: { items: categories.items.slice(0, 100), total: categories.items.length, hasMore: categories.items.length > 100, expenseCents: categories.expenseCents, continuation: 'stats.query(view=categories,from,to)' },
    accounts: { items: accountRows.slice(0, 100), total: accountRows.length, hasMore: accountRows.length > 100, continuation: 'transactions.daily(from,to,timeZone,accountId) 与 salaries.read 全量分页' },
    potentialIssues: { items: evidence, total: issueCount.total, hasMore: issueCount.total > evidence.length, note: '同金额、同账户等仅为核对线索，并不证明重复；可按原日期和账户查询明细核对，未修改任何账单。' },
    readOnly: true, note: '统计包含完整当日分配收入；退款计入收入，原支出保持毛额。明细超出展示上限时已明确标记。' }, '每日复盘事实');
}
