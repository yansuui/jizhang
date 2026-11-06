/** Typed, bounded HTTP client for the private Python item-cutout service. */

export type ItemCutoutState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';

export interface ItemCutoutCandidate {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface ItemCutoutJob {
  readonly jobId: string;
  readonly state: ItemCutoutState;
  readonly message: string;
  readonly candidates: readonly ItemCutoutCandidate[];
}

export class ItemCutoutClientError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ItemCutoutClientError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const JOB_STATES = new Set<ItemCutoutState>([
  'queued',
  'running',
  'ready',
  'failed',
  'cancelled',
]);
const MAX_JOB_JSON_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCandidate(value: unknown): ItemCutoutCandidate | undefined {
  const item = record(value);
  if (
    item === undefined ||
    typeof item['id'] !== 'string' ||
    !/^\d{1,2}$/.test(item['id']) ||
    typeof item['width'] !== 'number' ||
    !Number.isSafeInteger(item['width']) ||
    item['width'] < 1 ||
    item['width'] > 1632 ||
    typeof item['height'] !== 'number' ||
    !Number.isSafeInteger(item['height']) ||
    item['height'] < 1 ||
    item['height'] > 1632
  ) {
    return undefined;
  }
  return { id: item['id'], width: item['width'], height: item['height'] };
}

function parseJob(value: unknown): ItemCutoutJob | undefined {
  const input = record(value);
  if (
    input === undefined ||
    typeof input['jobId'] !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input['jobId']) ||
    typeof input['state'] !== 'string' ||
    !JOB_STATES.has(input['state'] as ItemCutoutState) ||
    typeof input['message'] !== 'string' ||
    !Array.isArray(input['candidates']) ||
    input['candidates'].length > 8
  ) {
    return undefined;
  }
  const candidates = input['candidates'].map(parseCandidate);
  if (candidates.some((candidate) => candidate === undefined)) return undefined;
  return {
    jobId: input['jobId'],
    state: input['state'] as ItemCutoutState,
    message: input['message'],
    candidates: candidates as ItemCutoutCandidate[],
  };
}

/** Invalid service responses never cross the public API boundary. */
export class ItemCutoutClient {
  private readonly baseUrl: URL | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl === undefined ? undefined : new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.fetchImpl = fetchImpl;
  }

  get configured(): boolean {
    return this.baseUrl !== undefined;
  }

  async createJob(bytes: Buffer, contentType = 'image/webp'): Promise<{ readonly jobId: string }> {
    const body = await this.json('jobs', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes,
      timeoutMs: 5000,
    });
    const result = record(body);
    if (result === undefined || typeof result['jobId'] !== 'string' || !/^[a-f0-9]{32}$/.test(result['jobId'])) {
      throw this.invalidResponse();
    }
    return { jobId: result['jobId'] };
  }

  async getJob(jobId: string): Promise<ItemCutoutJob> {
    const result = parseJob(await this.json(`jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 2500 }));
    if (result === undefined || result.jobId !== jobId) throw this.invalidResponse();
    return result;
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.noContent(`jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      timeoutMs: 2500,
    });
  }

  async getCandidatePreview(jobId: string, candidateId: string): Promise<Buffer> {
    return this.binary(
      `jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/preview`,
      'image/webp',
      MAX_PREVIEW_BYTES,
    );
  }

  async getCandidateImage(jobId: string, candidateId: string): Promise<Buffer> {
    return this.binary(
      `jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/image`,
      'image/png',
      MAX_CANDIDATE_BYTES,
    );
  }

  private async json(path: string, options: RequestInit & { timeoutMs: number }): Promise<unknown> {
    const response = await this.request(path, options);
    if (!response.ok) throw this.mapUpstreamError(response.status);
    const text = (await this.readBytes(response, MAX_JOB_JSON_BYTES)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw this.invalidResponse();
    }
    return parsed;
  }

  private async noContent(path: string, options: RequestInit & { timeoutMs: number }): Promise<void> {
    const response = await this.request(path, options);
    if (!response.ok) throw this.mapUpstreamError(response.status);
    if (response.status !== 204) throw this.invalidResponse();
  }

  private async binary(path: string, contentType: string, maxBytes: number): Promise<Buffer> {
    const response = await this.request(path, { timeoutMs: 20_000 });
    if (!response.ok) throw this.mapUpstreamError(response.status);
    const actualType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
    if (actualType !== contentType) throw this.invalidResponse();
    return this.readBytes(response, maxBytes);
  }

  /** Read an upstream body incrementally so a missing/misreported length cannot bypass caps. */
  private async readBytes(response: Response, maxBytes: number): Promise<Buffer> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (
        !/^\d+$/.test(contentLength) ||
        !Number.isSafeInteger(declaredLength) ||
        declaredLength > maxBytes
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw this.invalidResponse();
      }
    }

    const reader = response.body?.getReader();
    if (reader === undefined) throw this.invalidResponse();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw this.invalidResponse();
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof ItemCutoutClientError) throw error;
      throw this.invalidResponse();
    } finally {
      reader.releaseLock();
    }
    if (totalBytes === 0) throw this.invalidResponse();
    return Buffer.concat(chunks, totalBytes);
  }

  private async request(
    path: string,
    options: RequestInit & { timeoutMs: number },
  ): Promise<Response> {
    if (this.baseUrl === undefined) {
      throw new ItemCutoutClientError(
        503,
        'CUTOUT_UNAVAILABLE',
        'AI 抠图服务未配置，仍可继续使用普通照片上传。',
      );
    }
    const { timeoutMs, ...init } = options;
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response;
    } catch {
      throw new ItemCutoutClientError(
        503,
        'CUTOUT_UNAVAILABLE',
        'AI 抠图服务暂时不可用，仍可继续使用普通照片上传。',
      );
    }
  }

  private mapUpstreamError(status: number): ItemCutoutClientError {
    if (status === 404) {
      return new ItemCutoutClientError(404, 'CUTOUT_JOB_NOT_FOUND', '抠图任务已过期，请重新上传图片。');
    }
    if (status === 413) {
      return new ItemCutoutClientError(413, 'ITEM_PHOTO_TOO_LARGE', '图片不能超过 2 MiB，请重新选择照片。');
    }
    if (status === 400 || status === 415 || status === 422) {
      return new ItemCutoutClientError(
        400,
        'CUTOUT_INVALID_IMAGE',
        '图片无法处理，请重新选择照片或使用普通照片上传。',
      );
    }
    if (status === 429) {
      return new ItemCutoutClientError(429, 'CUTOUT_BUSY', '抠图服务正忙，请稍后重试。');
    }
    if (status === 409) {
      return new ItemCutoutClientError(409, 'CUTOUT_NOT_READY', '抠图候选还没有准备好。');
    }
    if (status >= 500) {
      return new ItemCutoutClientError(
        503,
        'CUTOUT_UNAVAILABLE',
        'AI 抠图服务暂时不可用，仍可继续使用普通照片上传。',
      );
    }
    return this.invalidResponse();
  }

  private invalidResponse(): ItemCutoutClientError {
    return new ItemCutoutClientError(502, 'CUTOUT_UPSTREAM_INVALID', 'AI 抠图服务返回了无效结果，请重试。');
  }
}
