const path = require('path');
const { config, loadSibling } = require('./config-loader');
const jobCategoriesPath = loadSibling('job_categories.json');
const jobCategories = jobCategoriesPath ? require(jobCategoriesPath) : {};
const { createReadmeGenerator } = require(path.join(__dirname, '../lib/readme-generator.js'));
module.exports = createReadmeGenerator(config, jobCategories, process.cwd());
