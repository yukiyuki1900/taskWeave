export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, string | number>) { super(message); }
}
export function badRequest(message = '请求参数无效'): never { throw new ApiFailure(400, 'INVALID_REQUEST', message); }
