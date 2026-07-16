const fs = require('fs');
const path = require('path');
const { filesRoot } = require('../services/fileCompiler');
const { fileRetentionHours } = require('../config/env');

// 160GB is plenty of headroom for text/PDF/Excel reports, but nothing here expires on its own -
// without this, generated files just accumulate forever. Runs on a plain interval rather than a
// system cron entry since the service is already a long-running PM2 process.
function sweepOldFiles() {
  const cutoff = Date.now() - fileRetentionHours * 60 * 60 * 1000;
  let files;
  try {
    files = fs.readdirSync(filesRoot);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(filesRoot, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[cleanup] failed to check/remove ${file}:`, err.message);
    }
  }
}

function startCleanupSweep() {
  sweepOldFiles();
  setInterval(sweepOldFiles, 60 * 60 * 1000);
}

module.exports = { startCleanupSweep, sweepOldFiles };
