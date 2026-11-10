import type { WorkflowView } from '@taskweave/contracts';
import { href } from '../data/routes.ts';
import type { Route } from '../data/routes.ts';
import { Badge, Empty } from './common.tsx';

/** Stable Kahn layers, independent of definition ordering; cycles stay visible. */
export function graphLayers(nodes: WorkflowView['nodes']): WorkflowView['nodes'][] {
  const pending = new Map(nodes.map((node) => [node.id, node]));
  const done = new Set<string>();
  const layers: WorkflowView['nodes'][] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((node) =>
      node.dependsOn.every((id) => done.has(id)),
    );
    if (!ready.length) {
      layers.push([...pending.values()]);
      break;
    }
    layers.push(ready);
    for (const node of ready) {
      pending.delete(node.id);
      done.add(node.id);
    }
  }
  return layers;
}
export function Graph({
  nodes,
  selected,
  route,
}: {
  nodes: WorkflowView['nodes'];
  selected?: string;
  route: Route;
}) {
  if (!nodes.length) return <Empty>该工作流没有节点。</Empty>;
  const layers = graphLayers(nodes);
  const width = Math.max(720, layers.length * 260);
  const height = Math.max(180, ...layers.map((layer) => layer.length * 124 + 36));
  const positions = new Map(
    layers.flatMap((layer, column) =>
      layer.map((node, row) => [node.id, { x: column * 260 + 20, y: row * 124 + 20 }] as const),
    ),
  );
  return (
    <div className="graph-scroll" aria-label="工作流依赖图">
      <div className="graph" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {nodes.flatMap((node) =>
            node.dependsOn.map((source) => {
              const from = positions.get(source);
              const to = positions.get(node.id);
              if (!from || !to) return null;
              return (
                <path
                  key={`${source}:${node.id}`}
                  d={`M ${from.x + 216} ${from.y + 46} C ${from.x + 240} ${from.y + 46}, ${to.x - 24} ${to.y + 46}, ${to.x} ${to.y + 46}`}
                  markerEnd="url(#arrow)"
                />
              );
            }),
          )}
        </svg>
        {nodes.map((node) => {
          const position = positions.get(node.id)!;
          return (
            <a
              className={`graph-node ${selected === node.id ? 'selected' : ''}`}
              aria-current={selected === node.id ? 'true' : undefined}
              key={node.id}
              style={{ left: position.x, top: position.y }}
              href={href({ ...route, node: node.id, attempt: undefined })}
            >
              <span className="eyebrow">{node.kind}</span>
              <strong>{node.title}</strong>
              <Badge status={node.status} />
              <small>
                {node.dependsOn.length ? `依赖 ${node.dependsOn.join('、')}` : '起始节点'} ·{' '}
                {node.attempts.length} 次尝试
              </small>
            </a>
          );
        })}
      </div>
    </div>
  );
}
