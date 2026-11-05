/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports */
// A bare window for rendering our own HTML (the demo page, the social preview, the reel), reached over CDP.
// Offscreen, with the page's size emulated over CDP: an ordinary hidden window doesn't paint, or wraps at its old size.
const { app, BrowserWindow } = require('electron')

const [file, width, height] = process.argv.slice(-3)
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: Number(width), height: Number(height), webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  win.webContents.setFrameRate(60)
  void win.loadFile(file)
})
app.on('window-all-closed', () => app.quit())
