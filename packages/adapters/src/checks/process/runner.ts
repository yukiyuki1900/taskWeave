import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { Workspace } from '../../workspace/local/workspace.ts';
import { errorMessage, TaskWeaveError } from '@taskweave/core';
import type { CheckDefinition, CheckResult } from '@taskweave/core/types';
import type { CheckRunner, PreparedCheck } from '@taskweave/core/ports';

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function execute(name: string, spec: CheckDefinition, cwd: string, signal: AbortSignal): Promise<CheckResult> {
  signal.throwIfAborted();
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn(spec.command, spec.args, { cwd, shell: false, detached: process.platform !== 'win32', env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let size = 0;
    let status: CheckResult['status'] | undefined;
    let error: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM');
        else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* The process group may have already exited. */ }
    };
    const stop = (reason: CheckResult['status']): void => {
      if (status) return;
      status = reason;
      kill(false);
      killTimer = setTimeout(() => kill(true), 250);
    };
    const abort = (): void => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), spec.timeoutMs);
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]!.on('data', (chunk: Buffer) => {
        const remaining = Math.max(0, spec.maxOutputBytes - size);
        if (remaining) chunks[stream].push(chunk.subarray(0, remaining));
        size += chunk.length;
        if (size > spec.maxOutputBytes) stop('output_limit');
      });
    }
    child.on('error', cause => { error = errorMessage(cause); status ??= 'failed'; });
    child.on('close', code => {
      clearTimeout(timer);
      // Also kill detached descendants if the parent exits before the grace period.
      if (killTimer) { clearTimeout(killTimer); kill(true); }
      signal.removeEventListener('abort', abort);
      const redact = (value: Buffer[]): string => {
        let output = Buffer.concat(value).toString('utf8');
        const secret = process.env.TASKWEAVE_API_KEY;
        if (secret) output = output.split(secret).join('[REDACTED]');
        return output;
      };
      resolve({ name, status: status ?? (code === 0 ? 'passed' : 'failed'), exitCode: code, stdout: redact(chunks.stdout), stderr: redact(chunks.stderr), durationMs: Math.round(performance.now() - started), ...(error ? { error } : {}) });
    });
    if (signal.aborted) abort();
  });
}


export class ProcessCheckRunner implements CheckRunner {
  async prepare(name: string, spec: CheckDefinition, workspace: string): Promise<PreparedCheck> {
    const cwd = await new Workspace(workspace).resolve(spec.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw new TaskWeaveError('INVALID_CHECK_CWD', '验证工作目录必须是普通目录');
    return { run: signal => execute(name, spec, cwd, signal) };
  }
}
