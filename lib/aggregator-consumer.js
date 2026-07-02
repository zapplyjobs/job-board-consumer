#!/usr/bin/env node

/**
 * Aggregator Consumer - Shared Library
 *
 * Fetches jobs from the centralized jobs-aggregator-private repository.
 * Production path is R2-only. Raw GitHub HTTPS is no longer an automatic fallback
 * because it drifts by design once consumers stop committing current_jobs.json.
 * An explicit URL override still exists for narrow manual/debug use.
 *
 * Architecture:
 * - Single centralized aggregator (jobs-aggregator-private)
 * - All repos consume from aggregator
 * - Aggregator handles JSearch + ATS + senior filtering + deduplication
 * - Repos apply domain-specific filters
 */

const https = require('https');

// Legacy HTTPS URLs retained only for explicit manual/debug override paths.
// Do not use as automatic production fallback.
const AGGREGATOR_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/all_jobs.json';
const METADATA_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/jobs-metadata.json';
const ENRICHED_URL = 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/enriched_jobs.json';

// R2 keys (data/ prefix matches aggregator upload path)
const R2_KEY_ALL_JOBS = 'data/all_jobs.json';
const R2_KEY_METADATA = 'data/jobs-metadata.json';
const R2_KEY_ENRICHED = 'data/enriched_jobs.json';
// R2 key for the link-checker's confirmed-dead list (shape: { checked_at, dead: [{ id, ... }] }).
const R2_KEY_DEAD_JOBS = 'data/stale-job-candidates.json';

function isR2Configured() {
  return !!(process.env.R2_BUCKET_NAME && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT);
}

function allowLegacyHttpsFallback() {
  return process.env.ALLOW_STALE_HTTPS_FALLBACK === '1';
}

function fallbackDisabledError(label, reason) {
  return new Error(`${label}: ${reason}. R2 is required; automatic raw GitHub fallback is disabled.`);
}

/**
 * Send a Discord alert when legacy HTTPS fallback is explicitly used.
 * Silent if DISCORD_TEAM_TOKEN or DISCORD_ALERT_CHANNEL_ID not set.
 */
function alertR2Fallback(reason, label) {
  const repo = process.env.GITHUB_REPOSITORY || 'unknown';
  const runUrl = process.env.GITHUB_SERVER_URL
    ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : 'unknown';
  const msg = `⚠️ **Legacy HTTPS Fallback In Use** — ${repo}\n${label}: ${reason}\nData served from deprecated raw GitHub path.\n${runUrl !== 'unknown' ? `[View run](${runUrl})` : ''}`;

  const token = process.env.DISCORD_TEAM_TOKEN;
  const channelId = process.env.DISCORD_ALERT_CHANNEL_ID;
  if (!token || !channelId) {
    console.warn(`   [ALERT SUPPRESSED] Discord secrets not set. Legacy HTTPS fallback: ${label} - ${reason}`);
    return;
  }

  const body = JSON.stringify({ content: msg });
  const req = https.request({
    hostname: 'discord.com',
    path: `/api/v10/channels/${channelId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, res => {
    if (res.statusCode >= 400) {
      console.warn(`   [ALERT FAILED] Discord returned ${res.statusCode}`);
    }
  });
  req.on('error', e => console.warn(`   [ALERT FAILED] ${e.message}`));
  req.write(body);
  req.end();
}

let _r2ClientCache = null;

function getR2Client() {
  if (!isR2Configured()) return null;
  if (_r2ClientCache) return _r2ClientCache;
  try {
    const { createR2Client } = require('./storage/r2-client');
    _r2ClientCache = createR2Client();
    return _r2ClientCache;
  } catch (err) {
    console.error(`   R2 client init failed: ${err.message}.`);
    return null;
  }
}

/**
 * Download and parse JSONL from R2. Optional HTTPS path is explicit/manual only.
 * R2 is the required production source.
 */
async function fetchJsonlFromSource(options = {}) {
  const { r2Key, httpsUrl, label } = options;

  // Explicit HTTPS override — manual/debug only
  if (httpsUrl) {
    const reason = `${label} explicit HTTPS override`;
    console.warn(`   HTTPS override: ${reason}`);
    if (allowLegacyHttpsFallback()) {
      alertR2Fallback(reason, label);
    }
    const url = `${httpsUrl}${httpsUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Zapply-JobBoard' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const lines = data.trim().split('\n').filter(line => line);
            const jobs = lines.map(line => {
              try { return JSON.parse(line); }
              catch { return null; }
            }).filter(job => job !== null);
            resolve(jobs);
          } catch (error) {
            reject(new Error(`Failed to parse JSONL: ${error.message}`));
          }
        });
      }).on('error', reject);
    });
  }

  if (!isR2Configured()) {
    throw fallbackDisabledError(label, 'R2 environment variables are missing');
  }

  const r2 = getR2Client();
  if (!r2) {
    throw fallbackDisabledError(label, 'R2 client initialization failed');
  }

  try {
    const raw = await r2.downloadRaw(r2Key);
    if (!raw) {
      throw fallbackDisabledError(label, `${label} not found in R2 bucket`);
    }
    const text = Buffer.from(raw).toString('utf8');
    const lines = text.trim().split('\n').filter(l => l);
    const items = lines.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(item => item !== null);
    console.log(`   R2: ${label} loaded (${items.length} items)`);
    return items;
  } catch (err) {
    throw fallbackDisabledError(label, err.message);
  }
}

/**
 * Fetch jobs from aggregator (R2 or HTTPS).
 */
async function fetchJobsFromAggregator(options = {}) {
  if (options.url) {
    // Explicit URL override — manual/debug only
    return fetchJsonlFromSource({ httpsUrl: options.url, label: 'all_jobs.json' });
  }
  return fetchJsonlFromSource({
    r2Key: R2_KEY_ALL_JOBS,
    label: 'all_jobs.json'
  });
}

/**
 * Fetch metadata from aggregator (R2 or HTTPS).
 */
async function fetchMetadata(options = {}) {
  if (options.url) {
    const url = `${options.url}${options.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Zapply-JobBoard' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (error) { reject(new Error(`Failed to parse metadata: ${error.message}`)); }
        });
      }).on('error', reject);
    });
  }
  if (!isR2Configured()) {
    throw fallbackDisabledError('metadata', 'R2 environment variables are missing');
  }
  const r2 = getR2Client();
  if (!r2) {
    throw fallbackDisabledError('metadata', 'R2 client initialization failed');
  }
  try {
    const data = await r2.downloadJson(R2_KEY_METADATA);
    if (data) return data;
    throw fallbackDisabledError('metadata', 'metadata not found in R2 bucket');
  } catch (err) {
    throw fallbackDisabledError('metadata', err.message);
  }
}

/**
 * Fetch enriched jobs data and merge into job array by ID.
 * Silent on failure — returns jobs unchanged if enriched_jobs.json unavailable.
 */
async function mergeEnrichmentData(jobs) {
  try {
    if (!isR2Configured()) {
      console.log(`   ⚠️ Enrichment merge skipped: R2 environment variables are missing`);
      return jobs;
    }
    const r2 = getR2Client();
    if (!r2) {
      console.log(`   ⚠️ Enrichment merge skipped: R2 client initialization failed`);
      return jobs;
    }
    const raw = await r2.downloadRaw(R2_KEY_ENRICHED);
    if (!raw) {
      console.log(`   ⚠️ Enrichment merge skipped: enriched_jobs not found in R2`);
      return jobs;
    }
    const text = Buffer.from(raw).toString('utf8');
    const lines = text.trim().split('\n').filter(l => l);
    const enrichedRaw = lines.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(item => item !== null);
    console.log(`   R2: enriched_jobs loaded (${enrichedRaw.length} items)`);
    if (!Array.isArray(enrichedRaw) || enrichedRaw.length === 0) {
      console.log(`   ⚠️ Enrichment data empty or invalid — visa column will be blank for all ${jobs.length} jobs`);
      return jobs;
    }
    const enrichedMap = new Map();
    for (const ej of enrichedRaw) {
      enrichedMap.set(ej.id, ej);
    }
    let merged = 0;
    for (const job of jobs) {
      const enriched = enrichedMap.get(job.id) || enrichedMap.get(job.job_id);
      if (enriched) {
        job.enrichment = {
          required_skills: enriched.required_skills || [],
          nice_to_have_skills: enriched.nice_to_have_skills || [],
          sponsors_visa: enriched.sponsors_visa,
          possible_sponsor: enriched.possible_sponsor,
          visa_question_present: enriched.visa_question_present || false,
          is_simple_apply: enriched.is_simple_apply || false,
          is_remote: enriched.is_remote || false,
          has_description: enriched.has_description || false,
          min_degree: enriched.min_degree,
          experience_level_from_desc: enriched.experience_level_from_desc,
          question_count: enriched.question_count,
        };
        merged++;
      }
    }
    const pct = merged / jobs.length * 100;
    console.log(`   📊 Enrichment merged: ${merged}/${jobs.length} jobs (${pct.toFixed(0)}%)`);
    if (pct < 10 && jobs.length > 100) {
      console.log(`   ⚠️ Enrichment merge rate ${pct.toFixed(1)}% is critically low — enriched_jobs.json may be stale or malformed`);
    }
    return jobs;
  } catch (err) {
    console.log(`   ⚠️ Enrichment merge failed: ${err.message} — visa column will be blank for all ${jobs.length} jobs`);
    return jobs;
  }
}

function filterByTags(jobs, filters = {}) {
  if (!Array.isArray(jobs)) {
    console.warn('filterByTags: jobs is not an array');
    return [];
  }
  return jobs.filter(job => {
    // Lifecycle gate (mirrors sjd): exclude dead / stale-candidate jobs everywhere.
    // Missing lifecycle_state is treated as active so legacy rows still show.
    const lifecycle = job.tags?.lifecycle_state;
    if (lifecycle === 'dead' || lifecycle === 'stale-candidate') return false;
    if (!job.tags && Object.keys(filters).length > 0) return false;
    if (filters.employment && job.tags?.employment !== filters.employment) return false;
    if (filters.domains && filters.domains.length > 0) {
      if (!job.tags?.domains || !Array.isArray(job.tags.domains)) return false;
      if (!filters.domains.some(d => job.tags.domains.includes(d))) return false;
    }
    if (filters.locations && filters.locations.length > 0) {
      if (!job.tags?.locations || !Array.isArray(job.tags.locations)) return false;
      if (!filters.locations.some(l => job.tags.locations.includes(l))) return false;
    }
    if (filters.experience && job.tags?.experience !== filters.experience) return false;
    if (filters.special && filters.special.length > 0) {
      if (!job.tags?.special || !Array.isArray(job.tags.special)) return true;
      if (!filters.special.some(s => job.tags.special.includes(s))) return false;
    }
    return true;
  });
}

/**
 * Load the confirmed-dead job-id set from R2 (data/stale-job-candidates.json).
 *
 * Persistence-safe hide path: the producer writes only hard-404/410, recurrence-confirmed
 * dead ids here, off-hot-path (producer rows are NEVER dropped — tag-not-filter preserved).
 * The consumer reads it FRESH each generation and hides matching ids everywhere, so it
 * cannot be undone by the producer re-stamping jobs fresh each run.
 *
 * Defensive: returns an EMPTY Set on any failure (R2 unconfigured, client init failed,
 * key missing, malformed JSON, unexpected shape) so the consumer never hides jobs it
 * shouldn't. A producer-side failure therefore leaves every repo's README unchanged.
 */
async function fetchDeadJobIds() {
  if (!isR2Configured()) return new Set();
  const r2 = getR2Client();
  if (!r2) return new Set();
  try {
    const data = await r2.downloadJson(R2_KEY_DEAD_JOBS);
    if (!data || !Array.isArray(data.dead)) return new Set();
    const ids = new Set();
    for (const entry of data.dead) {
      if (entry && typeof entry.id === 'string' && entry.id) ids.add(entry.id);
    }
    if (ids.size > 0) {
      console.log(`   R2: stale-job-candidates dead list loaded (${ids.size} confirmed-dead id${ids.size === 1 ? '' : 's'})`);
    }
    return ids;
  } catch (err) {
    console.log(`   ⚠️ Dead-list consult skipped (behavior unchanged): ${err.message}`);
    return new Set();
  }
}

/**
 * Pure helper: drop jobs whose id appears in the dead-id set.
 * Exported so the exclusion can be unit-tested directly without R2.
 */
function applyDeadList(jobs, deadIds) {
  if (!Array.isArray(jobs) || !deadIds || deadIds.size === 0) return jobs;
  return jobs.filter(job => !deadIds.has(job.id));
}

function convertJobFormat(aggregatorJob, options = {}) {
  const jobCity = aggregatorJob.job_city || '';
  const jobState = aggregatorJob.job_state || '';
  const isUS = aggregatorJob.tags?.locations?.includes('us');
  const jobCountry = isUS ? 'United States' : '';
  return {
    job_id: aggregatorJob.id,
    job_title: aggregatorJob.title,
    employer_name: aggregatorJob.company_name,
    job_city: jobCity,
    job_state: jobState,
    job_country: jobCountry,
    job_is_remote: aggregatorJob.tags?.locations?.includes('remote') || false,
    job_location: aggregatorJob.location || null,
    job_apply_link: aggregatorJob.apply_url || aggregatorJob.url,
    job_posted_at_datetime_utc: aggregatorJob.posted_at,
    job_employment_type: aggregatorJob.employment_type || aggregatorJob.employment_types?.join(',') || 'FULLTIME',
    salary: aggregatorJob.salary?.min != null ? aggregatorJob.salary : null,
    fingerprint: aggregatorJob.fingerprint,
    tags: aggregatorJob.tags,
    _source: 'aggregator',
    _original_source: aggregatorJob.source || 'unknown'
  };
}

function createAggregatorConsumer(config = {}) {
  const { filters = {}, formatConverter = convertJobFormat, verbose = false } = config;
  const dataSource = isR2Configured() ? 'R2' : 'R2-required';
  return {
    async fetchJobs() {
      const result = await this.fetchJobsWithDiagnostics();
      return result.jobs;
    },

    async fetchJobsWithDiagnostics() {
      try {
        if (verbose) {
          console.log(`📡 Fetching from centralized aggregator via ${dataSource}...`);
          if (Object.keys(filters).length > 0) {
            console.log('   Filters:', JSON.stringify(filters));
          }
        }

        const allJobs = await fetchJobsFromAggregator();

        if (verbose) {
          console.log(`✅ Aggregator returned: ${allJobs.length} total jobs`);
        }

        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const internshipCutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000); // SUP-TTL-1
        const recentJobs = allJobs.filter(job => {
          const postedAt = job.posted_at ? new Date(job.posted_at) : null;
          if (!postedAt) return false;
          const jobCutoff = job.tags?.employment === 'internship' ? internshipCutoff : cutoff;
          return postedAt >= jobCutoff;
        });

        if (verbose) {
          console.log(`📅 After 7-day filter: ${recentJobs.length} jobs (removed ${allJobs.length - recentJobs.length} older)`);
        }

        let filteredJobs = recentJobs;

        // AGG-DEADNESS-1 (persistence-safe hide): exclude confirmed-dead jobs
        // (hard-404/410, recurrence-confirmed) read FRESH from R2 each generation.
        // Defensive — missing/empty/unreadable list hides nothing. Applied before
        // filterByTags on the full post-TTL set, so it covers every consumer repo
        // regardless of its tag filters; the producer hot path is never touched.
        const deadJobIds = await fetchDeadJobIds();
        let deadHidden = 0;
        if (deadJobIds.size > 0) {
          deadHidden = filteredJobs.length;
          filteredJobs = applyDeadList(filteredJobs, deadJobIds);
          deadHidden -= filteredJobs.length;
          if (verbose && deadHidden > 0) {
            console.log(`🪦 Hid ${deadHidden} confirmed-dead job(s) (stale-job-candidates.json)`);
          }
        }

        if (Object.keys(filters).length > 0) {
          filteredJobs = filterByTags(filteredJobs, filters);
          if (verbose) {
            console.log(`🏷️  After filtering: ${filteredJobs.length} jobs`);
          }
        }

        const formattedJobs = filteredJobs.map(job => formatConverter(job, config));
        await mergeEnrichmentData(formattedJobs);

        if (verbose) {
          console.log(`✅ Formatted ${formattedJobs.length} jobs for consumption`);
        }

        return {
          jobs: formattedJobs,
          diagnostics: {
            total_fetched: allJobs.length,
            after_ttl_filter: recentJobs.length,
            dead_hidden: deadHidden,
            after_tag_filter: filteredJobs.length,
            final_count: formattedJobs.length,
            data_source: dataSource,
          }
        };
      } catch (error) {
        console.error('❌ Error fetching from aggregator:', error.message);
        return {
          jobs: [],
          diagnostics: {
            total_fetched: 0,
            after_ttl_filter: 0,
            dead_hidden: 0,
            after_tag_filter: 0,
            final_count: 0,
            data_source: dataSource,
            error: error.message
          }
        };
      }
    },

    async fetchMetadata() {
      try {
        return await fetchMetadata();
      } catch (error) {
        console.error('❌ Error fetching metadata:', error.message);
        return null;
      }
    }
  };
}

module.exports = {
  createAggregatorConsumer,
  fetchJobsFromAggregator,
  fetchMetadata,
  mergeEnrichmentData,
  filterByTags,
  convertJobFormat,
  fetchDeadJobIds,
  applyDeadList,
  AGGREGATOR_URL,
  METADATA_URL,
  ENRICHED_URL
};
