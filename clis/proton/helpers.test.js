import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { listMessages, pickCode, readMessageInPage, request, requestInPage } from './helpers.js';
import './login.js';
import './whoami.js';
import './inbox.js';

const doms = [];
afterEach(() => { doms.splice(0).forEach((dom) => dom.window.close()); vi.useRealTimers(); });
const item = (id, time, sender = 'otp@example.com', subject = 'Verification') => ({
  ID: id, ConversationID: `thread-${id}`, Sender: { Name: 'Example', Address: sender },
  Subject: subject, Time: time, LabelIDs: ['0'],
});

// Execute the actual serialized browser functions; only the server and navigation are synthetic.
function harness({ messages = [item('new', 200), item('old', 100)], loggedIn = true, grouped = true } = {}) {
  const dom = new JSDOM('<script src="/assets/static/index.test.js"></script><h1>Inbox unusual activity</h1>', {
    url: 'https://mail.proton.me/u/2/inbox', runScripts: 'outside-only',
  });
  doms.push(dom);
  dom.window.localStorage.setItem('ps-2', JSON.stringify({ UID: 'synthetic-uid', UserID: 'account-2' }));
  dom.window.localStorage.setItem('ps-0', JSON.stringify({ UID: 'wrong-account' }));
  const api = vi.fn(async (url) => {
    const path = new URL(url).pathname;
    if (!loggedIn) return new Response('{}', { status: 401 });
    if (path.endsWith('/users')) return Response.json({ Code: 1000, User: { ID: 'account-2', Name: 'example', Email: 'example@proton.me', Keys: ['must-not-return'] } });
    if (path.endsWith('/settings')) return Response.json({ Code: 1000, MailSettings: { ViewMode: grouped ? 0 : 1 } });
    return Response.json({ Code: 1000, Total: messages.length, Messages: messages });
  });
  dom.window.fetch = vi.fn(async (url, options) => {
    if (new URL(url).pathname.startsWith('/assets/')) return new Response('APP_NAME:"proton-mail",APP_VERSION:"5.0.135.9"');
    return api(url, options);
  });
  function body(id, text) {
    const container = dom.window.document.createElement('section');
    container.dataset.messageId = id;
    container.dataset.expanded = 'true';
    container.innerHTML = '<div data-testid="message-content:body"><iframe data-testid="content-iframe"></iframe></div>';
    dom.window.document.body.append(container);
    container.querySelector('iframe').contentDocument.body.innerHTML = text;
  }
  const page = {
    evaluate: vi.fn(async (fn, ...args) => dom.window.eval(`(${fn.toString()})`)(...args)),
    goto: vi.fn(async (url) => {
      dom.reconfigure({ url });
      if (url.includes('/inbox/')) {
        body('other', 'Other code 888888');
        body('new', 'Your code is 123456<blockquote>Old code 654321</blockquote>');
      }
    }),
    wait: vi.fn(async () => {}),
  };
  return { page, dom, api, body, setLoggedIn: (value) => { loggedIn = value; } };
}

const cmd = (name) => getRegistry().get(`proton/${name}`);

describe('Proton API-backed command behavior', () => {
  it('verifies the active account via API, ignores title/body, and never returns session material', async () => {
    const { page, dom, api } = harness();
    dom.window.document.title = 'Wrong account <wrong@proton.me>';
    const identity = await cmd('whoami').func(page, {});
    expect(identity).toEqual({ logged_in: true, site: 'proton', id: 'account-2', username: 'example', email: 'example@proton.me' });
    expect(api.mock.calls[0][1].headers).toMatchObject({ 'x-pm-uid': 'synthetic-uid', 'x-pm-appversion': 'web-mail@5.0.135.9' });
    expect(page.goto).not.toHaveBeenCalled();
    expect(JSON.stringify(identity)).not.toMatch(/synthetic-uid|Keys|must-not-return/);
  });

  it.each(['https://mail.proton.me/', 'https://account.proton.me/mail'])('does not authenticate a document from its URL: %s', async (url) => {
    const { page, dom, api } = harness();
    dom.reconfigure({ url });
    await expect(request(page, 'identity')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects an expired persisted session and quickCheck reports logged out', async () => {
    const { page } = harness({ loggedIn: false });
    await expect(cmd('whoami').func(page, {})).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(cmd('whoami').authStatus.quickCheck(page)).resolves.toEqual({ logged_in: false });
  });

  it.each([
    () => new Response('{}', { status: 403 }),
    () => new Response('<html>error</html>'),
    () => Response.json({ Code: 1000, User: {} }),
    () => Response.json({ Code: 9001 }),
  ])('preserves upstream failures as errors, not logged-out or empty results', async (response) => {
    const { page, api } = harness();
    api.mockImplementation(async () => response());
    await expect(cmd('whoami').func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(cmd('whoami').authStatus.quickCheck(page)).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('does not send credentials if deployed client metadata cannot be found', async () => {
    const { page, dom, api } = harness();
    dom.window.document.querySelector('script').src = 'https://example.com/assets/static/index.test.js';
    await expect(request(page, 'identity')).rejects.toBeInstanceOf(CommandExecutionError);
    expect(api).not.toHaveBeenCalled();
  });

  it('returns API rows without opening messages by default', async () => {
    const { page, api } = harness();
    const rows = await cmd('inbox').func(page, { from: 'otp', since: 150 });
    expect(rows).toEqual([{ id: 'new', sender: 'otp@example.com', subject: 'Verification', time: 200, code: null }]);
    const url = new URL(api.mock.calls.find(([url]) => url.includes('/messages'))[0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ From: 'otp', Begin: '150', LabelID: '0', Sort: 'Time', Desc: '1' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('does not match search echo, subject keywords or unrelated senders', async () => {
    const { page, dom } = harness({ messages: [item('new', 200, 'other@example.com', 'ifood code 654321')] });
    dom.window.document.body.append('Search results for ifood');
    await expect(cmd('inbox').func(page, { from: 'ifood', 'read-code': true })).rejects.toBeInstanceOf(EmptyResultError);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it.each([true, false])('binds newest code to its message ID in grouped=%s mode; ignores older rows and quoted history', async (grouped) => {
    const { page } = harness({ grouped, messages: [item('new', 200), item('old', 100, 'otp@example.com', 'Old code 654321')] });
    const rows = await cmd('inbox').func(page, { from: 'otp', 'read-code': true });
    expect(rows.map((row) => row.code)).toEqual(['123456', null]);
    expect(page.goto).toHaveBeenCalledExactlyOnceWith(`https://mail.proton.me/u/2/inbox/${grouped ? 'thread-new/' : ''}new`);
  });

  it('paginates past nonmatching results without returning incomplete data', async () => {
    const { page, api } = harness();
    api.mockImplementation(async (url) => {
      const second = new URL(url).searchParams.get('Page') === '1';
      return Response.json({ Code: 1000, Total: 2, Messages: [second ? item('match', 100) : item('other', 200, 'other@example.com')] });
    });
    const { messages } = await listMessages(page, 'otp', 1, 0);
    expect(messages.map((row) => row.id)).toEqual(['match']);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each(['repeat', 'empty', 'failure'])('fails rather than returning partial rows on pagination %s', async (mode) => {
    const { page, api } = harness();
    api.mockImplementation(async (url) => {
      const second = new URL(url).searchParams.get('Page') === '1';
      if (second && mode === 'failure') return new Response('{}', { status: 500 });
      return Response.json({ Code: 1000, Total: 2, Messages: second && mode === 'empty' ? [] : [item('same', 200)] });
    });
    await expect(listMessages(page, '', 2, 0)).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('waits for the exact decrypted message and rejects account changes', async () => {
    const { page, dom, body } = harness();
    body('other', 'Wrong code 654321');
    expect(await page.evaluate(readMessageInPage, 'new', '2', 'account-2')).toEqual({ state: 'waiting' });
    body('new', 'Correct code 123456');
    expect(await page.evaluate(readMessageInPage, 'new', '2', 'account-2')).toEqual({ state: 'ready', text: 'Correct code 123456' });
    dom.reconfigure({ url: 'https://mail.proton.me/u/0/inbox' });
    expect(await page.evaluate(readMessageInPage, 'new', '2', 'account-2')).toEqual({ state: 'account-changed' });
  });

  it('preserves HTML block boundaries without splitting inline code digits', async () => {
    const { page, body } = harness();
    body('new', '<div>Your verification code</div><div><span>123</span><span>456</span></div><div>Expires soon</div>');
    const result = await page.evaluate(readMessageInPage, 'new', '2', 'account-2');
    expect(pickCode(result.text)).toBe('123456');
  });

  it('rejects account replacement at the same localID before listing and while reading', async () => {
    const { page, dom, body } = harness();
    dom.window.localStorage.setItem('ps-2', JSON.stringify({ UID: 'other-session', UserID: 'other-account' }));
    await expect(listMessages(page, '', 2, 0, { id: 'account-2', localID: '2' })).rejects.toBeInstanceOf(AuthRequiredError);
    body('new', '123456');
    expect(await page.evaluate(readMessageInPage, 'new', '2', 'account-2')).toEqual({ state: 'account-changed' });
  });

  it('rejects a session switch while an API response is in flight', async () => {
    const { page, dom, api } = harness();
    api.mockImplementation(async () => {
      dom.window.localStorage.setItem('ps-2', JSON.stringify({ UID: 'replacement', UserID: 'account-2' }));
      return Response.json({ Code: 1000, User: { ID: 'account-2', Name: 'example' } });
    });
    await expect(request(page, 'identity')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('login reuses authenticated identity rather than taking an email flag as proof', async () => {
    const { page } = harness();
    await expect(cmd('login').func(page, { email: 'wrong@example.com' })).resolves.toMatchObject({ status: 'already_logged_in', username: 'example' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('interactive login polls until the API verifies the account', async () => {
    const { page, dom, setLoggedIn } = harness({ loggedIn: false });
    page.wait.mockImplementation(async () => {
      setLoggedIn(true);
      dom.reconfigure({ url: 'https://mail.proton.me/u/2/inbox' });
    });
    await expect(cmd('login').func(page, { timeout: 2 })).resolves.toMatchObject({ status: 'login_complete', id: 'account-2' });
  });

  it('times out if only the wrong message is rendered', async () => {
    vi.useFakeTimers();
    const { page, body } = harness();
    page.goto.mockImplementation(async () => body('wrong', '654321'));
    page.wait.mockImplementation(async () => { vi.setSystemTime(Date.now() + 500); });
    await expect(cmd('inbox').func(page, { 'read-code': true, timeout: 1 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('scoped code extraction', () => {
  it.each([
    ['Your code 123456 repeated 123456', '123456'],
    ['Old 123456 and new 654321', ''],
    ['Account a123456@proton.me year 2026 number 1234567890', ''],
    ['Your PIN 8341', '8341'],
  ])('extracts only unambiguous bounded numbers: %s', (text, expected) => {
    expect(pickCode(text)).toBe(expected);
  });
});
