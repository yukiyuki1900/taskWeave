import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import './styles.css';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (__TASKWEAVE_DEMO__) {
    const [{ Showcase }, { default: data }] = await Promise.all([
      import('./demo/showcase.tsx'),
      import('./demo/recording.json'),
    ]);
    const { parseRecording } = await import('./demo/transport.ts');
    const recording = parseRecording(data);
    if (!window.location.hash)
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search + `#/workflows/${recording.runId}`,
      );
    root.render(
      <StrictMode>
        <Showcase recording={recording} />
      </StrictMode>,
    );
  } else
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
}
void start();
