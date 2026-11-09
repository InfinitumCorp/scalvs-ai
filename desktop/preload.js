// Runs in the page with no Node access (sandbox). It only tells the site it is
// inside the desktop app, so the site can hide its own "Install app" button.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('scalvsDesktop', { platform: process.platform, version: '1.0.0' });
