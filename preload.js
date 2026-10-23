'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('f2l', {
  state: call('state'), add: call('add'), start: call('start'), pause: call('pause'), retry: call('retry'),
  remove: call('remove'), pauseAll: call('pauseAll'), resumeAll: call('resumeAll'), clearCompleted: call('clearCompleted'),
  open: call('open'), reveal: call('reveal'), openFolder: call('openFolder'), fileExists: call('fileExists'),
  setSettings: call('setSettings'), pickFolder: call('pickFolder'), importFile: call('importFile'),
  clipboard: call('clipboard'), addTorrents: call('addTorrents'), pickTorrents: call('pickTorrents'), qbitTest: call('qbitTest'), checkUpdate: call('checkUpdate'), openExternal: call('openExternal'),
  onItems: (cb) => ipcRenderer.on('items', (_e, items) => cb(items))
});
