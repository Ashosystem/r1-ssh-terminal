#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

if (!fs.existsSync(path.join(root, 'node_modules', 'ssh2'))) {
  console.log('Installing dependencies...');
  execSync('npm install', { cwd: root, stdio: 'inherit' });
}

require('../backend/server.js');
