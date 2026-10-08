/*
 * Global keyboard shortcuts (ignored while typing in a field or when a modifier key is held):
 *   /        focus the page's search box (the first FilterBar search input)
 *   g then d Dashboard · i Inspections · n New inspection · r Review queue · e Exceptions
 *            p Purchase orders · a Audit trail · h System health · s Settings · ? Help
 * Documented on the Help page (SHORTCUTS is the single source).
 */
import { useEffect } from 'react';
import { navigate } from '../lib/router';

export const SHORTCUTS = [
  { keys: '/', description: 'Focus the search box on the current page' },
  { keys: 'g d', page: 'dashboard', description: 'Go to Dashboard' },
  { keys: 'g i', page: 'inspections', description: 'Go to Inspections' },
  { keys: 'g n', page: 'new-inspection', description: 'Start a new inspection' },
  { keys: 'g r', page: 'reviews', description: 'Go to Review queue' },
  { keys: 'g e', page: 'exceptions', description: 'Go to Exceptions' },
  { keys: 'g p', page: 'purchase-orders', description: 'Go to Purchase orders' },
  { keys: 'g a', page: 'audit', description: 'Go to Audit trail' },
  { keys: 'g h', page: 'system-health', description: 'Go to System health' },
  { keys: 'g s', page: 'settings', description: 'Go to Settings' },
  { keys: 'g ?', page: 'help', description: 'Go to Help' },
];

const GO_MAP = Object.fromEntries(SHORTCUTS.filter((s) => s.page).map((s) => [s.keys.split(' ')[1], s.page]));

const isTyping = (target) => {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

export function useShortcuts(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    let pendingG = 0;
    const onKey = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (document.body.classList.contains('modal-open')) return;
      if (event.key === '/') {
        const input = document.querySelector('.ui-search input');
        if (input) { event.preventDefault(); input.focus(); }
        return;
      }
      if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        const page = GO_MAP[event.key.toLowerCase()] || GO_MAP[event.key];
        if (page) { event.preventDefault(); navigate(page); }
        return;
      }
      if (event.key === 'g') pendingG = Date.now();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
