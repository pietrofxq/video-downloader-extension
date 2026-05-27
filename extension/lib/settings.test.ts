import { beforeEach, describe, it, expect, vi } from 'vitest';

type SettingsModule = typeof import('./settings.js');

let mod: SettingsModule;
let backing: Record<string, unknown>;

beforeEach(async () => {
  backing = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          const out: Record<string, unknown> = {};
          if (key in backing) out[key] = backing[key];
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(backing, obj);
        }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  vi.resetModules();
  mod = await import('./settings.js');
});

describe('getSettings / setSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    const s = await mod.getSettings();
    expect(s).toEqual(mod.DEFAULT_SETTINGS);
  });

  it('round-trips a partial patch, merging over defaults', async () => {
    await mod.setSettings({ defaultQuality: '720p' });
    const s = await mod.getSettings();
    expect(s.defaultQuality).toBe('720p');
    expect(s.concurrency).toBe(mod.CONCURRENCY_DEFAULT); // untouched
  });

  it('a second patch does not clobber an earlier field', async () => {
    await mod.setSettings({ concurrency: 6 });
    await mod.setSettings({ defaultQuality: '1080p' });
    const s = await mod.getSettings();
    expect(s.concurrency).toBe(6);
    expect(s.defaultQuality).toBe('1080p');
  });

  it('clamps an out-of-range concurrency on write', async () => {
    await mod.setSettings({ concurrency: 99 });
    expect((await mod.getSettings()).concurrency).toBe(mod.CONCURRENCY_MAX);
    await mod.setSettings({ concurrency: 0 });
    expect((await mod.getSettings()).concurrency).toBe(mod.CONCURRENCY_MIN);
  });

  it('falls back to defaults on a corrupt stored blob', async () => {
    backing.settings = { defaultQuality: 'ultra', concurrency: 'lots', blockedOrigins: 'nope' };
    const s = await mod.getSettings();
    expect(s.defaultQuality).toBe('highest');
    expect(s.concurrency).toBe(mod.CONCURRENCY_DEFAULT);
    expect(s.blockedOrigins).toEqual([]);
  });
});

describe('clampConcurrency', () => {
  it('rounds and clamps to [1, 8]', () => {
    expect(mod.clampConcurrency(4)).toBe(4);
    expect(mod.clampConcurrency(3.6)).toBe(4);
    expect(mod.clampConcurrency(-2)).toBe(1);
    expect(mod.clampConcurrency(100)).toBe(8);
    expect(mod.clampConcurrency('x')).toBe(mod.CONCURRENCY_DEFAULT);
  });
});

describe('isAdapterEnabled', () => {
  it('treats a missing key as enabled (opt-out)', () => {
    const s = mod.DEFAULT_SETTINGS;
    expect(mod.isAdapterEnabled(s, 'hotmart')).toBe(true);
  });

  it('honors an explicit disable', () => {
    const s = { ...mod.DEFAULT_SETTINGS, adapterEnabled: { hotmart: false } };
    expect(mod.isAdapterEnabled(s, 'hotmart')).toBe(false);
    expect(mod.isAdapterEnabled(s, 'youtube')).toBe(true);
  });
});

describe('isOriginBlocked / normalizeHost', () => {
  it('matches a blocked host against a page URL', () => {
    const s = { ...mod.DEFAULT_SETTINGS, blockedOrigins: ['example.com'] };
    expect(mod.isOriginBlocked(s, 'https://example.com/watch?v=1')).toBe(true);
    expect(mod.isOriginBlocked(s, 'https://other.com/x')).toBe(false);
  });

  it('normalizes a full URL or scheme-prefixed entry down to the host', () => {
    expect(mod.normalizeHost('https://example.com/path')).toBe('example.com');
    expect(mod.normalizeHost('Example.com')).toBe('example.com');
    expect(mod.normalizeHost('  http://sub.foo.org  ')).toBe('sub.foo.org');
  });

  it('is a no-op when the block list is empty', () => {
    expect(mod.isOriginBlocked(mod.DEFAULT_SETTINGS, 'https://anything.com')).toBe(false);
  });
});

describe('filenameTemplateFor', () => {
  it('prefers a user override', () => {
    const s = { ...mod.DEFAULT_SETTINGS, filenameTemplates: { youtube: '{title}' } };
    expect(mod.filenameTemplateFor(s, 'youtube')).toBe('{title}');
  });

  it('falls back to the adapter default then the generic default', () => {
    expect(mod.filenameTemplateFor(mod.DEFAULT_SETTINGS, 'hotmart')).toBe('{section} - {lesson}');
    expect(mod.filenameTemplateFor(mod.DEFAULT_SETTINGS, 'unknown-adapter')).toBe(
      mod.FILENAME_TEMPLATE_DEFAULTS.default,
    );
  });

  it('ignores a blank override', () => {
    const s = { ...mod.DEFAULT_SETTINGS, filenameTemplates: { youtube: '   ' } };
    expect(mod.filenameTemplateFor(s, 'youtube')).toBe('{channel} - {title}');
  });
});

describe('renderFilenameTemplate', () => {
  it('substitutes tokens', () => {
    expect(
      mod.renderFilenameTemplate('{channel} - {title}', { channel: 'NASA', title: 'Launch' }),
    ).toBe('NASA - Launch');
  });

  it('drops a dangling separator left by an empty token', () => {
    expect(mod.renderFilenameTemplate('{section} - {lesson}', { lesson: 'Intro' })).toBe('Intro');
    expect(mod.renderFilenameTemplate('{channel} - {title}', { title: 'Solo' })).toBe('Solo');
  });

  it('sanitizes illegal filename characters', () => {
    expect(mod.renderFilenameTemplate('{title}', { title: 'a/b:c?d' })).toBe('abcd');
  });

  it('returns empty string when nothing resolves (caller falls back to adapter)', () => {
    expect(mod.renderFilenameTemplate('{section} - {lesson}', {})).toBe('');
  });
});

describe('onSettingsChanged', () => {
  it('fires only for local-area settings changes and can unsubscribe', () => {
    const cb = vi.fn();
    const off = mod.onSettingsChanged(cb);
    const chromeMock = (
      globalThis as unknown as {
        chrome: { storage: { onChanged: { addListener: ReturnType<typeof vi.fn> } } };
      }
    ).chrome.storage.onChanged;
    const listener = chromeMock.addListener.mock.calls[0][0] as (
      changes: Record<string, { newValue: unknown }>,
      area: string,
    ) => void;

    listener({ settings: { newValue: { defaultQuality: '480p' } } }, 'sync'); // wrong area
    expect(cb).not.toHaveBeenCalled();

    listener({ other: { newValue: 1 } }, 'local'); // wrong key
    expect(cb).not.toHaveBeenCalled();

    listener({ settings: { newValue: { defaultQuality: '480p' } } }, 'local');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].defaultQuality).toBe('480p');

    off();
  });
});
