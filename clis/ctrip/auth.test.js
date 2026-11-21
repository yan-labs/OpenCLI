import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import './auth.js';

function fixture(body, { status = 200, url = 'https://www.ctrip.com/', cookies = [], failure } = {}) {
  const dom = new JSDOM('', { url, runScripts: 'outside-only' });
  const fetch = vi.fn(async () => {
    if (failure) throw failure;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
  dom.window.fetch = fetch;
  return {
    dom, fetch,
    goto: vi.fn(async (url) => dom.reconfigure({ url })),
    wait: vi.fn(),
    getCookies: vi.fn(async () => cookies),
    evaluate: vi.fn(async code => dom.window.eval(code)),
  };
}
const whoami = () => getRegistry().get('ctrip/whoami');
const member = { ResponseStatus: { Ack: 'Success' }, uid: 'member-1', userName: '', grade: 30,
  memberAssetSummaries: [{ assetType: 'UserGrade', descInfo: '铂金贵宾' }] };
const anonymous = { ResponseStatus: { Ack: 'Failure', Errors: [{
  ErrorCode: 'AccountsMobileRequestFilterException',
  Message: 'Request head is null and cookie auth is null. cookieName: cticket', ErrorFields: [],
}] }, uid: '', memberAssetSummaries: [] };

describe('Ctrip account verification', () => {
  it('accepts the current member API without legacy login_uid or a display name', async () => {
    const page = fixture(member);
    await expect(whoami().func(page, {})).resolves.toMatchObject({ logged_in: true, user_id: 'member-1', name: '', vip_grade: '30' });
    expect(page.fetch).toHaveBeenCalledWith('https://m.ctrip.com/restapi/soa2/15201/getMemberSummaryInfo', expect.objectContaining({ credentials: 'include', method: 'POST' }));
    page.dom.window.close();
  });
  it('accepts a verified member summary when the current API redacts uid', async () => {
    const page = fixture({ ...member, uid: null, grade: '10' });
    await expect(whoami().func(page, {})).resolves.toMatchObject({ logged_in: true, user_id: '', vip_grade: '10' });
    page.dom.window.close();
  });
  it('does not trust a stale legacy cookie', async () => {
    const page = fixture(anonymous, { cookies: [{ name: 'login_uid', value: 'stale' }] });
    await expect(whoami().func(page, {})).rejects.toBeInstanceOf(AuthRequiredError);
    page.dom.window.close();
  });
  it.each([
    ['service failure', {}, { status: 503 }],
    ['rate limit', {}, { status: 429 }],
    ['schema drift', { ResponseStatus: { Ack: 'Success' } }, {}],
    ['network failure', {}, { failure: new Error('offline') }],
    ['unknown business error', { ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: 'InternalError' }] } }, {}],
  ])('keeps %s distinct from logout', async (_name, body, opts) => {
    const page = fixture(body, opts);
    await expect(whoami().func(page, {})).rejects.toBeInstanceOf(CommandExecutionError);
    page.dom.window.close();
  });
});
