import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleAdapter } from '../src/ai/openai-compatible-adapter';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiCompatibleAdapter', () => {
  it('posts the OpenAI Chat Completions request shape and parses the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"summary":"ok","items":[]}' } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b-instruct',
    });

    const result = await adapter.generate('system prompt', 'user prompt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).not.toHaveProperty('Authorization'); // no apiKey configured

    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen2.5:3b-instruct');
    expect(body.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ]);
    expect(body.response_format).toEqual({ type: 'json_object' });

    expect(result).toEqual({
      text: '{"summary":"ok","items":[]}',
      usage: { promptTokens: 42, completionTokens: 7 },
    });
  });

  it('sends an Authorization header when an apiKey is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'https://example.com/v1',
      model: 'some-model',
      apiKey: 'secret-key',
    });

    await adapter.generate('sys', 'user');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-key');
  });

  it('throws when the HTTP response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' }),
    );

    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b-instruct',
    });

    await expect(adapter.generate('sys', 'user')).rejects.toThrow(/500/);
  });

  it('throws when the response has no message content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) }),
    );

    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:3b-instruct',
    });

    await expect(adapter.generate('sys', 'user')).rejects.toThrow(/no content/);
  });
});
