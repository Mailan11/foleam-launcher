'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const SECRET_FIELDS = ['accessToken', 'refreshToken', 'clientToken'];

function createAccountStore(file, safeStorage) {
    function available() {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно. Аккаунты не изменены.');
    }
    function write(accounts) {
        if (!Array.isArray(accounts)) throw new Error('Некорректный список аккаунтов.');
        const encoded = accounts.map(account => {
            const result = { ...account };
            for (const key of SECRET_FIELDS) {
                if (typeof result[key] === 'string' && result[key]) {
                    available();
                    result[key] = { protection: 'electron-safe-storage-v1', value: safeStorage.encryptString(result[key]).toString('base64') };
                }
            }
            return result;
        });
        const temp = file + '.' + randomUUID() + '.tmp';
        try {
            fs.writeFileSync(temp, JSON.stringify(encoded, null, 2), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, file);
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    function read() {
        if (!fs.existsSync(file)) return [];
        const accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(accounts)) throw new Error('Не удалось прочитать аккаунты. Файл сохранён без изменений.');
        let migrate = false;
        const decoded = accounts.map(account => {
            const result = { ...account };
            for (const key of SECRET_FIELDS) {
                const value = result[key];
                if (typeof value === 'string' && value) migrate = true;
                else if (value && typeof value === 'object') {
                    available();
                    if (value.protection !== 'electron-safe-storage-v1' || typeof value.value !== 'string') throw new Error('Неизвестный формат защищённого аккаунта.');
                    try { result[key] = safeStorage.decryptString(Buffer.from(value.value, 'base64')); }
                    catch (_) { throw new Error('Windows не смогла расшифровать аккаунт. Файл сохранён без изменений.'); }
                }
            }
            return result;
        });
        // Replace legacy plaintext only after every account has been read successfully.
        if (migrate) write(decoded);
        return decoded;
    }
    return { read, write };
}
module.exports = { createAccountStore };
