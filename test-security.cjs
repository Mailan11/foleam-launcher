'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAccountStore } = require('./account-store');
const { externalUrl } = require('./external-url');
const { createGuardedIpc } = require('./ipc-guard');
const handlers = {}, listeners = {};
const wc = { mainFrame: {} };
let win = { webContents: wc, isDestroyed: () => false };
const ipc = createGuardedIpc({handle:(c,f)=>handlers[c]=f,on:(c,f)=>listeners[c]=f},()=>win);
ipc.handle('test', (_e, value) => value);
let received = 0;
ipc.on('test', () => received++);
const trusted = {sender:wc,senderFrame:wc.mainFrame};
assert.equal(handlers.test(trusted, 42), 42);
for (const event of [{sender:{},senderFrame:wc.mainFrame},{sender:wc,senderFrame:{}},{}]) {
    assert.throws(() => handlers.test(event));
    listeners.test(event);
}
assert.equal(received, 0);
listeners.test(trusted);assert.equal(received, 1);
win = null;assert.throws(() => handlers.test(trusted));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert(html.includes("script-src 'self';"));
assert(html.includes("object-src 'none'; frame-src 'none'"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foleam-security-'));
const file = path.join(root, 'accounts.json');
const key = crypto.randomBytes(32);
const storage = {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]); },
    decryptString(bytes) { const d = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString(); }
};
const original = [{ name: 'TestUser', type: 'licensed', accessToken: 'test-access-secret', refreshToken: 'test-refresh-secret' }, { name: 'Player', type: 'offline' }];
fs.writeFileSync(file, JSON.stringify(original));
const store = createAccountStore(file, storage);
assert.deepEqual(store.read(), original);
assert(!fs.readFileSync(file, 'utf8').includes('test-access-secret'));
assert(!fs.readFileSync(file, 'utf8').includes('test-refresh-secret'));
assert.deepEqual(store.read(), original);
store.write(original);
assert.deepEqual(store.read(), original);
const before = fs.readFileSync(file);
const unavailable = createAccountStore(file, { isEncryptionAvailable: () => false });
assert.throws(() => unavailable.read());
assert.throws(() => unavailable.write(original));
assert.deepEqual(fs.readFileSync(file), before);
assert.throws(() => createAccountStore(file, { ...storage, decryptString() { throw Error('different user'); } }).read());
assert.deepEqual(fs.readFileSync(file), before);
assert.equal(externalUrl('https://modrinth.com/mod/test'), 'https://modrinth.com/mod/test');
for (const url of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'powershell:test', 'ms-settings:test', 'https://user:password@example.com', null]) assert.throws(() => externalUrl(url));
const pkg = require('./package.json');
assert.equal(pkg.build.nsis.packElevateHelper, false);
assert.equal(pkg.build.nsis.allowElevation, false);
console.log('PASS: migration, encryption, roundtrip, fail-closed storage, URL validation, installer configuration');
