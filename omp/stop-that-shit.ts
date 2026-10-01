import { createRequire } from 'node:module';
import path from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';

const require = createRequire(import.meta.url);
const { registerOmpExtension } = require('../src/adapters/omp-extension.cjs');

export default function stopThatShitOmpExtension(pi: ExtensionAPI) {
  registerOmpExtension(pi, { dataDir: path.join(pi.pi.getAgentDir(), 'stop-that-shit') });
}
