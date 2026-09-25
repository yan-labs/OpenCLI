/**
 * Self-contained `<select>` option setter keyed by the `data-opencli-ref`
 * attribute that `page.snapshot()` annotates elements with. Deliberately
 * does not reuse src/cli.ts's internal `resolveRef()` (not exported, and
 * this module intentionally stays independent of cli.ts internals so the
 * auto command can be unit-tested and merged without touching the CLI's
 * resolver pipeline).
 */

export function selectByRefJs(ref: string, wantedText: string): string {
  const refJson = JSON.stringify(ref);
  const wantedJson = JSON.stringify(wantedText);
  return `
    (() => {
      const ref = ${refJson};
      const wanted = ${wantedJson}.trim().toLowerCase();
      const el = document.querySelector('[data-opencli-ref="' + ref + '"]');
      if (!el) return { error: 'not_found', ref };
      if (el.tagName !== 'SELECT') return { error: 'not_a_select', ref, tag: el.tagName };
      const options = Array.from(el.options);
      let match = options.find(o => o.textContent.trim().toLowerCase() === wanted);
      if (!match) match = options.find(o => o.textContent.trim().toLowerCase().includes(wanted));
      if (!match) match = options.find(o => (o.value || '').trim().toLowerCase() === wanted);
      if (!match) return { error: 'option_not_found', available: options.map(o => o.textContent.trim()) };
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: match.textContent.trim() };
    })()
  `.trim();
}
