/**
 * Shared README Generator Library
 *
 * Extracted from duplicated readme-generator.js files in SEO repos.
 * Bug #1 (2026-02-13) proved code duplication = 4x fix effort.
 *
 * Factory function pattern: createReadmeGenerator(config, jobCategories, repoRoot)
 * Returns object with all README generation functions.
 */

const fs = require("fs");
const path = require("path");

/**
 * Create README generator with repo-specific configuration
 *
 * @param {Object} config - Validated repo config (from config.js)
 * @param {Object} jobCategories - Job categories with keywords (from job_categories.json)
 * @param {string} repoRoot - Absolute path to repo root (process.cwd())
 * @returns {Object} README generator functions
 */
function createReadmeGenerator(config, jobCategories, repoRoot) {
  // Import shared utilities
  const { logger } = require(path.join(__dirname, "../index.js"));

  // Import consumer utilities (from this submodule)
  const consumerUtils = require("./utils");
  const {
    initCompanyDatabase,
    getCompanyEmoji,
    getCompanyCareerUrl,
    formatTimeAgo,
    getExperienceLevel,
    formatLocation,
    generateMinimalJobFingerprint,
  } = consumerUtils;

  // Load per-repo companies.json and initialize company database
  let companies = {};
  let ALL_COMPANIES = [];
  const companiesPath = path.join(repoRoot, '.github/scripts/job-fetcher/companies.json');
  if (fs.existsSync(companiesPath)) {
    companies = JSON.parse(fs.readFileSync(companiesPath, 'utf8'));
    const firstCategory = Object.values(companies)[0];
    if (Array.isArray(firstCategory)) {
      initCompanyDatabase(companies);
      ALL_COMPANIES = consumerUtils.ALL_COMPANIES;
    }
  }

  // Path to repo root README.md
  const REPO_README_PATH = path.join(repoRoot, 'README.md');


  // Filter out senior positions - primary: tags.employment (classified from full posting);
  // fallback: title keywords (for jobs missing tags.employment)
  function filterOutSeniorPositions(jobs) {
    return jobs.filter(job => {
      if (job.tags?.employment === 'senior') return false;
      const level = getExperienceLevel(job.job_title);
      return level !== "Senior";
    });
  }

  // Helper function to categorize a job based on keywords
  function getJobCategoryFromKeywords(jobTitle, jobDescription = '') {
    // Title only — descriptions cause false positives for short keywords
    // e.g. "ios" matches "previous", "curious" in description text
    const titleText = (jobTitle || '').toLowerCase();

    // Check each category's keywords
    // Keywords prefixed with "~" use word-boundary matching (no adjacent a-z chars)
    // e.g. "~rn" matches "Staff RN," and "RN - ICU" but NOT "intern"
    for (const [categoryKey, categoryData] of Object.entries(jobCategories)) {
      for (const keyword of categoryData.keywords) {
        if (keyword.startsWith('~')) {
          const word = keyword.slice(1);
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp('(?<![a-z])' + escaped + '(?![a-z])', 'i');
          if (regex.test(titleText)) return categoryKey;
        } else if (titleText.includes(keyword.toLowerCase())) {
          return categoryKey;
        }
      }
    }

    return config.defaultCategory; // From config (varies per repo)
  }

  // Generate job table — flat per-category, sorted newest-first
  function generateJobTable(jobs) {
    logger.debug('Starting generateJobTable', { total_jobs: jobs.length });

    jobs = filterOutSeniorPositions(jobs);
    logger.debug('After filtering seniors', { remaining_jobs: jobs.length });

    const showVisaColumn = config.features?.showVisaColumn !== false;  // Default: true

    if (jobs.length === 0) {
      if (showVisaColumn) {
        return `| Company | Role | Location | Posted | Visa | Apply |
|---------|------|----------|--------|------|-------|
| *No current openings* | *Check back tomorrow* | *-* | *-* | *-* | *-* |`;
      } else {
        return `| Company | Role | Location | Posted | Apply |
|---------|------|----------|--------|-------|
| *No current openings* | *Check back tomorrow* | *-* | *-* | *-* |`;
      }
    }

    // F3 (D67 audit): guard against silent job-loss — if defaultCategory isn't a defined category,
    // jobs not matching any keyword go to a bucket the render loop never reads and are dropped.
    if (config.defaultCategory && !jobCategories[config.defaultCategory]) {
      logger.warn(`defaultCategory "${config.defaultCategory}" is not a defined category for ${config.repo} — jobs matching no keyword will be DROPPED from the README`);
    }
    // Categorize all jobs
    const jobsByCategory = {};
    jobs.forEach((job) => {
      const categoryKey = getJobCategoryFromKeywords(job.job_title);
      if (!jobsByCategory[categoryKey]) {
        jobsByCategory[categoryKey] = [];
      }
      jobsByCategory[categoryKey].push(job);
    });

    let output = "";

    // One collapsible section per category, flat table inside sorted newest-first
    Object.entries(jobCategories).forEach(([categoryKey, categoryData]) => {
      const categoryJobs = jobsByCategory[categoryKey];
      if (!categoryJobs || categoryJobs.length === 0) return;

      // Sort newest-first; null dates sort to end
      // Dedupe by job_id (catches multi-CX-site Oracle variants — same job, different employer spelling/URL)
      const _seenJobIds = new Set();
      const _dedupedJobs = categoryJobs.filter(j => {
        const id = j.job_id;
        if (!id) return true;
        if (_seenJobIds.has(id)) return false;
        _seenJobIds.add(id);
        return true;
      });
      categoryJobs.length = 0;
      categoryJobs.push(..._dedupedJobs);
      categoryJobs.sort((a, b) => {
        const dateA = a.job_posted_at_datetime_utc ? new Date(a.job_posted_at_datetime_utc) : new Date(0);
        const dateB = b.job_posted_at_datetime_utc ? new Date(b.job_posted_at_datetime_utc) : new Date(0);
        return dateB - dateA;
      });

      // Show each job as its own row (no grouping — different postings aren't the same job).
      // Per-company cap prevents prolific posters from monopolizing.
      const PER_COMPANY_CAP = 3;
      const TOTAL_CAP = 100;
      const perCompanyCount = {};
      const finalJobs = categoryJobs.filter(job => {
        const co = (job.employer_name || '').toLowerCase();
        perCompanyCount[co] = (perCompanyCount[co] || 0) + 1;
        return perCompanyCount[co] <= PER_COMPANY_CAP;
      }).slice(0, TOTAL_CAP);

      output += `<details>\n`;
      output += `<summary><h3>${categoryData.emoji} <strong>${categoryData.title}</strong></h3></summary>\n\n`;
      if (showVisaColumn) {
        output += `| Company | Role | Location | Posted | Visa | **Apply** |\n`;
        output += `|---------|------|----------|--------|------|----------|\n`;
      } else {
        output += `| Company | Role | Location | Posted | **Apply** |\n`;
        output += `|---------|------|----------|--------|----------|\n`;
      }

      finalJobs.forEach((job) => {
        // Sanitize user-controlled fields — pipe chars break markdown table columns
        const companyName = (job.employer_name || '').replace(/\|/g, '').trim();
        const roleRaw = (job.job_title || '').replace(/\|/g, ' ').trim();
        const role = roleRaw.length > 40 ? roleRaw.substring(0, 37) + '...' : roleRaw;

        // OUT-LOCATION-3: Use job_location for WD "City, ST + N more" format, fall back to formatLocation
        let locationRaw = job.job_location && job.job_location !== formatLocation(job.job_city, job.job_state)
          ? job.job_location
          : formatLocation(job.job_city, job.job_state);
        // Clean known WD location artifacts at display time
        locationRaw = locationRaw
          .replace(/^US[-\s]+/i, '')                           // "US OR Lake Oswego" → "OR Lake Oswego"
          .replace(/\s*~\s*.+$/, '')                           // Strip tilde suffixes ("GA-512 ~ address")
          .replace(/\s*(Office|Campus|Building|HQ|Center)\b.*$/i, '') // Strip WD site names
          .replace(/\s*[-–—]\s*(Retail|XFR)\b.*$/i, '')       // Strip retail suffixes " - Retail XFR####"
          .replace(/\s*[-–—]\s*\d+.*$/, '')                    // Strip " - 4433 N. 1st Ave" address suffixes
          .replace(/,\s*\d+\s.*\b(?:Ave|Blvd|Dr|Rd|St|Pkwy|Ln|Way|Cir|Ct|Pl|Ste|Suite)\b.*$/i, ''); // Strip street addresses

        // Handle "United States" as city (GH jobs where city is literally "United States")
        if (locationRaw.startsWith('United States') && job.job_state) {
          locationRaw = job.job_state; // "United States, CA" → "CA"
        }

        // WD addresses: handle uppercase, mixed-case, and reverse formats
        // Uppercase: "PA-CHAMBERSBURG-5808-CUST--1-Overcash-Ave" → "Chambersburg, PA"
        // Mixed-case: "California-United States..." or "North Dakota - Fargo" → "Fargo, ND"
        // Space-separated: "TX BAYTOWN 07042 IMPORT" → "Baytown, TX"
        let wdAddrMatched = false;

        // 0. Try space-separated WD format: STATE CITY [CODE] [FACILITY NAME]
        // "TX BAYTOWN 07042 IMPORT" or "PA Philadelphia 1800 Arch St" or "FL JAX 347"
        const wdSpaceSep = locationRaw.match(/^([A-Z]{2})\s+((?:[A-Za-z][A-Za-z.]+(?:\s+[A-Za-z][A-Za-z.]+)*?))(?:\s+\d+.*)?$/);
        if (wdSpaceSep && wdSpaceSep[2].trim().length > 1) {
          const cityWords = wdSpaceSep[2].trim().split(/\s+/);
          locationRaw = cityWords.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') + ', ' + wdSpaceSep[1];
          wdAddrMatched = true;
        }
        // 1. Try uppercase WD format first: STATE-UPPERCASE CITY-CODE
        const wdAddrUpper = locationRaw.match(/^([A-Z]{2})-((?:[A-Z]+(?: [A-Z]+)*?))(?:-[A-Z0-9]{1,}.*|$)/);
        if (wdAddrUpper && wdAddrUpper[2].trim().length > 1) {
          const cityWords = wdAddrUpper[2].trim().split(/\s+/);
          locationRaw = cityWords.map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') + ', ' + wdAddrUpper[1];
          wdAddrMatched = true;
        }
        // 2. Try mixed-case or reverse format: "State - City" or "State-City"
        if (!wdAddrMatched) {
          const mixedCaseAddr = locationRaw.match(/^([A-Za-z\s]+?)\s*[-–—]\s*(.+?)(?:\s*[-–—].*|$)/);
          if (mixedCaseAddr && mixedCaseAddr[2].trim().length > 1) {
            const statePart = mixedCaseAddr[1].trim();
            const cityPart = mixedCaseAddr[2].trim();
            // Check if first part looks like a state code (2 letters) or full state name
            const stateCodeMatch = statePart.match(/^([A-Za-z]{2})$/);
            if (stateCodeMatch) {
              // "ND - Fargo" → "Fargo, ND"
              locationRaw = `${cityPart}, ${statePart.toUpperCase()}`;
            } else if (statePart.length > 2) {
              // Full state name like "North Dakota - Fargo" → use city only (state in job_state)
              locationRaw = cityPart;
            }
          }
        }
        const locationTrunc = locationRaw.length > 25 ? locationRaw.substring(0, 22) + "..." : locationRaw;
        const location = locationTrunc.replace(/\|/g, '').trim();
        const posted = job.posted_at_estimated ? 'Date unknown' : formatTimeAgo(job.job_posted_at_datetime_utc);
        const applyLink = job.job_apply_link || job.url || job.apply_url || getCompanyCareerUrl(job.employer_name || job.company_name);

        if (showVisaColumn) {
          // Canada boards (features.visaSource==='lmia'): single company-level tier from
          // ENR's LMIA lane (ESDC Positive LMIA Employers List — employer approved to
          // hire foreign workers in Canada). No job-level tier exists for Canada; no
          // signal stays blank (OUT-INV-5 rule). US boards keep the 3-tier display.
          if (config.features?.visaSource === 'lmia') {
            const visa = job.enrichment?.canada_lmia_positive === true ? "🏛 LMIA" : "";
            output += `| **${companyName}** | ${role} | ${location} | ${posted} | ${visa} | [<img src="images/apply.png" width="80" alt="Apply">](${applyLink}) |\n`;
          } else {
            const sponsorsVisa = job.enrichment?.sponsors_visa;
            const visaQuestion = job.enrichment?.visa_question_present;
            const possibleSponsor = job.enrichment?.possible_sponsor;
            // Three-tier visa display: job-confirmed > company-level LCA hint > no signal
            const jobLevelSignal = sponsorsVisa || visaQuestion;
            const visa = jobLevelSignal ? "✅ Sponsor" : (possibleSponsor ? "🏛 H-1B Co." : "");
            output += `| **${companyName}** | ${role} | ${location} | ${posted} | ${visa} | [<img src="images/apply.png" width="80" alt="Apply">](${applyLink}) |\n`;
          }
        } else {
          output += `| **${companyName}** | ${role} | ${location} | ${posted} | [<img src="images/apply.png" width="80" alt="Apply">](${applyLink}) |\n`;
        }
      });

      output += `\n<p align="center">Apply for more jobs at</p>\n<p align="center"><a href="https://softwarejobs.dev/"><img src="images/softwarejobs-button.png" height="40" alt="See more jobs on softwarejobs.dev"></a></p>\n\n`;
      output += `</details>\n\n`;
    });

    logger.debug('Finished generating job table', { total_jobs: jobs.length });
    return output;
  }

  function generateInternshipSection(internshipData) {
    if (!internshipData) return "";

    return `
---

## SWE Internships 2027

<img src="images/${config.repoPrefix}-internships.png" alt="Software engineering internships for 2027.">

### 🏢 **FAANG+ Internship Programs**

| Company | Program | Application Link |
|---------|---------|------------------|
${internshipData.companyPrograms
  .map((program) => {
    const companyObj = ALL_COMPANIES.find((c) => c.name === program.company);
    const emoji = companyObj ? companyObj.emoji : "🏢";
    return `| ${emoji} **${program.company}** | ${program.program} | <p align="center">[<img src="images/apply.png" width="75" alt="Apply button">](${program.url})</p> |`;
  })
  .join("\n")}

### 📚 **Top Software Internship Resources**

| Platform | Type | Description | Link |
|----------|------|-------------|------|
${internshipData.sources
  .map(
    (source) =>
      `| **${source.emogi} ${source.name}** | ${source.type} | ${source.description} | [<img src="images/${config.repoPrefix}-visit.png" width="75" alt="Visit button">](${source.url}) |`
  )
  .join("\n")}

`;
  }

  function generateArchivedSection(archivedJobs, stats) {
    if (archivedJobs.length === 0) return "";

    archivedJobs = filterOutSeniorPositions(archivedJobs);

    // Get top category from archived jobs
    const categoryCounts = {};
    archivedJobs.forEach(job => {
      const cat = getJobCategoryFromKeywords(job.job_title);
      const catTitle = jobCategories[cat]?.title || 'Software Engineering';
      categoryCounts[catTitle] = (categoryCounts[catTitle] || 0) + 1;
    });
    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Software Engineering';

    return `
---

<details>
<summary><h2>🗂️ <strong>ARCHIVED SWE JOBS</strong> - ${
      archivedJobs.length
    } Older Positions (7+ days old) - Click to Expand 👆</h2></summary>

### 📊 **Archived Job Stats**
- **📁 Total Jobs**: ${archivedJobs.length} positions
- **🏢 Companies**: ${Object.keys(stats.totalByCompany).length} companies
- **🏷️ Top Category**: ${topCategory}

${generateJobTable(archivedJobs)}

</details>

---

`;
  }

  // Generate comprehensive README
  async function generateReadme(currentJobs, archivedJobs = [], internshipData = null, stats = null) {
    const currentTimestamp = new Date().toISOString();
    const currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const currentJobsCount = currentJobs.length;
    const runMetricsPath = path.join(repoRoot, '.github', 'data', 'run_metrics.json');
    let feedCount = null;
    let countTimestamp = currentTimestamp;

    if (fs.existsSync(runMetricsPath)) {
      try {
        const runMetrics = JSON.parse(fs.readFileSync(runMetricsPath, 'utf8'));
        if (typeof runMetrics.total_fetched === 'number') {
          feedCount = runMetrics.total_fetched;
        }
        if (runMetrics.timestamp) {
          countTimestamp = runMetrics.timestamp;
        }
      } catch (err) {
        logger.warn('Failed to read run_metrics.json for count contract', { error: err.message });
      }
    }

    // Filter senior positions
    currentJobs = filterOutSeniorPositions(currentJobs);

    // Calculate stats from currentJobs only (not archived)
    const currentStats = {
      byCategory: {},
      totalByCompany: {}
    };

    currentJobs.forEach(job => {
      // Count by category (using new job categories)
      const categoryKey = getJobCategoryFromKeywords(job.job_title);
      const categoryTitle = jobCategories[categoryKey]?.title || 'Software Engineering';
      currentStats.byCategory[categoryTitle] = (currentStats.byCategory[categoryTitle] || 0) + 1;

      // Count by company
      const company = job.employer_name;
      currentStats.totalByCompany[company] = (currentStats.totalByCompany[company] || 0) + 1;
    });

    const totalCompanies = Object.keys(currentStats.totalByCompany).length;

    // OUT-BADGE-1: Find most-populated category for second badge
    const topCategory = Object.entries(currentStats.byCategory)
      .sort((a, b) => b[1] - a[1])[0] || ['Other', 0];

    // OUT-README-2: 3rd badge (top category) removed — restated repo identity for specialty repos,
    // misleading for multi-domain repos (NGJ showing "Software Engineering" for a 20K+ job repo).
    // OUT-BADGE-1: Restored as separate badge showing top category name + count.

    // Replace placeholders in config description strings
    const replacePlaceholders = (str) => str
      ? str.replace(/\{totalCompanies\}/g, totalCompanies).replace(/\{currentJobs\}/g, currentJobs.length)
      : str;
    const renderedConfig = {
      descriptionLine1: replacePlaceholders(config.descriptionLine1),
      descriptionLine2: replacePlaceholders(config.descriptionLine2)
    };

    const refTags = { int: 'gh-internships', ngj: 'gh-newgrad-jobs', sej: 'gh-newgrad-swe', dsj: 'gh-newgrad-datascience', hej: 'gh-newgrad-hardware', hcj: 'gh-newgrad-healthcare', itj: 'gh-newgrad-it', 'ngj-can': 'gh-canada-jobs', 'int-can': 'gh-canada-internships', 'canada-jobs': 'gh-canada-jobs', 'canada-internships': 'gh-canada-internships' };
    const refTag = config.refTag || refTags[config.repoPrefix] || refTags[config.buttonPrefix] || 'gh-github';
    const listingsImageFile = config.listingsImageFile || `${config.repoPrefix}-listings.png`;

    return `



<div align="center">

<!-- Cover -->
<img src="images/covers/cover.png" alt="${config.headingImageAlt}">

# ${config.title}

${config.tagline}

</div>

<p align="center">${renderedConfig.descriptionLine1}</p>

<div align="center">

![${config.jobCountBadgeLabel || 'Active Jobs'}](https://img.shields.io/badge/${(config.jobCountBadgeLabel || 'Active Jobs').replace(/ /g, '_')}-${currentJobs.length}-brightgreen?style=flat&logo=briefcase)
![Top: ${topCategory[0]}](https://img.shields.io/badge/${topCategory[0].replace(/ /g, '_')}-${topCategory[1]}-informational?style=flat&logo=briefcase)
![Companies](https://img.shields.io/badge/Companies-${totalCompanies}-blue?style=flat&logo=building)
![Last Update](https://img.shields.io/github/last-commit/zapplyjobs/${config.repo}?style=flat&logo=calendar)

</div>

> [!${config.noteType}]
> ${config.noteText}
---

## **Website & Autofill Extension**

[![Apply to jobs in seconds with Zapply.](images/apply-faster-banner.png)](https://app.zapply.jobs/onboarding/?ref=${refTag})

Explore Zapply's website and check out:

- Our Chrome extension, which autofills job applications in seconds.
- A dedicated job board featuring the latest openings across various roles.
- User accounts with multiple profiles for different resume types and roles.
- Job application tracking with streaks and commitment awards.

Experience an advanced career journey with us! 🚀

<p align="center">
  <a href="https://app.zapply.jobs/onboarding/?ref=${refTag}"><img src="images/get-started-button.png" alt="Visit Zapply" width="500"></a>
</p>

## Explore Around

<img src="images/community.png" alt="Explore Around">

Connect and seek advice from a growing network of fellow students and new grads.

<p align="center">
  <a href="https://discord.gg/UswBsduwcD"><img src="images/discord-button-1.png" alt="Visit Our Discord Server" width="290"></a>
  &nbsp;&nbsp;
  <a href="https://www.linkedin.com/company/zapply-jobs"><img src="images/linkedin-button-1.png" alt="Visit Our LinkedIn Page" width="250"></a>
</p>


---

${config.features?.listingsBanner === false ? '' : `<img src="images/${listingsImageFile}" alt="${config.listingsImageAlt || 'Fresh 2027 job listings (under 1 week).'}">`}
 
${generateJobTable(currentJobs)}

${config.features?.internships && internshipData ? generateInternshipSection(internshipData) : ''}

---

${config.features?.moreResources ? `<img src="images/more-resources.png" alt="Jobs and templates in our other repos.">

${(() => {
  const allButtons = [
    { prefix: 'ngj', url: 'https://github.com/zapplyjobs/New-Grad-Jobs-2027', img: 'repo-ngj.png', alt: 'New Grad Jobs 2027' },
    { prefix: 'sej', url: 'https://github.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2027', img: 'repo-sej.png', alt: 'Software Engineering Jobs' },
    { prefix: 'dsj', url: 'https://github.com/zapplyjobs/New-Grad-Data-Science-Jobs-2027', img: 'repo-dsj.png', alt: 'Data Science Jobs' },
    { prefix: 'hej', url: 'https://github.com/zapplyjobs/New-Grad-Hardware-Engineering-Jobs-2027', img: 'repo-hej.png', alt: 'Hardware Engineering Jobs' },
    { prefix: 'hcj', url: 'https://github.com/zapplyjobs/New-Grad-Healthcare-Jobs-2027', img: 'repo-hcj.png', alt: 'Healthcare Jobs' },
    { prefix: 'ngj-can', url: 'https://github.com/zapplyjobs/Canada-Jobs-2027', img: 'repo-ngj-can.png', alt: 'Canada Jobs 2027' },
    { prefix: 'itj', url: 'https://github.com/zapplyjobs/New-Grad-IT-Jobs-2027', img: 'new-grad-it-jobs-button.png', alt: 'New Grad IT Jobs' },
    { prefix: 'int', url: 'https://github.com/zapplyjobs/Internships-2027', img: 'repo-int.png', alt: 'Internships 2027' },
    { prefix: 'ml', url: 'https://github.com/zapplyjobs/awesome-ML-internships', img: 'repo-ml.png', alt: 'AI & ML Internships' },
    { prefix: 'int-can', url: 'https://github.com/zapplyjobs/Canada-Internships-2027', img: 'repo-int-can.png', alt: 'Canada Internships 2027' },
    { prefix: 'rifu', url: 'https://github.com/zapplyjobs/Research-Internships-for-Undergraduates', img: 'research-internships-button.png', alt: 'Research Internships' },
    { prefix: 'uci', url: 'https://github.com/zapplyjobs/underclassmen-internships', img: 'underclassmen-internships-button.png', alt: 'Underclassmen Internships' },
    { prefix: 'rss', url: 'https://github.com/zapplyjobs/resume-samples-2026', img: 'repo-rss.png', alt: 'Resume Samples' },
    { prefix: 'ihb', url: 'https://github.com/zapplyjobs/interview-handbook-2026', img: 'repo-ihb.png', alt: 'Interview Handbook' },
  ].filter(b => b.prefix !== (config.buttonPrefix || config.repoPrefix));
  const groups = [
    { heading: 'Live Job Boards', prefixes: ['ngj', 'sej', 'dsj', 'hej', 'hcj', 'ngj-can', 'itj'] },
    { heading: 'Curated Internships', prefixes: ['int', 'ml', 'int-can', 'rifu', 'uci'] },
    { heading: 'Career Resources', prefixes: ['rss', 'ihb'] },
  ];
  return groups
    .map(group => {
      const buttons = allButtons.filter(button => group.prefixes.includes(button.prefix));
      if (buttons.length === 0) return '';
      const rows = [];
      for (let i = 0; i < buttons.length; i += 3) {
        const row = buttons.slice(i, i + 3);
        rows.push(`<p align="center">\n${row.map(b => `  <a href="${b.url}"><img src="images/${b.img}" alt="${b.alt}" height="40"></a>`).join('\n  &nbsp;&nbsp;\n')}\n</p>`);
      }
      return `### ${group.heading}\n\n${rows.join('\n')}`;
    })
    .filter(Boolean)
    .join('\n\n<hr>\n\n');
})()}

---

` : ''}<img src="images/contributor.png" alt="Become a Contributor">

Add new jobs to our listings keeping in mind the following:

- Located in ${config.contributorLocation || 'the US'}.
- Create a new issue to submit different job positions.
- Update a job by submitting an issue with the job URL and required changes.

Our team reviews within 24-48 hours and approved jobs are added to the main list!

Questions? Create a miscellaneous issue, and we'll assist! 🙏

${archivedJobs.length > 0 ? generateArchivedSection(archivedJobs, currentStats) : ""}

<div align="center">

**🎯 ${currentJobs.length} current opportunities from ${totalCompanies} companies**

**Found this helpful? Give it a ⭐ to support Zapply!**

*Not affiliated with any companies listed. All applications redirect to official career pages.*

---

**Last Updated**: ${currentDate}

</div>`;
  }

  // Update README file
  async function updateReadme(currentJobs, existingArchivedJobs = [], internshipData, stats) {
    try {
      logger.info('Generating README content');

      // Centralized pipeline (generate-and-push-readmes.js) passes pre-filtered jobs.
      // AGG's 14-day TTL is the canonical freshness gate (filterJobsByAge removed — was 7-day, would drop AGG-kept jobs).

      const archivedJobs = existingArchivedJobs;

      logger.info('Using pre-filtered jobs', {
        current: currentJobs.length,
        archived: archivedJobs.length
      });

      const readmeContent = await generateReadme(
        currentJobs,
        archivedJobs,
        internshipData,
        stats
      );
      fs.writeFileSync(REPO_README_PATH, readmeContent, "utf8");

      logger.info('README.md updated successfully', {
        current_jobs: currentJobs.length,
        archived_jobs: archivedJobs.length,
        companies: Object.keys(stats?.totalByCompany || {}).length
      });
    } catch (err) {
      logger.error('Error updating README', {
        error: err.message,
        stack: err.stack
      });
      throw err;
    }
  }

  // Return all generator functions
  return {
    generateJobTable,
    generateInternshipSection,
    generateArchivedSection,
    generateReadme,
    updateReadme,
    filterOutSeniorPositions,
  };
}

module.exports = { createReadmeGenerator };