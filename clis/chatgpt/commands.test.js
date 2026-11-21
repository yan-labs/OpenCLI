import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import './ask.js';
import './send.js';
import './read.js';
import './history.js';
import './detail.js';
import './deep-research-result.js';
import './new.js';
import './status.js';
import './image.js';
import './model.js';
import './project-list.js';
import './project-file-add.js';

const tempDirs = [];

afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function createProjectUploadPageMock() {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined),
        setFileInput: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn((script) => {
            const s = String(script);
            if (s.includes('isVisible') && s.includes('hasComposer') && s.includes('isLoggedIn')) {
                return Promise.resolve({ session: 'test', data: { url: 'https://chatgpt.com/g/g-p-12345678', title: 'Project', hasComposer: true, isLoggedIn: true, hasLoginGate: false } });
            }
            if (s.includes('expectedFileNames')) return Promise.resolve({ ok: true });
            if (s.includes('Add files')) return Promise.resolve(true);
            if (s.includes('role="dialog"')) return Promise.resolve(true);
            return Promise.resolve(undefined);
        }),
    };
}

describe('chatgpt browser command registration', () => {
    it('registers the baseline web chat commands with persistent site sessions', () => {
        const expectedAccess = {
            ask: 'write',
            send: 'write',
            read: 'read',
            history: 'read',
            detail: 'read',
            'deep-research-result': 'read',
            new: 'read',
            status: 'read',
            image: 'write',
            model: 'write',
            'project-list': 'read',
            'project-file-add': 'write',
        };

        for (const [name, access] of Object.entries(expectedAccess)) {
            const cmd = getRegistry().get(`chatgpt/${name}`);
            expect(cmd, `chatgpt/${name}`).toBeDefined();
            expect(cmd.site).toBe('chatgpt');
            expect(cmd.domain).toBe('chatgpt.com');
            expect(cmd.strategy).toBe('cookie');
            expect(cmd.browser).toBe(true);
            expect(cmd.siteSession).toBe('persistent');
            expect(cmd.navigateBefore).toBe(false);
            expect(cmd.access).toBe(access);
        }
    });

    it('rejects using project and conversation routing together', async () => {
        const ask = getRegistry().get('chatgpt/ask');
        const send = getRegistry().get('chatgpt/send');
        const page = {
            goto: () => {
                throw new Error('should not navigate');
            },
        };

        await expect(ask.func(page, { prompt: 'hello', project: '12345678', conversation: 'abcdefghi' }))
            .rejects.toMatchObject({ code: 'ARGUMENT' });
        await expect(send.func(page, { prompt: 'hello', project: '12345678', conversation: 'abcdefghi' }))
            .rejects.toMatchObject({ code: 'ARGUMENT' });
    });

    it('does not return a success row when no completed deep research report exists', async () => {
        const command = getRegistry().get('chatgpt/deep-research-result');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            sleep: vi.fn().mockResolvedValue(undefined),
            startNetworkCapture: vi.fn().mockResolvedValue(true),
            readNetworkCapture: vi.fn().mockResolvedValue([]),
            getCookies: vi.fn().mockResolvedValue([]),
            evaluate: vi.fn((script) => {
                const s = String(script);
                if (s === 'window.location.href') return Promise.resolve('https://chatgpt.com/');
                if (s.includes("fetch('/backend-api/conversation/requested123'")) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        contentType: 'application/json',
                        text: JSON.stringify({ mapping: {} }),
                    });
                }
                if (s.includes("document.querySelectorAll('iframe')")) {
                    return Promise.resolve({
                        url: 'https://chatgpt.com/c/requested123',
                        title: 'ChatGPT',
                        iframes: [],
                        deepResearchIframe: null,
                    });
                }
                if (s.includes('composerSelectors') && s.includes('hasComposer')) {
                    return Promise.resolve({
                        url: 'https://chatgpt.com/c/requested123',
                        title: 'ChatGPT',
                        hasComposer: true,
                        isLoggedIn: true,
                        hasLoginGate: false,
                    });
                }
                if (s.includes('Stop generating') || s.includes('Thinking')) return Promise.resolve(false);
                return Promise.resolve(undefined);
            }),
        };

        await expect(command.func(page, { id: 'requested123' }))
            .rejects.toBeInstanceOf(EmptyResultError);
    });

    it('returns structured deep research progress rows without a completed report', async () => {
        const command = getRegistry().get('chatgpt/deep-research-result');
        const payload = {
            conversation_id: 'requested123',
            mapping: {
                progress_node: {
                    message: {
                        metadata: {
                            chatgpt_sdk: {
                                widget_state: JSON.stringify({
                                    status: 'waiting_for_user_response_on_plan',
                                    waiting_for_user_response_on_plan_until: '2026-07-02T02:29:48.298274Z',
                                    plan: {
                                        plan_id: 'plan-demo',
                                        title: 'Research plan',
                                    },
                                }),
                                response_metadata: {
                                    async_task_conversation_id: 'async-conversation-123',
                                    'openai/widgetSessionId': 'widget-session-123',
                                    'openai/asyncStatus': 7,
                                    venus_message_type: 'initial_loading_message',
                                },
                            },
                        },
                    },
                },
            },
        };
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            sleep: vi.fn().mockResolvedValue(undefined),
            startNetworkCapture: vi.fn().mockResolvedValue(true),
            readNetworkCapture: vi.fn().mockResolvedValue([]),
            getCookies: vi.fn().mockResolvedValue([]),
            evaluate: vi.fn((script) => {
                const s = String(script);
                if (s === 'window.location.href') return Promise.resolve('https://chatgpt.com/');
                if (s.includes("fetch('/backend-api/conversation/requested123'")) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        contentType: 'application/json',
                        text: JSON.stringify(payload),
                    });
                }
                if (s.includes("document.querySelectorAll('iframe')")) {
                    return Promise.resolve({
                        url: 'https://chatgpt.com/c/requested123',
                        title: 'ChatGPT',
                        iframes: [],
                        deepResearchIframe: null,
                    });
                }
                if (s.includes('composerSelectors') && s.includes('hasComposer')) {
                    return Promise.resolve({
                        url: 'https://chatgpt.com/c/requested123',
                        title: 'ChatGPT',
                        hasComposer: true,
                        isLoggedIn: true,
                        hasLoginGate: false,
                    });
                }
                if (s.includes('Stop generating') || s.includes('Thinking')) return Promise.resolve(false);
                return Promise.resolve(undefined);
            }),
        };

        await expect(command.func(page, { id: 'requested123' })).resolves.toEqual([
            expect.objectContaining({
                conversationId: 'requested123',
                status: 'waiting_for_user',
                report: '',
                sources: [],
                asyncTaskConversationId: 'async-conversation-123',
                widgetSessionId: 'widget-session-123',
                asyncStatus: 7,
                venusMessageType: 'initial_loading_message',
                venusStatus: 'waiting_for_user_response_on_plan',
                waitingForUserUntil: '2026-07-02T02:29:48.298274Z',
                planTitle: 'Research plan',
                planId: 'plan-demo',
                method: 'conversation-widget-progress',
            }),
        ]);
    });

    it('typed-fails malformed deep research source rows instead of falling back to empty success', async () => {
        const command = getRegistry().get('chatgpt/deep-research-result');
        const report = `# Executive Summary\n\n${'Completed Deep Research report paragraph with enough detail to pass extraction heuristics. '.repeat(12)}\n\n## Sources`;
        const payload = {
            conversation_id: 'requested123',
            mapping: {
                report_node: {
                    message: {
                        metadata: {
                            chatgpt_sdk: {
                                widget_state: JSON.stringify({
                                    status: 'completed',
                                    report_message: {
                                        id: 'report-msg',
                                        content: { parts: [report] },
                                        metadata: {
                                            search_result_groups: [
                                                { entries: [{ title: 'Source without URL' }] },
                                            ],
                                        },
                                    },
                                }),
                            },
                        },
                    },
                },
            },
        };
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            sleep: vi.fn().mockResolvedValue(undefined),
            startNetworkCapture: vi.fn().mockResolvedValue(true),
            readNetworkCapture: vi.fn().mockResolvedValue([]),
            getCookies: vi.fn().mockResolvedValue([]),
            evaluate: vi.fn((script) => {
                const s = String(script);
                if (s === 'window.location.href') return Promise.resolve('https://chatgpt.com/');
                if (s.includes("fetch('/backend-api/conversation/requested123'")) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        contentType: 'application/json',
                        text: JSON.stringify(payload),
                    });
                }
                if (s.includes("document.querySelectorAll('iframe')")) {
                    return Promise.resolve({
                        url: 'https://chatgpt.com/c/requested123',
                        title: 'ChatGPT',
                        iframes: [],
                        deepResearchIframe: null,
                    });
                }
                if (s.includes('composerSelectors') && s.includes('hasComposer')) {
                    return Promise.resolve({
                        url: 'https://chatgpt.com/c/requested123',
                        title: 'ChatGPT',
                        hasComposer: true,
                        isLoggedIn: true,
                        hasLoginGate: false,
                    });
                }
                if (s.includes('Stop generating') || s.includes('Thinking')) return Promise.resolve(false);
                return Promise.resolve(undefined);
            }),
        };

        await expect(command.func(page, { id: 'requested123' }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('starts a new chat inside a project when new receives project routing', async () => {
        const cmd = getRegistry().get('chatgpt/new');
        const page = createProjectUploadPageMock();

        await expect(cmd.func(page, { project: '12345678' }))
            .resolves.toEqual([{ Status: 'New chat started' }]);
        expect(page.goto).toHaveBeenCalledWith('https://chatgpt.com/g/g-p-12345678', { settleMs: 2000 });
    });

    it('rejects off-domain conversation URLs before ask/send can navigate', async () => {
        const ask = getRegistry().get('chatgpt/ask');
        const send = getRegistry().get('chatgpt/send');
        const page = {
            goto: () => {
                throw new Error('should not navigate');
            },
        };

        await expect(ask.func(page, { prompt: 'hello', conversation: 'https://evil.test/c/abc_123-def' }))
            .rejects.toMatchObject({ code: 'ARGUMENT' });
        await expect(send.func(page, { prompt: 'hello', conversation: 'https://evil.test/c/abc_123-def' }))
            .rejects.toMatchObject({ code: 'ARGUMENT' });
    });

    it('rejects empty project-file-add file input', async () => {
        const cmd = getRegistry().get('chatgpt/project-file-add');
        await expect(cmd.func(createProjectUploadPageMock(), { file: ' , ', id: '12345678' }))
            .rejects.toMatchObject({ code: 'ARGUMENT' });
    });

    it('maps successful project-file-add uploads to table rows', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-chatgpt-'));
        tempDirs.push(dir);
        const filePath = path.join(dir, 'report.pdf');
        fs.writeFileSync(filePath, 'fake-pdf');

        const cmd = getRegistry().get('chatgpt/project-file-add');
        await expect(cmd.func(createProjectUploadPageMock(), { file: filePath, id: '12345678' }))
            .resolves.toEqual([
                {
                    Status: '📄 uploaded to project knowledge',
                    File: filePath,
                },
            ]);
    });

    it('maps project-file-add local file validation failures to argument errors', async () => {
        const cmd = getRegistry().get('chatgpt/project-file-add');
        await expect(cmd.func(createProjectUploadPageMock(), { file: '/no/such/report.pdf', id: '12345678' }))
            .rejects.toMatchObject({
                code: 'ARGUMENT',
                message: expect.stringContaining('File not found'),
            });
    });
});
