export const tabs = ['result', 'artifacts', 'validation', 'context', 'skills', 'events'] as const;
export type Tab = (typeof tabs)[number];
export type Route = {
  collection: 'workflows' | 'tasks';
  id?: string;
  node?: string;
  attempt?: string;
  tab: Tab;
};
export function parseRoute(hash: string): Route | null {
  const [pathname, query] = hash.replace(/^#/, '').split('?');
  const match = /^(?:\/)?(workflows|tasks)(?:\/(wf_[a-f0-9]{24}|tw_[a-f0-9]{24}))?$/.exec(
    pathname || '/workflows',
  );
  if (!match) return null;
  const collection = match[1] as Route['collection'];
  const id = match[2];
  if (id && !id.startsWith(collection === 'workflows' ? 'wf_' : 'tw_')) return null;
  const params = new URLSearchParams(query);
  const tab = params.get('tab') ?? 'result';
  if (!tabs.includes(tab as Tab)) return null;
  return {
    collection,
    id,
    node: params.get('node') ?? undefined,
    attempt: params.get('attempt') ?? undefined,
    tab: tab as Tab,
  };
}
export function href(route: Route): string {
  const params = new URLSearchParams();
  if (route.node) params.set('node', route.node);
  if (route.attempt) params.set('attempt', route.attempt);
  if (route.tab !== 'result') params.set('tab', route.tab);
  return `#/${route.collection}${route.id ? '/' + route.id : ''}${params.size ? '?' + params : ''}`;
}
