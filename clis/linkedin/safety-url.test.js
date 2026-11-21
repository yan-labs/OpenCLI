import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { __test__ as experience } from './profile-experience.js';
import { __test__ as projects } from './profile-projects.js';

describe('LinkedIn browser-realm URL extraction', () => {
  it('rejects credentials at both redirect layers and preserves relative links in all three extractors', () => {
    const links = [
      'https://user:pass@example.com/direct',
      '/safety/go/?url=' + encodeURIComponent('https://user:pass@example.com/redirect'),
      'https://user:pass@www.linkedin.com/safety/go/?url=' + encodeURIComponent('https://example.com/wrapped'),
      'javascript:alert(1)',
      '/overlay/Position/123',
      '/safety/go/?url=' + encodeURIComponent('https://example.com/valid'),
    ].map(href => `<a href="${href}">Resource</a>`).join('\n');
    const html = `<main><li>Engineer\nExample Corp\nJan 2024 - Present\n<a href="/in/me/details/experience/edit/forms/1">Edit</a>${links}</li></main><dialog open>${links}</dialog>`;
    const dom = new JSDOM(html, { url: 'https://www.linkedin.com/in/me/', runScripts: 'outside-only' });
    try {
      const scripts = [
        [experience.buildExperienceExtractionScript(), value => value.experienceRows[0].urls],
        [experience.buildDialogExtractionScript(), value => value.urls.join(' | ')],
        [projects.buildProjectsExtractionScript(), value => value.projectRows[0].urls],
      ];
      for (const [script, read] of scripts) {
        const urls = read(dom.window.eval(script));
        expect(urls).not.toMatch(/user:pass|example\.com\/(direct|redirect|wrapped)|javascript:/);
        expect(urls).toContain('https://www.linkedin.com/overlay/Position/123');
        expect(urls).toContain('https://example.com/valid');
      }
    } finally { dom.window.close(); }
  });
});
