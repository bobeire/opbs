import * as fs from 'fs';
import type { AppKnowledgeEntry } from './types';

/**
 * Seed app knowledge base for the migration spike. Paths are profile-relative
 * with tokens resolved per profile:
 *   `%USERPROFILE%`   → the profile root
 *   `%APPDATA%`       → `%USERPROFILE%/AppData/Roaming`
 *   `%LOCALAPPDATA%`  → `%USERPROFILE%/AppData/Local`
 *
 * Extend via `--apps-db <file>` (JSON array of AppKnowledgeEntry) once the
 * spike hardens; this seed targets the high-traffic consumer apps.
 */
export const SEED_APPS_DB: AppKnowledgeEntry[] = [
  {
    id: 'google-chrome',
    name: 'Google Chrome',
    data: ['%LOCALAPPDATA%/Google/Chrome/User Data'],
    registry: ['HKCU/Software/Google/Chrome'],
    winget: 'Google.Chrome',
    class: 'data+settings'
  },
  {
    id: 'microsoft-edge',
    name: 'Microsoft Edge',
    data: ['%LOCALAPPDATA%/Microsoft/Edge/User Data'],
    winget: 'Microsoft.Edge',
    class: 'data'
  },
  {
    id: 'firefox',
    name: 'Mozilla Firefox',
    data: ['%APPDATA%/Mozilla/Firefox/Profiles', '%LOCALAPPDATA%/Mozilla/Firefox/Profiles'],
    registry: ['HKCU/Software/Mozilla/Firefox'],
    winget: 'Mozilla.Firefox',
    class: 'data+settings'
  },
  {
    id: 'thunderbird',
    name: 'Mozilla Thunderbird',
    data: ['%APPDATA%/Thunderbird'],
    registry: ['HKCU/Software/Mozilla/Thunderbird'],
    winget: 'Mozilla.Thunderbird',
    class: 'data+settings'
  },
  {
    id: 'outlook',
    name: 'Microsoft Outlook (data)',
    data: ['%LOCALAPPDATA%/Microsoft/Outlook', '%USERPROFILE%/Documents/Outlook Files'],
    winget: 'Microsoft.Office',
    class: 'data'
  },
  {
    id: 'discord',
    name: 'Discord',
    data: ['%APPDATA%/discord'],
    winget: 'Discord.Discord',
    class: 'data'
  },
  {
    id: 'slack',
    name: 'Slack',
    data: ['%APPDATA%/Slack'],
    winget: 'Slack.Slack',
    class: 'data'
  },
  {
    id: 'telegram',
    name: 'Telegram Desktop',
    data: ['%APPDATA%/Telegram Desktop'],
    class: 'data'
  },
  {
    id: 'signal',
    name: 'Signal',
    data: ['%APPDATA%/Signal'],
    class: 'data'
  },
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    data: ['%APPDATA%/Code/User', '%APPDATA%/Code - Insiders/User'],
    registry: ['HKCU/Software/Microsoft/VSCode'],
    winget: 'Microsoft.VisualStudioCode',
    class: 'data+settings'
  },
  {
    id: 'windows-terminal',
    name: 'Windows Terminal',
    data: ['%LOCALAPPDATA%/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState'],
    winget: 'Microsoft.WindowsTerminal',
    class: 'data'
  },
  {
    id: 'obs-studio',
    name: 'OBS Studio',
    data: ['%APPDATA%/obs-studio'],
    winget: 'OBSProject.OBSStudio',
    class: 'data'
  },
  {
    id: 'notepadpp',
    name: 'Notepad++',
    data: ['%APPDATA%/Notepad++'],
    winget: 'Notepad++.Notepad++',
    class: 'data'
  },
  {
    id: 'qbittorrent',
    name: 'qBittorrent',
    data: ['%APPDATA%/qBittorrent'],
    winget: 'qBittorrent.qBittorrent',
    class: 'data'
  },
  {
    id: 'spotify',
    name: 'Spotify',
    data: ['%LOCALAPPDATA%/Spotify'],
    winget: 'Spotify.Spotify',
    class: 'data'
  },
  {
    id: 'steam',
    name: 'Steam (saves only)',
    data: ['%LOCALAPPDATA%/Steam/userdata'],
    winget: 'Valve.Steam',
    class: 'data'
  },
  {
    id: 'epic-games',
    name: 'Epic Games Launcher',
    data: [],
    winget: 'EpicGames.EpicGamesLauncher',
    class: 'reinstall-only'
  },
  {
    id: 'sevenzip',
    name: '7-Zip',
    data: [],
    winget: '7zip.7zip',
    class: 'reinstall-only'
  }
];

/** Resolves a KB `data` path token string against a profile root (`/`-separated). */
export function resolveKbPath(template: string, profileRelPath: string): string {
  return template
    .replace(/%USERPROFILE%/gi, profileRelPath)
    .replace(/%APPDATA%/gi, `${profileRelPath}/AppData/Roaming`)
    .replace(/%LOCALAPPDATA%/gi, `${profileRelPath}/AppData/Local`)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

/** Loads the seed DB plus an optional user-supplied JSON file (array of entries). */
export function loadAppsDb(extraPath?: string): AppKnowledgeEntry[] {
  if (!extraPath) return SEED_APPS_DB.slice();
  const raw = JSON.parse(fs.readFileSync(extraPath, 'utf8')) as AppKnowledgeEntry[];
  if (!Array.isArray(raw)) throw new Error(`apps-db file must be a JSON array: ${extraPath}`);
  for (const entry of raw) {
    if (!entry.id || !entry.name || !Array.isArray(entry.data) || !entry.class) {
      throw new Error(`apps-db entry missing required fields (id, name, data[], class): ${JSON.stringify(entry)}`);
    }
  }
  const byId = new Map<string, AppKnowledgeEntry>();
  for (const entry of [...SEED_APPS_DB, ...raw]) byId.set(entry.id, entry);
  return [...byId.values()];
}
