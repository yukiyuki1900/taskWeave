import { Component, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkspaceView } from '@taskweave/contracts';
import { parseRoute } from './data/routes.ts';
import { useQuery } from './data/use-query.ts';
import { RunList } from './pages/list.tsx';
import { WorkflowPage } from './pages/workflow.tsx';
import { TaskDetail } from './components/task-detail.tsx';
import { useDataSource } from './data/source.tsx';
import { Empty, QueryFeedback } from './components/common.tsx';

export function App({ notice }: { notice?: ReactNode }) {
  const { mode } = useDataSource();
  const demo = mode === 'demo';
  const [hash, setHash] = useState(window.location.hash);
  const route = parseRoute(hash);
  const workspace = useQuery<WorkspaceView>('/api/v1/workspace', false);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    const connected = () => setOnline(navigator.onLine);
    window.addEventListener('hashchange', change);
    window.addEventListener('online', connected);
    window.addEventListener('offline', connected);
    return () => {
      window.removeEventListener('hashchange', change);
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', connected);
    };
  }, []);
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/workflows">
          <span className="brand-mark">W</span>
          <span>
            TaskWeave<small>Agent 工作台</small>
          </span>
        </a>
        <div className="workspace-label">{demo ? 'RECORDED DEMO' : 'LOCAL WORKSPACE'}</div>
        <div className="workspace-name">{workspace.response?.data.name ?? 'TaskWeave'}</div>
        <nav aria-label="主导航">
          <a
            href="#/workflows"
            aria-current={route?.collection === 'workflows' ? 'page' : undefined}
          >
            <span>◇</span> 工作流运行
          </a>
          <a href="#/tasks" aria-current={route?.collection === 'tasks' ? 'page' : undefined}>
            <span>▤</span> 任务记录
          </a>
        </nav>
        <div className="sidebar-note">
          <span className="live-dot" /> {demo ? '静态脚本回放' : '本地只读展示'}
          <p>
            {demo ? (
              <>
                仅展示已录制轨迹，
                <br />
                不触发真实执行。
              </>
            ) : (
              <>
                执行、输入与人工验收
                <br />
                继续通过 CLI 完成。
              </>
            )}
          </p>
          <small>v0.5.0-alpha.1</small>
        </div>
      </aside>
      <div className="main-area">
        <div className="topbar">
          <span>任务编织 / 运行观察</span>
          <span className="connection">
            {demo
              ? '◈ 静态演示 · 不连接工作区'
              : online
                ? '◉ 本地数据源 · 只读'
                : '○ 网络已断开 · 等待恢复'}
          </span>
        </div>
        <main>
          {notice}
          <QueryFeedback query={workspace} />
          <ViewBoundary key={`${route?.collection}:${route?.id ?? 'list'}`}>
            {!route ? (
              <Empty>
                页面地址无效。<a href="#/workflows">返回工作流列表</a>
              </Empty>
            ) : !route.id ? (
              <RunList key={route.collection} collection={route.collection} />
            ) : route.collection === 'workflows' ? (
              <WorkflowPage key={route.id} route={{ ...route, id: route.id }} />
            ) : (
              <>
                <header className="page-heading">
                  <div>
                    <a className="back" href="#/tasks">
                      ← 任务记录
                    </a>
                    <h1>任务详情</h1>
                  </div>
                </header>
                <TaskDetail key={route.id} id={route.id} route={route} />
              </>
            )}
          </ViewBoundary>
          <footer>
            TaskWeave · 把目标织成任务，把任务落成产物。
            <span>
              {demo ? '数据来自脚本录制，不代表真实模型表现。' : '数据来自当前工作区，不调用模型。'}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="notice error" role="alert">
        页面数据无法展示。请确认 Server 与 Web 为相同版本，然后
        <a href="#/workflows">返回列表</a>或刷新页面。
      </div>
    ) : (
      this.props.children
    );
  }
}
