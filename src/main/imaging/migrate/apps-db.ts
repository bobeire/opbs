import * as fs from 'fs';
import type { AppClass, AppKnowledgeEntry } from './types';

/**
 * Seed app knowledge base for migration (MIGRATE.md §7). Paths are
 * profile-relative with tokens resolved per profile:
 *   `%USERPROFILE%`   → the profile root
 *   `%APPDATA%`       → `%USERPROFILE%/AppData/Roaming`
 *   `%LOCALAPPDATA%`  → `%USERPROFILE%/AppData/Local`
 *
 * Extend via `--apps-db <file>` (JSON array of AppKnowledgeEntry); entries
 * merge over the seed by `id`. Contributions to this seed are welcome — see
 * MIGRATE.md §7 for the schema, validation rules and how to test a file
 * against a real profile (`migrate plan --apps-db my.json`).
 *
 * Invariants (enforced by `validateAppsDbEntries`): kebab-case unique ids,
 * class from the AppClass enum, registry keys under HKCU only (HKLM is never
 * written — MIGRATE.md §8), data paths free of unknown tokens, winget ids of
 * the `Publisher.Package` shape (verified against winget-pkgs before adding).
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
    id: 'brave',
    name: 'Brave Browser',
    data: ['%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data'],
    registry: ['HKCU/Software/BraveSoftware'],
    winget: 'Brave.Brave',
    class: 'data+settings'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    data: ['%LOCALAPPDATA%/Vivaldi/User Data'],
    registry: ['HKCU/Software/Vivaldi'],
    winget: 'Vivaldi.Vivaldi',
    class: 'data+settings'
  },
  {
    id: 'opera',
    name: 'Opera (Stable/GX)',
    data: ['%APPDATA%/Opera Software/Opera Stable', '%APPDATA%/Opera Software/Opera GX Stable'],
    registry: ['HKCU/Software/Opera Software'],
    winget: 'Opera.Opera',
    class: 'data+settings'
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
    winget: 'SlackTechnologies.Slack',
    class: 'data'
  },
  {
    id: 'telegram',
    name: 'Telegram Desktop',
    data: ['%APPDATA%/Telegram Desktop'],
    winget: 'Telegram.TelegramDesktop',
    class: 'data'
  },
  {
    id: 'signal',
    name: 'Signal',
    data: ['%APPDATA%/Signal'],
    winget: 'OpenWhisperSystems.Signal',
    class: 'data'
  },
  {
    id: 'zoom',
    name: 'Zoom Workplace',
    data: ['%APPDATA%/Zoom'],
    winget: 'Zoom.Zoom',
    class: 'data'
  },
  {
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    data: ['%APPDATA%/Microsoft/Teams', '%LOCALAPPDATA%/Packages/MicrosoftTeams_8wekyb3d8bbwe/LocalCache'],
    winget: 'Microsoft.Teams',
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
    id: 'git',
    name: 'Git (user config)',
    data: ['%USERPROFILE%/.gitconfig'],
    winget: 'Git.Git',
    class: 'data'
  },
  {
    id: 'putty',
    name: 'PuTTY (saved sessions)',
    data: [],
    registry: ['HKCU/Software/SimonTatham/PuTTY'],
    winget: 'PuTTY.PuTTY',
    class: 'data+settings'
  },
  {
    id: 'obs-studio',
    name: 'OBS Studio',
    data: ['%APPDATA%/obs-studio'],
    winget: 'OBSProject.OBSStudio',
    class: 'data'
  },
  {
    id: 'vlc',
    name: 'VLC media player',
    data: ['%APPDATA%/vlc'],
    registry: ['HKCU/Software/VLC'],
    winget: 'VideoLAN.VLC',
    class: 'data+settings'
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
    id: 'filezilla',
    name: 'FileZilla (site manager)',
    data: ['%APPDATA%/FileZilla'],
    class: 'data'
  },
  {
    id: 'winrar',
    name: 'WinRAR',
    data: ['%APPDATA%/WinRAR'],
    registry: ['HKCU/Software/WinRAR'],
    winget: 'RARLab.WinRAR',
    class: 'data+settings'
  },
  {
    id: 'everything',
    name: 'Everything (voidtools)',
    data: ['%APPDATA%/Everything'],
    registry: ['HKCU/Software/voidtools'],
    winget: 'voidtools.Everything',
    class: 'data+settings'
  },
  {
    id: 'sharex',
    name: 'ShareX',
    data: ['%APPDATA%/ShareX'],
    winget: 'ShareX.ShareX',
    class: 'data'
  },
  {
    id: 'powertoys',
    name: 'Microsoft PowerToys',
    data: ['%LOCALAPPDATA%/Microsoft/PowerToys'],
    winget: 'Microsoft.PowerToys',
    class: 'data'
  },
  {
    id: 'blender',
    name: 'Blender (user prefs)',
    data: ['%APPDATA%/Blender Foundation'],
    winget: 'BlenderFoundation.Blender',
    class: 'data'
  },
  {
    id: 'gimp',
    name: 'GIMP',
    data: ['%APPDATA%/GIMP'],
    winget: 'GIMP.GIMP',
    class: 'data'
  },
  {
    id: 'notion',
    name: 'Notion',
    data: ['%APPDATA%/Notion'],
    winget: 'Notion.Notion',
    class: 'data'
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    data: ['%APPDATA%/obsidian'],
    winget: 'Obsidian.Obsidian',
    class: 'data'
  },
  {
    id: 'dropbox',
    name: 'Dropbox (local files)',
    data: ['%USERPROFILE%/Dropbox'],
    winget: 'Dropbox.Dropbox',
    class: 'data'
  },
  {
    id: 'bitwarden',
    name: 'Bitwarden Desktop',
    data: ['%APPDATA%/Bitwarden'],
    winget: 'Bitwarden.Bitwarden',
    class: 'data'
  },
  {
    id: '1password',
    name: '1Password',
    data: ['%LOCALAPPDATA%/1Password'],
    winget: 'AgileBits.1Password',
    class: 'data'
  },
  {
    id: 'keepass',
    name: 'KeePass (settings)',
    data: ['%APPDATA%/KeePass'],
    winget: 'DominikReichl.KeePass',
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
    registry: ['HKCU/Software/Valve/Steam'],
    winget: 'Valve.Steam',
    class: 'data+settings'
  },
  {
    id: 'epic-games',
    name: 'Epic Games Launcher',
    data: [],
    winget: 'EpicGames.EpicGamesLauncher',
    class: 'reinstall-only'
  },
  {
    id: 'gog-galaxy',
    name: 'GOG Galaxy',
    data: [],
    winget: 'GOG.Galaxy',
    class: 'reinstall-only'
  },
  {
    id: 'ubisoft-connect',
    name: 'Ubisoft Connect',
    data: [],
    winget: 'Ubisoft.Connect',
    class: 'reinstall-only'
  },
  {
    id: 'ea-app',
    name: 'EA app',
    data: [],
    winget: 'ElectronicArts.EADesktop',
    class: 'reinstall-only'
  },
  {
    id: 'rockstar-launcher',
    name: 'Rockstar Games Launcher',
    data: [],
    winget: 'RockstarGames.Launcher',
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

const APP_CLASSES: readonly AppClass[] = ['data', 'data+settings', 'reinstall-only', 'ignore'];
const KB_TOKENS = new Set(['%USERPROFILE%', '%APPDATA%', '%LOCALAPPDATA%']);

/**
 * Schema validation for knowledge-base entries (seed and `--apps-db` files
 * alike). Throws with a contribution-friendly message naming the offending
 * entry and the file. Enforces the MIGRATE.md §7/§8 invariants:
 * kebab-case unique ids, enum class, HKCU-only registry keys (HKLM is never
 * written), known path tokens, no drive-absolute data paths, winget-shaped
 * package ids.
 */
export function validateAppsDbEntries(entries: AppKnowledgeEntry[], source: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || !entry.name || !Array.isArray(entry.data) || !entry.class) {
      throw new Error(`apps-db entry missing required fields (id, name, data[], class) in ${source}: ${JSON.stringify(entry)}`);
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id)) {
      throw new Error(`apps-db id must be kebab-case (a-z, 0-9, single hyphens): '${entry.id}' in ${source}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`duplicate apps-db id '${entry.id}' in ${source}`);
    }
    seen.add(entry.id);
    if (!APP_CLASSES.includes(entry.class)) {
      throw new Error(`apps-db class must be one of ${APP_CLASSES.join(' | ')}: '${entry.class}' (entry '${entry.id}') in ${source}`);
    }
    for (const key of entry.registry ?? []) {
      if (!/^HKCU[\\/]/i.test(key)) {
        throw new Error(`registry keys must live under HKCU — HKLM is never written (MIGRATE.md §8): '${key}' (entry '${entry.id}') in ${source}`);
      }
    }
    for (const p of entry.data) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`data paths must be non-empty strings (entry '${entry.id}') in ${source}`);
      }
      if (/^[A-Za-z]:/.test(p)) {
        throw new Error(`data paths must be profile-relative with %USERPROFILE%/%APPDATA%/%LOCALAPPDATA% tokens, not drive-absolute: '${p}' (entry '${entry.id}') in ${source}`);
      }
      for (const token of p.match(/%[A-Za-z]+%/g) ?? []) {
        if (!KB_TOKENS.has(token.toUpperCase())) {
          throw new Error(`unknown path token '${token}' in '${p}' (entry '${entry.id}') in ${source} — known tokens: %USERPROFILE%, %APPDATA%, %LOCALAPPDATA%`);
        }
      }
    }
    if (entry.winget !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.[A-Za-z0-9._+-]+$/.test(entry.winget)) {
      throw new Error(`winget id must look like Publisher.Package (verify with 'winget show --id <id>'): '${entry.winget}' (entry '${entry.id}') in ${source}`);
    }
  }
}

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
  validateAppsDbEntries(SEED_APPS_DB, 'seed knowledge base');
  if (!extraPath) return SEED_APPS_DB.slice();
  const raw = JSON.parse(fs.readFileSync(extraPath, 'utf8')) as AppKnowledgeEntry[];
  if (!Array.isArray(raw)) throw new Error(`apps-db file must be a JSON array: ${extraPath}`);
  validateAppsDbEntries(raw, extraPath);
  const byId = new Map<string, AppKnowledgeEntry>();
  for (const entry of [...SEED_APPS_DB, ...raw]) byId.set(entry.id, entry);
  return [...byId.values()];
}
