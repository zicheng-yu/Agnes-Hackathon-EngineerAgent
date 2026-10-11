#!/usr/bin/env node
// Keep one dependency restoration path across Windows, macOS and Linux.
import { setupLocal } from '../../scripts/setup-local.mjs';
await setupLocal({ install: !process.argv.includes('--check') });
