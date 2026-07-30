#!/usr/bin/env node

import { main } from '../src/app.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`[docker-remote] ${error.message}`);
    process.exitCode = typeof error.exitCode === 'number' ? error.exitCode : 1;
  },
);
