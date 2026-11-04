import type { Page } from '@taskweave/contracts';
import { badRequest } from '../errors.ts';

interface Cursor { v: 1; filter: string; createdAt: string; id: string }
export function paginate<T extends { id: string; createdAt: string }>(rows: T[], limit: number, cursor: string | null, filter: string): Page<T> {
  let after: Cursor | undefined;
  if (cursor !== null) {
    if (cursor.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) badRequest('分页游标无效');
    try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { badRequest('分页游标无效'); }
    if (!after || after.v !== 1 || after.filter !== filter || typeof after.createdAt !== 'string' || !Number.isFinite(Date.parse(after.createdAt)) || typeof after.id !== 'string' || !/^(tw|wf)_[a-f0-9]{24}$/.test(after.id)) badRequest('分页游标与本次查询不匹配');
  }
  const ordered = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const remaining = after ? ordered.filter(row => row.createdAt < after!.createdAt || (row.createdAt === after!.createdAt && row.id > after!.id)) : ordered;
  const items = remaining.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: last && remaining.length > limit ? Buffer.from(JSON.stringify({ v: 1, filter, createdAt: last.createdAt, id: last.id })).toString('base64url') : null };
}
