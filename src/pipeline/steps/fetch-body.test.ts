import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BasePage } from '../../browser/base-page.js';
import { ArgumentError } from '../../errors.js';
import type { BrowserEvaluateFunction } from '../../types.js';
import { executePipeline } from '../executor.js';
import { stepFetch } from './fetch.js';

/** Run the generated browser code locally, including the real fetchJson implementation. */
class EvaluationPage extends BasePage {
  async goto(): Promise<void> {}
  async evaluate<T = unknown>(source: string): Promise<T>;
  async evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>;
  async evaluate(source: string | BrowserEvaluateFunction<unknown[], unknown>, ...args: unknown[]): Promise<unknown> {
    if (typeof source === 'function') return source(...args);
    const result = (0, eval)(source);
    return typeof result === 'function' ? result() : result;
  }
  async getCookies(): Promise<[]> { return []; }
  async screenshot(): Promise<string> { return ''; }
  async tabs(): Promise<unknown[]> { return []; }
  async selectTab(): Promise<void> {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['node', 'browser'] as const)('fetch JSON bodies (%s)', (transport) => {
  const page = () => transport === 'browser' ? new EvaluationPage() : null;

  function mockFetch() {
    const mock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('renders nested GraphQL variables and retains JSON value types', async () => {
    const fetch = mockFetch();
    const body = {
      query: 'query Search($limit: Int!) { search(limit: $limit) { id } }',
      variables: {
        limit: '${{ args.limit }}', active: '${{ args.active }}',
        labels: ['${{ args.label }}', null], nested: { ids: '${{ data.ids }}' },
      },
    };
    const original = JSON.stringify(body);
    await expect(stepFetch(page(), {
      url: 'https://example.com/graphql', method: 'post', body,
    }, { ids: [1, 2] }, { limit: 3, active: false, label: '你好 "query"' })).resolves.toEqual({ ok: true });
    const init = fetch.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      query: body.query,
      variables: { limit: 3, active: false, labels: ['你好 "query"', null], nested: { ids: [1, 2] } },
    });
    expect(JSON.stringify(body)).toBe(original);
    if (transport === 'browser') expect(init.credentials).toBe('include');
  });

  it.each([null, false, 0, 'hello', [1, 'two'], { ok: true }])('sends JSON value %j', async (value) => {
    const fetch = mockFetch();
    await stepFetch(page(), { url: 'https://example.com/api', method: 'PUT', body: '${{ args.payload }}' }, null, { payload: value });
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(value));
  });

  it('does not interpret template-like text inside data returned by an expression', async () => {
    const fetch = mockFetch();
    const payload = { text: '${{ args.secret }}', nested: ['${{ 1 + 1 }}'] };
    await stepFetch(page(), {
      url: 'https://example.com/api', method: 'PATCH', body: { input: '${{ args.payload }}' },
    }, null, { payload, secret: 'should not be substituted' });
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ input: payload });
  });

  it.each(['content-type', 'CONTENT-TYPE'])('preserves an explicit %s header', async (key) => {
    const fetch = mockFetch();
    await stepFetch(page(), {
      url: 'https://example.com/api', method: 'POST', body: { value: 1 },
      headers: { [key]: 'application/vnd.example+json' },
    }, null, {});
    const headers = fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers[key]).toBe('application/vnd.example+json');
    expect(Object.keys(headers).filter(name => name.toLowerCase() === 'content-type')).toEqual([key]);
  });

  it('supports per-item bodies, query parameters and headers at a fixed endpoint', async () => {
    const fetch = mockFetch();
    const input = [{ id: 'a/b' }, { id: 'c d' }];
    const result = await stepFetch(page(), {
      url: 'https://example.com/graphql?existing=1', method: 'POST', forEach: true,
      headers: { 'X-Item': '${{ item.id }}', 'X-Index': '${{ index }}' },
      params: { id: '${{ item.id }}', total: '${{ data.length }}' },
      body: { id: '${{ item.id }}', index: '${{ index }}', token: '${{ args.token }}' },
    }, input, { token: 'token' });
    expect(result).toEqual([{ ok: true }, { ok: true }]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/graphql?existing=1&id=a%2Fb&total=2',
      'https://example.com/graphql?existing=1&id=c+d&total=2',
    ]);
    for (const [index, [, init]] of fetch.mock.calls.entries()) {
      expect(JSON.parse(String(init.body))).toEqual({ id: input[index].id, index, token: 'token' });
      expect(init.headers).toMatchObject({ 'X-Item': input[index].id, 'X-Index': String(index) });
      if (transport === 'browser') expect(init.credentials).toBe('include');
    }
  });

  it('retains implicit per-item URL batching with JSON bodies', async () => {
    const fetch = mockFetch();
    await stepFetch(page(), {
      url: 'https://example.com/${{ item.id }}', method: 'DELETE', body: { id: '${{ item.id }}' },
    }, [{ id: 1 }, { id: 2 }], {});
    expect(fetch.mock.calls.map(([url, init]) => [url, init.body])).toEqual([
      ['https://example.com/1', '{"id":1}'], ['https://example.com/2', '{"id":2}'],
    ]);
  });

  it('can send an entire array in a single request with forEach false', async () => {
    const fetch = mockFetch();
    const data = [{ id: 1 }, { id: 2 }];
    await stepFetch(page(), {
      url: 'https://example.com/items', method: 'POST', forEach: false, body: '${{ data }}',
    }, data, {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(data));
  });

  it('limits concurrent requests and preserves order when they finish out of order', async () => {
    const completions: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      const body = JSON.parse(String(init.body));
      active++;
      peak = Math.max(peak, active);
      completions[body.id] = () => { active--; resolve(Response.json(body)); };
    }));
    vi.stubGlobal('fetch', fetch);
    const result = stepFetch(page(), {
      url: 'https://example.com/api', method: 'POST', forEach: true,
      concurrency: 2, body: '${{ item }}',
    }, [{ id: 0 }, { id: 1 }, { id: 2 }], {});
    expect(fetch).toHaveBeenCalledTimes(2);
    completions[1]();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    completions[2]();
    completions[0]();
    await expect(result).resolves.toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(peak).toBe(2);
  });

  it('returns individual failures without replaying successful POST requests', async () => {
    const fetch = mockFetch();
    fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return body.id === 2 ? new Response('failed', { status: 503, statusText: 'Unavailable' }) : Response.json(body);
    });
    const result = await stepFetch(page(), {
      url: 'https://example.com/api', method: 'POST', forEach: true, body: '${{ item }}',
    }, [{ id: 1 }, { id: 2 }, { id: 3 }], {});
    expect(result).toEqual([{ id: 1 }, { error: 'HTTP 503 Unavailable from https://example.com/api' }, { id: 3 }]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not issue requests for an empty explicit batch', async () => {
    const fetch = mockFetch();
    const target = page();
    const evaluate = target && vi.spyOn(target, 'evaluate');
    await expect(stepFetch(target, {
      url: 'https://example.com/api', method: 'POST', forEach: true, body: '${{ item }}',
    }, [], {})).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    if (evaluate) expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(['GET', 'get', 'HEAD'])('rejects a %s body before sending requests', async (method) => {
    const fetch = mockFetch();
    await expect(stepFetch(page(), { url: 'https://example.com/api', method, body: {} }, null, {}))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, 'true', 1])('rejects invalid forEach %j', async (forEach) => {
    const fetch = mockFetch();
    await expect(stepFetch(page(), { url: 'https://example.com/api', forEach }, [], {}))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires an array for explicit batching', async () => {
    const fetch = mockFetch();
    await expect(stepFetch(page(), { url: 'https://example.com/api', forEach: true }, {}, {}))
      .rejects.toThrow('requires array data');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 1n])('validates all bodies before issuing a partial batch (%s)', async (invalid) => {
    const fetch = mockFetch();
    await expect(stepFetch(page(), {
      url: 'https://example.com/api', method: 'POST', forEach: true, body: '${{ item.body }}',
    }, [{ body: { valid: true } }, { body: invalid }], {})).rejects.toBeInstanceOf(ArgumentError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cyclic template containers and cyclic expression values', async () => {
    const fetch = mockFetch();
    const body: Record<string, unknown> = {};
    body.self = body;
    for (const template of [body, '${{ args.payload }}']) {
      await expect(stepFetch(page(), {
        url: 'https://example.com/api', method: 'POST', body: template,
      }, null, { payload: body })).rejects.toBeInstanceOf(ArgumentError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps omitted bodies absent', async () => {
    const fetch = mockFetch();
    await stepFetch(page(), { url: 'https://example.com/api', method: 'POST' }, null, {});
    const init = fetch.mock.calls[0][1];
    expect(init).not.toHaveProperty('body');
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('executes a complete pipeline against a local HTTP endpoint', async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        result: {
          method: request.method, contentType: request.headers['content-type'],
          payload: JSON.parse(Buffer.concat(chunks).toString()),
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
      await expect(executePipeline(page(), [
        { fetch: { url, method: 'POST', body: { variables: { query: '${{ args.query }}', limit: 3 } } } },
        { select: 'result' },
      ], { args: { query: '你好 & "quotes"' } })).resolves.toEqual({
        method: 'POST', contentType: 'application/json',
        payload: { variables: { query: '你好 & "quotes"', limit: 3 } },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
