// Single source of truth for the version shown in the corner tab.
// No package.json/build step in this project (§3) to derive it from:
// bump this by hand alongside CLAUDE.md's semver rules (v0.x.x: feat/fix
// bump PATCH, a breaking change bumps MINOR, never auto-bump to 1.0.0).
export const VERSION = '0.7.0';

export const GITHUB_ISSUES_URL = 'https://github.com/xanderstagwood/sprite/issues/new?template=bug_report.yml';
export const ITCH_IO_URL = 'https://xanderstagwood.itch.io/sprite';
export const KOFI_URL = 'https://ko-fi.com/xanderstagwood';
export const DISCORD_URL = 'https://discord.gg/TFvXQdrjYM';
