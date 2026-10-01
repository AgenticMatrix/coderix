/**
 * Terminal profile detection — inherit the user's system terminal look.
 *
 * Ported from ZCode's `terminalProfile.ts` + `terminalProfileMacOs.ts`.
 * Reads the user's iTerm2 / macOS Terminal / VS Code / kitty / alacritty /
 * Windows Terminal configuration and returns the font family, font size and
 * color theme so the integrated terminal matches what they already use.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

export type TerminalFontFamilySource = 'custom' | 'system' | 'fallback';

export interface TerminalThemeProfile {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalDetectedProfile {
  fontFamily?: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
}

export interface TerminalProfileSettings {
  terminalFontFamily?: string | null;
  terminalInheritSystemProfile?: boolean;
}

interface TerminalFontProfile {
  fontFamily: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
  source: TerminalFontFamilySource;
}

interface TerminalFontProfileInput {
  settings: TerminalProfileSettings;
  env?: NodeJS.ProcessEnv;
}

type TerminalFontDetector = {
  id: string;
  platforms?: readonly NodeJS.Platform[];
  detect: (env: NodeJS.ProcessEnv) => TerminalDetectedProfile | null;
};

const FONT_FAMILY_FALLBACKS = [
  'ui-monospace',
  'SFMono-Regular',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'Cascadia Mono',
  'JetBrains Mono',
  'MesloLGS NF',
  'Hack Nerd Font',
  'Noto Sans Mono CJK SC',
  'monospace',
] as const;

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function normalizeFontFamily(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeDetectedProfile(
  profile: TerminalDetectedProfile | null,
): TerminalDetectedProfile | null {
  if (!profile?.fontFamily && !profile?.fontSize && !profile?.theme) {
    return null;
  }
  return profile;
}

function dedupeFontFamilyStack(primary: string): string {
  const stack = primary
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const fallback of FONT_FAMILY_FALLBACKS) {
    if (!stack.includes(fallback)) {
      stack.push(fallback);
    }
  }
  return stack.join(', ');
}

// ---------------------------------------------------------------------------
// JSONC parsing (VS Code / Windows Terminal settings.json allow comments)
// ---------------------------------------------------------------------------

function stripJsonComments(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === '/' && next === '/') {
      while (index < raw.length && raw[index] !== '\n') index += 1;
      result += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (index < raw.length && !(raw[index] === '*' && raw[index + 1] === '/')) index += 1;
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

function removeJsonTrailingCommas(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',') {
      let nextIndex = index + 1;
      while (/\s/.test(raw[nextIndex] ?? '')) nextIndex += 1;
      if (raw[nextIndex] === '}' || raw[nextIndex] === ']') continue;
    }
    result += char;
  }
  return result;
}

function parseJsonc(raw: string): Record<string, unknown> | null {
  const attempts = [raw, removeJsonTrailingCommas(stripJsonComments(raw))];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function readJsoncFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    return parseJsonc(raw);
  } catch {
    return null;
  }
}

function readNestedString(value: unknown, pathSegments: readonly string[]): string | null {
  let current: unknown = value;
  for (const segment of pathSegments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? normalizeFontFamily(current) : null;
}

function readObjectFile(
  filePath: string,
  parser: (raw: string) => unknown,
): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = parser(readFileSync(filePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectWindowsTerminalFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const localAppData = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (!localAppData) {
    return null;
  }

  const candidates = [
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];

  for (const filePath of candidates) {
    const parsed = readJsoncFile(filePath);
    if (!parsed) {
      continue;
    }

    const defaultProfileId = readNestedString(parsed, ['defaultProfile']);
    const profiles = parsed.profiles as Record<string, unknown> | undefined;
    const list = Array.isArray(profiles?.list) ? profiles?.list : [];
    if (defaultProfileId) {
      for (const item of list) {
        const profile = item as Record<string, unknown> | undefined;
        if (!profile || profile.guid !== defaultProfileId) {
          continue;
        }
        const fontFamily = readNestedString(profile, ['font', 'face']);
        if (fontFamily) {
          return { fontFamily };
        }
      }
    }

    const defaults = profiles?.defaults as Record<string, unknown> | undefined;
    const defaultsFont = readNestedString(defaults, ['font', 'face']);
    if (defaultsFont) {
      return { fontFamily: defaultsFont };
    }

    for (const item of list) {
      const profile = item as Record<string, unknown> | undefined;
      if (!profile) {
        continue;
      }
      const fontFamily = readNestedString(profile, ['font', 'face']);
      if (fontFamily) {
        return { fontFamily };
      }
    }
  }

  return null;
}

function detectVsCodeTerminalFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const appData = env.APPDATA?.trim();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const candidates = [
    appData && join(appData, 'Code', 'User', 'settings.json'),
    appData && join(appData, 'Code - Insiders', 'User', 'settings.json'),
    xdgConfigHome && join(xdgConfigHome, 'Code', 'User', 'settings.json'),
    xdgConfigHome && join(xdgConfigHome, 'Code - Insiders', 'User', 'settings.json'),
    join(homeDir, '.config', 'Code', 'User', 'settings.json'),
    join(homeDir, '.config', 'Code - Insiders', 'User', 'settings.json'),
    join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    join(homeDir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'settings.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const filePath of candidates) {
    const parsed = readJsoncFile(filePath);
    const fontFamily = readNestedString(parsed, ['terminal.integrated.fontFamily']);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  return null;
}

function detectKittyFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, '.config');
  const candidates = [
    join(xdgConfigHome, 'kitty', 'kitty.conf'),
    join(homeDir, 'Library', 'Application Support', 'kitty', 'kitty.conf'),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const raw = readFileSync(filePath, 'utf8');
      const match = raw.match(/^\s*font_family\s+(.+)$/m);
      const fontFamily = normalizeFontFamily(match?.[1]);
      if (fontFamily) {
        return { fontFamily: fontFamily.replace(/^"|"$/g, '') };
      }
    } catch {
      // continue
    }
  }

  return null;
}

function detectAlacrittyFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, '.config');
  const tomlCandidates = [
    join(xdgConfigHome, 'alacritty', 'alacritty.toml'),
    join(homeDir, '.alacritty.toml'),
  ];
  const yamlCandidates = [
    join(xdgConfigHome, 'alacritty', 'alacritty.yml'),
    join(xdgConfigHome, 'alacritty', 'alacritty.yaml'),
  ];

  for (const filePath of tomlCandidates) {
    const parsed = readObjectFile(filePath, parseToml);
    const fontFamily = readNestedString(parsed, ['font', 'normal', 'family']);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  for (const filePath of yamlCandidates) {
    const parsed = readObjectFile(filePath, parseYaml);
    const fontFamily = readNestedString(parsed, ['font', 'normal', 'family']);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// macOS plist detectors (iTerm2 + Terminal.app)
// ---------------------------------------------------------------------------

type TerminalProfileDetector = {
  id: string;
  platforms?: readonly NodeJS.Platform[];
  detect: (env: NodeJS.ProcessEnv) => TerminalDetectedProfile | null;
};

const MACOS_PLIST_READ_TIMEOUT_MS = 2_000;

function normalizeFontSize(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 6 || parsed > 72) {
    return null;
  }
  return parsed;
}

function readMacOsPlistFile(filePath: string): Record<string, unknown> | null {
  if (process.platform !== 'darwin' || !existsSync(filePath)) {
    return null;
  }

  try {
    const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', filePath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: MACOS_PLIST_READ_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeMacOsFontName(value: string | null | undefined): string | null {
  const normalized = normalizeFontFamily(value);
  if (!normalized) {
    return null;
  }

  const withoutSize = normalized.replace(/\s+\d+(?:\.\d+)?$/, '');
  return normalizeFontFamily(withoutSize.replace(/-/g, ' '));
}

function readMacOsFontDescriptor(
  value: unknown,
): Pick<TerminalDetectedProfile, 'fontFamily' | 'fontSize'> {
  const raw = typeof value === 'string' ? value : value?.toString();
  const fontFamily = normalizeMacOsFontName(raw) ?? undefined;
  const fontSize = normalizeFontSize(raw?.match(/\s+(\d+(?:\.\d+)?)$/)?.[1]) ?? undefined;
  return {
    fontFamily,
    fontSize,
  };
}

function readMacOsArchivedFontName(value: unknown): string | null {
  const rawData =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).NS?.toString()
        : null;
  const normalizedData = normalizeFontFamily(rawData);
  if (!normalizedData) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalizedData, 'base64').toString('latin1');
    const match = decoded.match(
      /([A-Za-z][A-Za-z0-9 ._-]*(?:Mono|Code|Nerd|Powerline|Console|Menlo|Monaco|Courier|Cascadia|Consolas|Hack|Meslo)[A-Za-z0-9 ._-]*)/i,
    );
    return normalizeMacOsFontName(match?.[1]);
  } catch {
    return null;
  }
}

function normalizeColorComponent(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  if (parsed >= 0 && parsed <= 255) {
    return parsed / 255;
  }
  if (parsed >= 0 && parsed <= 65_535) {
    return parsed / 65_535;
  }
  return null;
}

function readColorRecordValue(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) {
      return record[name];
    }
  }
  return undefined;
}

function normalizeMacOsColor(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(trimmed) ||
      /^rgba?\(/i.test(trimmed)
    ) {
      return trimmed;
    }
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const red = normalizeColorComponent(readColorRecordValue(record, ['Red Component', 'red', 'Red']));
  const green = normalizeColorComponent(readColorRecordValue(record, ['Green Component', 'green', 'Green']));
  const blue = normalizeColorComponent(readColorRecordValue(record, ['Blue Component', 'blue', 'Blue']));
  const alpha =
    normalizeColorComponent(
      readColorRecordValue(record, ['Alpha Component', 'alpha', 'Alpha', 'Opacity']),
    ) ?? 1;
  if (red === null || green === null || blue === null) {
    return null;
  }

  const r = Math.round(red * 255);
  const g = Math.round(green * 255);
  const b = Math.round(blue * 255);
  if (alpha < 1) {
    return `rgba(${r}, ${g}, ${b}, ${+alpha.toFixed(3)})`;
  }
  return `#${[r, g, b].map((component) => component.toString(16).padStart(2, '0')).join('')}`;
}

function readThemeColor(
  profile: Record<string, unknown>,
  theme: TerminalThemeProfile,
  themeKey: keyof TerminalThemeProfile,
  profileKeys: readonly string[],
): void {
  for (const profileKey of profileKeys) {
    const color = normalizeMacOsColor(profile[profileKey]);
    if (color) {
      theme[themeKey] = color;
      return;
    }
  }
}

const ANSI_THEME_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

function compactTheme(theme: TerminalThemeProfile): TerminalThemeProfile | undefined {
  return Object.keys(theme).length > 0 ? theme : undefined;
}

function readIterm2Theme(profile: Record<string, unknown>): TerminalThemeProfile | undefined {
  const theme: TerminalThemeProfile = {};
  readThemeColor(profile, theme, 'foreground', ['Foreground Color']);
  readThemeColor(profile, theme, 'background', ['Background Color']);
  readThemeColor(profile, theme, 'cursor', ['Cursor Color']);
  readThemeColor(profile, theme, 'cursorAccent', ['Cursor Text Color']);
  readThemeColor(profile, theme, 'selectionBackground', ['Selection Color']);

  ANSI_THEME_KEYS.forEach((themeKey, index) => {
    readThemeColor(profile, theme, themeKey, [`Ansi ${index} Color`, `ANSI ${index} Color`]);
  });
  return compactTheme(theme);
}

function readMacOsTerminalTheme(
  profile: Record<string, unknown>,
): TerminalThemeProfile | undefined {
  const theme: TerminalThemeProfile = {};
  readThemeColor(profile, theme, 'foreground', ['TextColor']);
  readThemeColor(profile, theme, 'background', ['BackgroundColor']);
  readThemeColor(profile, theme, 'cursor', ['CursorColor']);
  readThemeColor(profile, theme, 'selectionBackground', ['SelectionColor']);
  const terminalAnsiNames = [
    'ANSIBlackColor',
    'ANSIRedColor',
    'ANSIGreenColor',
    'ANSIYellowColor',
    'ANSIBlueColor',
    'ANSIMagentaColor',
    'ANSICyanColor',
    'ANSIWhiteColor',
    'ANSIBrightBlackColor',
    'ANSIBrightRedColor',
    'ANSIBrightGreenColor',
    'ANSIBrightYellowColor',
    'ANSIBrightBlueColor',
    'ANSIBrightMagentaColor',
    'ANSIBrightCyanColor',
    'ANSIBrightWhiteColor',
  ] as const;
  ANSI_THEME_KEYS.forEach((themeKey, index) => {
    const terminalAnsiName = terminalAnsiNames[index];
    if (terminalAnsiName) {
      readThemeColor(profile, theme, themeKey, [terminalAnsiName]);
    }
  });
  return compactTheme(theme);
}

function hasDetectedProfile(profile: TerminalDetectedProfile): boolean {
  return Boolean(profile.fontFamily || profile.fontSize || profile.theme);
}

function detectIterm2Profile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const plist = readMacOsPlistFile(
    join(homeDir, 'Library', 'Preferences', 'com.googlecode.iterm2.plist'),
  );
  const profiles = Array.isArray(plist?.['New Bookmarks'])
    ? (plist['New Bookmarks'] as unknown[])
    : [];
  const defaultProfile = profiles.find(
    (profile) =>
      typeof profile === 'object' &&
      profile !== null &&
      !Array.isArray(profile) &&
      (profile as Record<string, unknown>)['Default Bookmark'] === true,
  );
  const orderedProfiles = defaultProfile
    ? [defaultProfile, ...profiles.filter((profile) => profile !== defaultProfile)]
    : profiles;

  for (const profile of orderedProfiles) {
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      continue;
    }
    const profileObject = profile as Record<string, unknown>;
    const detectedProfile = {
      ...readMacOsFontDescriptor(profileObject['Normal Font']),
      theme: readIterm2Theme(profileObject),
    } satisfies TerminalDetectedProfile;
    if (hasDetectedProfile(detectedProfile)) {
      return detectedProfile;
    }
  }

  return null;
}

function detectMacOsTerminalProfile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const plist = readMacOsPlistFile(
    join(homeDir, 'Library', 'Preferences', 'com.apple.Terminal.plist'),
  );
  const settingsNames = [
    readNestedString(plist, ['Startup Window Settings']),
    readNestedString(plist, ['Default Window Settings']),
  ].filter((name): name is string => Boolean(name));

  for (const settingsName of settingsNames) {
    const settings = plist?.[settingsName];
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      continue;
    }

    const settingsObject = settings as Record<string, unknown>;
    const fontFamily =
      readNestedString(settingsObject, ['FontName']) ??
      normalizeMacOsFontName(readNestedString(settingsObject, ['Font'])) ??
      readMacOsArchivedFontName(settingsObject.Font);
    const detectedProfile = {
      fontFamily: fontFamily ?? undefined,
      fontSize:
        normalizeFontSize(settingsObject.FontSize) ??
        readMacOsFontDescriptor(settingsObject.Font).fontSize,
      theme: readMacOsTerminalTheme(settingsObject),
    } satisfies TerminalDetectedProfile;
    if (hasDetectedProfile(detectedProfile)) {
      return detectedProfile;
    }
  }

  return null;
}

function createMacOsTerminalProfileDetectors(): readonly TerminalProfileDetector[] {
  return [
    { id: 'iterm2', platforms: ['darwin'], detect: detectIterm2Profile },
    { id: 'macos-terminal', platforms: ['darwin'], detect: detectMacOsTerminalProfile },
  ];
}

const TERMINAL_FONT_DETECTORS: readonly TerminalFontDetector[] = [
  { id: 'windows-terminal', platforms: ['win32'], detect: detectWindowsTerminalFontFamily },
  { id: 'vscode', detect: detectVsCodeTerminalFontFamily },
  ...createMacOsTerminalProfileDetectors(),
  { id: 'kitty', platforms: ['darwin', 'linux', 'freebsd', 'openbsd'], detect: detectKittyFontFamily },
  { id: 'alacritty', platforms: ['darwin', 'linux', 'freebsd', 'openbsd'], detect: detectAlacrittyFontFamily },
];

function detectSystemTerminalProfile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  for (const detector of TERMINAL_FONT_DETECTORS) {
    if (detector.platforms && !detector.platforms.includes(process.platform)) {
      continue;
    }
    const profile = normalizeDetectedProfile(detector.detect(env));
    if (profile) {
      return profile;
    }
  }

  return null;
}

export function resolveTerminalFontProfile(input: TerminalFontProfileInput): TerminalFontProfile {
  const env = input.env ?? process.env;
  const customFontFamily = normalizeFontFamily(input.settings.terminalFontFamily);
  const detectedProfile =
    input.settings.terminalInheritSystemProfile !== false ? detectSystemTerminalProfile(env) : null;
  if (customFontFamily) {
    return {
      fontFamily: dedupeFontFamilyStack(customFontFamily),
      fontSize: detectedProfile?.fontSize,
      theme: detectedProfile?.theme,
      source: 'custom',
    };
  }

  if (detectedProfile) {
    return {
      fontFamily: dedupeFontFamilyStack(detectedProfile.fontFamily ?? FONT_FAMILY_FALLBACKS[0]),
      fontSize: detectedProfile.fontSize,
      theme: detectedProfile.theme,
      source: 'system',
    };
  }

  return {
    fontFamily: FONT_FAMILY_FALLBACKS.join(', '),
    source: 'fallback',
  };
}
