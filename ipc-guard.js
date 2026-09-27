'use strict';
function createGuardedIpc(ipcMain, window) {
    const trusted = event => {
        const win = window();
        return !!win && !win.isDestroyed() && event.sender === win.webContents &&
            event.senderFrame === win.webContents.mainFrame;
    };
    return {
        handle(channel, handler) {
            ipcMain.handle(channel, (event, ...args) => {
                if (!trusted(event)) throw Error('Untrusted IPC sender');
                return handler(event, ...args);
            });
        },
        on(channel, handler) {
            ipcMain.on(channel, (event, ...args) => {
                if (trusted(event)) handler(event, ...args);
            });
        }
    };
}
module.exports = { createGuardedIpc };
