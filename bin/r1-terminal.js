#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
execSync('npm install --silent', { cwd: root, stdio: 'inherit' });

require('../backend/server.js');
