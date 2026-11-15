'use strict';

const path = require('node:path');
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: [path.resolve(__dirname, '../js/auth-client-entry.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  nodePaths: [path.join(__dirname, 'node_modules')],
  outfile: path.resolve(__dirname, '../js/auth-client.bundle.js')
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
