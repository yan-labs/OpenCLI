import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { GOOGLE_ACCOUNT_PROBE } from './google-account.js';
import '../gemini/auth.js';
import '../gmail/auth.js';
import '../notebooklm/auth.js';
import '../chatgpt/auth.js';
import '../claude/auth.js';
import '../hf/auth.js';
import '../gitee/auth.js';
import '../jimeng/auth.js';
import '../quark/auth.js';
import '../deepseek/auth.js';
import '../12306/auth.js';
import '../xiaohongshu/auth.js';

function browserFixture({ html = '', url = 'https://example.com', response = {}, status = 200 } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const fetch = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, url: dom.window.location.href,
    json: async () => response, text: async () => JSON.stringify(response) }));
  dom.window.fetch = fetch;
  return {
    dom, fetch, getCookies: vi.fn(async () => []),
    goto: vi.fn(async url => dom.reconfigure({ url })), wait: vi.fn(),
    evaluate: vi.fn(async code => {
      const value = dom.window.eval(code);
      return typeof value === 'function' ? value() : value;
    }),
  };
}
const cmd = (site, name = 'whoami') => getRegistry().get(`${site}/${name}`);

describe('Google account controls', () => {
  it.each(['Google Account: Alice (alice@example.com)', 'Google 账号：小明（alice@example.com）',
    'Google 帐号: 小明\n(alice@example.com)', 'Google 帳戶：小明 (alice@example.com)', 'Google Account: Alice\n(alice@example.com)'])('parses localized controls: %s', async label => {
    const page = browserFixture({ html: `<button aria-label="${label}"></button>`, url: 'https://gemini.google.com/?authuser=2' });
    const result = await page.evaluate(GOOGLE_ACCOUNT_PROBE);
    expect(result).toMatchObject({ ok: true, email: 'alice@example.com', authuser: 2 });
    expect(result.name).toBe(label.includes('Alice') ? 'Alice' : '小明');
    page.dom.window.close();
  });
  it('accepts a Google account label with an email but no display name', async () => {
    const page = browserFixture({ html: '<a aria-label="Google Account: (alice@example.com)"></a>' });
    await expect(cmd('gmail').func(page, {})).resolves.toMatchObject({ logged_in: true, name: null, email: 'alice@example.com' });
    page.dom.window.close();
  });
  it.each(['gemini', 'gmail', 'notebooklm'])('%s verifies the page without cookie preconditions', async site => {
    const page = browserFixture({ html: '<a aria-label="Google Account: Alice (alice@example.com)"></a>' });
    await expect(cmd(site).func(page, {})).resolves.toMatchObject({ logged_in: true, name: 'Alice' });
    expect(page.getCookies).not.toHaveBeenCalled();
    page.dom.window.close();
  });
  it('reports an unrecognized Google page as a probe error', async () => {
    const page = browserFixture();
    await expect(cmd('gmail').func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
    page.dom.window.close();
  });
  it('distinguishes an explicit sign-in surface from missing DOM', async () => {
    const page = browserFixture({ html: '<input type="email">' });
    await expect(cmd('gmail').func(page, {})).rejects.toBeInstanceOf(AuthRequiredError);
    page.dom.window.close();
  });
});

describe('login polling', () => {
  it.each(['gmail', 'gemini', 'notebooklm', 'chatgpt'])('%s leaves OAuth forms alone and completes after a return without cookies', async site => {
    const page = browserFixture({ html: '<input type="email">', response: {}, url: 'https://example.com/' });
    let polls = 0;
    page.wait.mockImplementation(async () => {
      if (!page.dom.window.location.hostname.includes('accounts.google.com') && !page.dom.window.location.hostname.includes('auth.openai.com')) return;
      polls++;
      if (polls === 2) {
        const origin = { gmail: 'https://mail.google.com/', gemini: 'https://gemini.google.com/', notebooklm: 'https://notebooklm.google.com/', chatgpt: 'https://chatgpt.com/' }[site];
        page.dom.reconfigure({ url: origin });
        page.dom.window.document.body.innerHTML = '<button aria-label="Google Account: Alice (alice@example.com)"></button>';
        page.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: { id: 'u1', name: 'Alice' } }) });
      }
    });
    await expect(cmd(site, 'login').func(page, { timeout: 10 })).resolves.toMatchObject({ logged_in: true, status: 'login_complete' });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(polls).toBe(2);
    page.dom.window.close();
  });
  it.each(['hf', 'deepseek', 'gitee', 'jimeng', 'quark'])('%s does not swallow service errors while waiting for login', async site => {
    const page = browserFixture({ url: site === 'hf' ? 'https://huggingface.co/' : 'https://chat.deepseek.com/' });
    page.fetch.mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValue({ ok: false, status: 503 });
    page.dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'fixture-token' }));
    await expect(cmd(site, 'login').func(page, { timeout: 10 })).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.fetch).toHaveBeenCalledTimes(2);
    page.dom.window.close();
  });
});

describe('API auth/error separation', () => {
  it('does not require Claude analytics cookies after authenticated API success', async () => {
    const page = browserFixture({ response: [{ uuid: 'org-1', name: 'Example' }] });
    await expect(cmd('claude').func(page, {})).resolves.toMatchObject({ logged_in: true, user_id: '', org_uuid: 'org-1' });
    page.dom.window.close();
  });
  it.each(['12306', 'xiaohongshu', 'hf', 'deepseek', 'chatgpt', 'claude', 'gitee', 'jimeng', 'quark'])('%s preserves HTTP 503 as a service error', async site => {
    const page = browserFixture({ status: 503, url: site === 'deepseek' ? 'https://chat.deepseek.com/' : 'https://example.com/' });
    page.dom.window.localStorage.setItem('userToken', JSON.stringify({ value: 'fixture-token' }));
    await expect(cmd(site).func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
    page.dom.window.close();
  });
});
