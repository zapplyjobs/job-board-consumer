#!/usr/bin/env node
/**
 * Reads new_jobs.json (written by index.js), filters by active window,
 * writes current_jobs.json for Discord poster + count monitoring.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config-loader');

const dataDir = path.join(process.cwd(), '.github', 'data');
const newJobsPath = path.join(dataDir, 'new_jobs.json');
const outputPath = path.join(dataDir, 'current_jobs.json');
const ACTIVE_WINDOW_DAYS = config.activeWindowDays || 14;
const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function isJobActive(job) {
  const postedDate = new Date(job.job_posted_at_datetime_utc || job.job_posted_at || job.postedAt || null);
  if (isNaN(postedDate.getTime())) return true;
  return (Date.now() - postedDate.getTime()) < ACTIVE_WINDOW_MS;
}

try {
  if (!fs.existsSync(newJobsPath)) {
    console.log('⚠️  No new_jobs.json — writing empty current_jobs.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(outputPath, '[]', 'utf8');
    process.exit(0);
  }
  const jobs = JSON.parse(fs.readFileSync(newJobsPath, 'utf8'));
  const activeJobs = jobs.filter(isJobActive);
  fs.writeFileSync(outputPath, JSON.stringify(activeJobs, null, 2), 'utf8');
  console.log(`✅ Wrote ${activeJobs.length} active jobs to current_jobs.json (from ${jobs.length} total)`);
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
