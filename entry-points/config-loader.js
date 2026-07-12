/**
 * config-loader.js — resolves consumer config across different repo structures.
 * US repos store config at config/config.js; Canada repos at .github/scripts/job-fetcher/config.js.
 * This loader tries both so all entry-points scripts work regardless of repo type.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATHS = [
  path.join(process.cwd(), 'config', 'config.js'),
  path.join(process.cwd(), '.github', 'scripts', 'job-fetcher', 'config.js'),
];

const configPath = CONFIG_PATHS.find(p => fs.existsSync(p));
if (!configPath) {
  throw new Error('config.js not found. Checked: ' + CONFIG_PATHS.join(', '));
}

const configDir = path.dirname(configPath);

function loadSibling(filename) {
  const p = path.join(configDir, filename);
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  config: require(configPath),
  configDir,
  loadSibling,
};
