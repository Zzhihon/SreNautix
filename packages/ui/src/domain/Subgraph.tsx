// 根因子图（DESIGN §12.2、§12.5）：只画根因加不超过 2 跳的邻居，用 elkjs 的分层布局，
// 每条边标注来源与置信度；只读，不能拖动。

import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import { useEffect, useState } from 'react';
import type { IncidentSubgraph } from '../contract';
import { useI18n } from '../i18n';
import { EmptyState } from '../primitives/EmptyState';
import { Loading } from '../primitives/basic';
import { componentLabel } from './model';
import styles from './Subgraph.module.css';

type SubNode = IncidentSubgraph['nodes'][number];
type SubData = { n: SubNode; roleText: string; alertsText: string };

const NODE_W = 180;
const NODE_H = 52;
const elk = new ELK();

function ComponentNode({ data }: NodeProps<Node<SubData>>) {
  const l = componentLabel(data.n.component);
  return (
    <div className={styles.node} data-role={data.n.role}>
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.name} title={data.n.component}>
        {l.name}
      </div>
      <div className={styles.sub}>
        {data.roleText} · {l.sub}
        {data.n.alerts.length > 0 && ` · ${data.alertsText}`}
      </div>
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
}

const nodeTypes = { component: ComponentNode };

/** elkjs 分层布局，返回每个节点的左上角坐标。 */
export async function layoutSubgraph(g: IncidentSubgraph): Promise<Map<string, { x: number; y: number }>> {
  const res = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
    },
    children: g.nodes.map((n) => ({ id: n.component, width: NODE_W, height: NODE_H })),
    edges: g.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  });
  const out = new Map<string, { x: number; y: number }>();
  for (const c of res.children ?? []) {
    out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }
  return out;
}

export function Subgraph({ graph }: { graph: IncidentSubgraph }) {
  const { t, fmt } = useI18n();
  const [laid, setLaid] = useState<{ nodes: Node<SubData>[]; edges: Edge[] } | null>(null);
  useEffect(() => {
    let live = true;
    layoutSubgraph(graph).then((pos) => {
      if (!live) {
        return;
      }
      setLaid({
        nodes: graph.nodes.map((n) => {
          const p = pos.get(n.component);
          if (!p) {
            throw new Error(`布局缺少节点 ${n.component}`);
          }
          return {
            id: n.component,
            type: 'component',
            position: p,
            data: {
              n,
              roleText: t(`subgraph.role.${n.role}`),
              alertsText: t('subgraph.alerts', { n: n.alerts.length }),
            },
            draggable: false,
          };
        }),
        edges: graph.edges.map((e, i) => ({
          id: `e${i}`,
          source: e.from,
          target: e.to,
          label: `${e.relation} · ${t(`subgraph.source.${e.provenance}`)} ${fmt.number(e.confidence, 1)}`,
          className: e.confidence < 0.6 ? styles.weak : undefined,
        })),
      });
    });
    return () => {
      live = false;
    };
  }, [graph, t, fmt]);
  if (!graph.nodes.length) {
    return <EmptyState kind="none" title={t('subgraph.empty_title')} because={t('subgraph.empty_because')} />;
  }
  if (!laid) {
    return <Loading />;
  }
  return (
    <div
      className={styles.wrap}
      role="img"
      aria-label={t('subgraph.label', { n: graph.nodes.length, e: graph.edges.length })}
    >
      <ReactFlow
        nodes={laid.nodes}
        edges={laid.edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
      </ReactFlow>
    </div>
  );
}
