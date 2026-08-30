import { createRequire } from 'node:module';
import path from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const require = createRequire(import.meta.url);
const { registerPiExtension } = require('../src/adapters/pi-extension.cjs');

export default function stopThatShitPiExtension(pi: ExtensionAPI) {
  registerPiExtension(pi, {
    dataDir: path.join(getAgentDir(), 'stop-that-shit')
  });
}
