function assertWindowSender(event, windows) {
  if (!windows.some((window) => window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame)) {
    throw new Error('Untrusted window');
  }
}
module.exports = { assertWindowSender };
