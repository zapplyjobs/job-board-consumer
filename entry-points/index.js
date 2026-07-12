#!/usr/bin/env node
/**
 * Main job fetcher entry point (for US repos with aggregator dispatch).
 * Fetches jobs from the aggregator consumer, saves intermediate files, generates README.
 */
const fs = require('fs');
const path = require('path');
const { createAggregatorConsumer } = require('../lib/aggregator-consumer');
const { updateReadme } = require('./readme-generator');
const { config } = require('./config-loader');

const dataDir = path.join(process.cwd(), '.github', 'data');

async function main() {
  try {
    console.log('🚀 Starting job fetching system...');
    const consumer = createAggregatorConsumer({
      filters: config.filters,
      verbose: true
    });

    const { jobs, diagnostics } = await consumer.fetchJobsWithDiagnostics();

    if (jobs.length === 0) {
      console.log('⚠️  No jobs fetched from aggregator');
    }

    console.log(`\n✅ Fetched ${jobs.length} jobs from aggregator`);

    const currentJobs = jobs.map(job => ({
      ...job,
      job_posted_at: job.job_posted_at_datetime_utc || job.job_posted_at || null
    }));

    const stats = { totalByCompany: {} };
    currentJobs.forEach(job => {
      stats.totalByCompany[job.employer_name] = (stats.totalByCompany[job.employer_name] || 0) + 1;
    });

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'new_jobs.json'), JSON.stringify(currentJobs, null, 2), 'utf8');
    console.log(`💾 Saved ${currentJobs.length} jobs to new_jobs.json`);

    const runMetrics = {
      timestamp: new Date().toISOString(),
      all_jobs_version: process.env.ALL_JOBS_SHA || null,
      ...diagnostics
    };
    fs.writeFileSync(path.join(dataDir, 'run_metrics.json'), JSON.stringify(runMetrics, null, 2), 'utf8');

    await updateReadme(currentJobs, [], null, stats);

    console.log(`\n🎉 Done: ${currentJobs.length} jobs, ${Object.keys(stats.totalByCompany).length} companies`);
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { main };
