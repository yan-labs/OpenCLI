import { expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';

await Promise.all([
  './action.js', './describe.js', './download.js', './generate.js', './history.js',
  './login.js', './quota.js', './settings.js', './status.js', './whoami.js',
].map((file) => import(file)));

it('adapter exposes the intentional ten-command surface', () => {
  const commands = [...new Set([...getRegistry().values()]
    .filter((command) => command.site === 'midjourney')
    .map((command) => command.name))].sort();
  expect(commands).toEqual([
    'action', 'describe', 'download', 'generate', 'history',
    'login', 'quota', 'settings', 'status', 'whoami',
  ]);
});
