import type { Adapter } from '../lib/types.ts';
import defaultAdapter from './default.js';
import hotmart from './hotmart.js';
import youtube from './youtube.js';

export const ADAPTERS: readonly Adapter[] = [hotmart, youtube, defaultAdapter];

export function pickAdapter(pageUrl: string, mediaUrl: string): Adapter {
  return ADAPTERS.find((a) => a.matches(pageUrl, mediaUrl)) ?? defaultAdapter;
}

export function getAdapter(id: string): Adapter {
  return ADAPTERS.find((a) => a.id === id) ?? defaultAdapter;
}
