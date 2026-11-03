export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}
