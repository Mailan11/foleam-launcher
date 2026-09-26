'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
function replaceOnce(text, from, to) {
    if (text.split(from).length !== 2) throw new Error('NSIS template changed; review installer customization before building.');
    return text.replace(from, to);
}
function prepare() {
    const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
    const file = path.join(templates, 'include/installer.nsh');
    const original = fs.readFileSync(file, 'utf8');
    const from = '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
    const marker = '; Foleam uses its own user-confirmed updater; no duplicate installer cache.';
    // Patch only this dependency template; keep builder's standard uninstaller generation.
    if (!original.includes(from) && original.split(marker).length === 2) return true;
    if (original.includes(marker)) throw new Error('Ambiguous NSIS cache customization.');
    fs.writeFileSync(file, replaceOnce(original, from, marker));
    // electron-builder requires true here to retain normal dependency collection/rebuild.
    return true;
}
module.exports = prepare;
module.exports.replaceOnce = replaceOnce;
if (require.main === module) prepare();
