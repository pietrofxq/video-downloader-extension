import defaultAdapter from './default.js';
import hotmart from './hotmart.js';

export const ADAPTERS = [hotmart, defaultAdapter];

export function pickAdapter(pageUrl, mediaUrl) {
  return ADAPTERS.find((a) => a.matches(pageUrl, mediaUrl)) ?? defaultAdapter;
}

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) ?? defaultAdapter;
}
