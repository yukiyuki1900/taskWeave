import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { DemoRecording } from '@taskweave/contracts';
import { createDemoHost } from './host.ts';

const { values } = parseArgs({
  options: { dir: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help)
  console.log(
    'npm run showcase:capture -- [--dir apps/web/dist-demo] [--output docs/media]\n通过 Chromium pipe 与内存资源路由截图/录屏，不监听端口、不访问模型或工作区。先安装 Playwright Chromium。',
  );
else {
  const output = path.resolve(values.output ?? 'docs/media');
  await mkdir(output, { recursive: true });
  const recording = JSON.parse(
    await readFile('apps/web/src/demo/recording.json', 'utf8'),
  ) as DemoRecording;
  const origin = 'https://taskweave-demo.invalid';
  const app = await createDemoHost(values.dir ?? 'apps/web/dist-demo', origin);
  const browser = await chromium.launch({ headless: true }); // Playwright uses pipe, not a debugging port.
  const errors: string[] = [];
  const requests: string[] = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1280 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      reducedMotion: 'reduce',
      recordVideo: { dir: '.cache/showcase/videos', size: { width: 1440, height: 1280 } },
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      requests.push(request.url());
      assert.equal(new URL(request.url()).origin, origin, 'unexpected external request');
      assert.equal(
        new URL(request.url()).pathname.startsWith('/api/'),
        false,
        'Demo unexpectedly requested live API',
      );
      const response = await app(
        new Request(request.url(), { method: request.method(), headers: request.headers() }),
      );
      assert.equal(response.status, 200, `asset unavailable: ${request.url()}`);
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const visit = async (frame: number, suffix = '') => {
      await page.goto(`${origin}/?frame=${frame}#/workflows/${recording.runId}${suffix}`);
      await page.getByRole('region', { name: '演示回放控制' }).waitFor();
      await page.getByText('运行指标', { exact: true }).waitFor();
      await page.locator('.graph-node').first().waitFor();
    };
    await visit(6);
    await page.screenshot({ path: path.join(output, 'workflow.png') });
    await visit(2, '?node=implementation&tab=validation');
    await page.getByText('独立验证', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'validation.png'), fullPage: true });
    const old = (
      recording.frames[1].responses[`/api/v1/workflows/${recording.runId}`].body as {
        data: { nodes: Array<{ id: string; currentAttemptId: string }> };
      }
    ).data.nodes.find((node) => node.id === 'requirements')!.currentAttemptId;
    await visit(8, `?node=requirements&attempt=${old}&tab=artifacts`);
    await page.getByRole('button', { name: /artifacts\/requirements.json/ }).click();
    await page.getByText('产物已变化，无法查看该 attempt 记录的版本。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'history.png'), fullPage: true });
    await visit(0);
    await page.getByRole('combobox', { name: '回放速度' }).selectOption('2000');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector('select[aria-label="回放阶段"]') as HTMLSelectElement)?.value ===
        '11',
      undefined,
      { timeout: 30_000 },
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    const video = page.video()!;
    await context.close();
    await video.saveAs(path.join(output, 'walkthrough.webm'));
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      isMobile: true,
    });
    await mobile.route('**/*', async (route) => {
      const response = await app(new Request(route.request().url()));
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const phone = await mobile.newPage();
    await phone.goto(`${origin}/?frame=6#/workflows/${recording.runId}`);
    await phone.getByText('运行指标', { exact: true }).waitFor();
    assert.equal(
      await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'mobile layout overflows viewport',
    );
    await phone.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    await mobile.close();
    await writeFile(
      path.join(output, 'capture.json'),
      JSON.stringify(
        {
          recording: recording.runId,
          engine: 'Chromium',
          browserVersion: browser.version(),
          transport: 'pipe + in-memory static routes',
          listeningPorts: false,
          liveApiRequests: false,
          modelRequests: false,
          requestCount: requests.length,
          pageErrors: errors,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('截图、录屏及浏览器校验完成；未监听端口或请求真实 API。');
  } finally {
    await browser.close();
  }
}
