/**
 * File Manager
 * Handles file operations, compression, and archiving
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class FileManager {
  constructor(domainName, resultsDir = 'audit-results', timestamp = null) {
    this.domainName = domainName;
    this.baseResultsDir = resultsDir;
    this.archivePartNumber = 0;

    // Generate timestamp for this run if not provided
    this.timestamp = timestamp || this.generateTimestamp();

    // Create directory structure: audit-results/domain.com/YYYY-MM-DD_HH-MM-SS/
    this.domainDir = path.join(this.baseResultsDir, this.domainName);
    this.runDir = path.join(this.domainDir, this.timestamp);
    this.resultsDir = this.runDir; // For backward compatibility

    // Ensure directory structure exists
    if (!fs.existsSync(this.runDir)) {
      fs.mkdirSync(this.runDir, { recursive: true });
      console.log(`📁 Created audit directory: ${this.runDir}`);
    }

    this.mainFile = path.join(this.runDir, `SEOAnalysis__${this.domainName}.json.gz`);
    this.htmlFile = path.join(this.runDir, `${this.domainName}.html`);
  }

  /**
   * Generate timestamp string for folder name
   * @returns {string} Timestamp in format YYYY-MM-DD_HH-MM-SS
   */
  generateTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  }

  /**
   * Read JSON file (handles both compressed and uncompressed)
   * @param {string} filePath - Path to JSON file
   * @returns {object} Parsed JSON data
   */
  readJsonFile(filePath) {
    // Check if .json.gz exists first (new format)
    const gzPath = filePath.endsWith('.gz') ? filePath : filePath + '.gz';
    const jsonPath = filePath.replace(/\.gz$/, '');

    let actualPath;
    let isCompressed = false;

    if (fs.existsSync(gzPath)) {
      actualPath = gzPath;
      isCompressed = true;
    } else if (fs.existsSync(jsonPath)) {
      actualPath = jsonPath;
      isCompressed = false;
    } else {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(actualPath);

    if (isCompressed) {
      const decompressed = zlib.gunzipSync(fileContent);
      return JSON.parse(decompressed.toString('utf-8'));
    } else {
      return JSON.parse(fileContent.toString('utf-8'));
    }
  }

  /**
   * Write JSON data to file with compression
   * @param {string} filePath - Path to write to
   * @param {object} data - Data to write
   * @returns {object} Size statistics
   */
  writeJsonFile(filePath, data) {
    const jsonString = JSON.stringify(data);
    const compressedData = zlib.gzipSync(jsonString);

    const uncompressedSizeMB = Buffer.byteLength(jsonString, 'utf-8') / (1024 * 1024);
    const compressedSizeMB = compressedData.length / (1024 * 1024);
    const compressionRatio = ((1 - (compressedSizeMB / uncompressedSizeMB)) * 100).toFixed(1);

    fs.writeFileSync(filePath, compressedData);

    return {
      uncompressedSizeMB,
      compressedSizeMB,
      compressionRatio,
    };
  }

  /**
   * Archive processed pages to separate file
   * @param {object} pagesToArchive - Pages to archive
   * @returns {string} Archive file path
   */
  archiveProcessedPages(pagesToArchive) {
    this.archivePartNumber++;
    const archiveFile = path.join(
      this.resultsDir,
      `SEOAnalysis__${this.domainName}__archive_part${this.archivePartNumber}.json.gz`
    );

    console.log(`\n📦 Archiving ${Object.keys(pagesToArchive).length} processed pages to ${archiveFile}...`);

    const archiveData = {
      archivePart: this.archivePartNumber,
      archivedAt: new Date().toISOString(),
      pages: pagesToArchive,
    };

    const stats = this.writeJsonFile(archiveFile, archiveData);
    console.log(`✓ Archive saved: ${stats.uncompressedSizeMB.toFixed(2)} MB → ${stats.compressedSizeMB.toFixed(2)} MB compressed (${stats.compressionRatio}% reduction)\n`);

    return archiveFile;
  }

  /**
   * Load all archive files and merge pages
   * @param {number} lastArchivePart - Number of archive parts to load
   * @returns {object} Merged pages from all archives
   */
  loadArchives(lastArchivePart) {
    const mergedPages = {};

    if (!lastArchivePart || lastArchivePart === 0) {
      return mergedPages;
    }

    console.log(`Loading ${lastArchivePart} archive file(s)...`);

    for (let i = 1; i <= lastArchivePart; i++) {
      const archiveFile = path.join(
        this.resultsDir,
        `SEOAnalysis__${this.domainName}__archive_part${i}.json`
      );

      try {
        console.log(`  - Loading archive part ${i}...`);
        const archiveData = this.readJsonFile(archiveFile);

        Object.assign(mergedPages, archiveData.pages);
        console.log(`    Loaded ${Object.keys(archiveData.pages).length} pages from archive part ${i}`);
      } catch (error) {
        console.warn(`  ⚠️  Could not load archive part ${i}: ${error.message}`);
      }
    }

    console.log(`✓ All archived pages loaded. Total pages: ${Object.keys(mergedPages).length}\n`);
    return mergedPages;
  }

  /**
   * Get the main file path
   * @returns {string} Main file path
   */
  getMainFilePath() {
    return this.mainFile;
  }

  /**
   * Check if main file exists
   * @returns {boolean} True if file exists
   */
  mainFileExists() {
    const gzPath = this.mainFile;
    const jsonPath = this.mainFile.replace(/\.gz$/, '');
    return fs.existsSync(gzPath) || fs.existsSync(jsonPath);
  }

  /**
   * Set the current archive part number
   * @param {number} partNumber - Archive part number
   */
  setArchivePartNumber(partNumber) {
    this.archivePartNumber = partNumber;
  }

  /**
   * Get the current archive part number
   * @returns {number} Current archive part number
   */
  getArchivePartNumber() {
    return this.archivePartNumber;
  }

  /**
   * Get path to HTML report file
   * @returns {string} HTML file path
   */
  getHtmlFilePath() {
    return this.htmlFile;
  }

  /**
   * Get path to run directory
   * @returns {string} Run directory path
   */
  getRunDir() {
    return this.runDir;
  }

  /**
   * Find the latest run directory for this domain
   * @returns {string|null} Path to latest run directory or null if none found
   */
  static findLatestRun(domainName, resultsDir = 'audit-results') {
    const domainDir = path.join(resultsDir, domainName);

    if (!fs.existsSync(domainDir)) {
      return null;
    }

    const runs = fs.readdirSync(domainDir)
      .filter(dir => {
        const fullPath = path.join(domainDir, dir);
        return fs.statSync(fullPath).isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(dir);
      })
      .sort()
      .reverse(); // Most recent first

    if (runs.length === 0) {
      return null;
    }

    return path.join(domainDir, runs[0]);
  }

  /**
   * Get all run directories for this domain
   * @returns {Array<{timestamp: string, path: string}>} List of runs
   */
  static getAllRuns(domainName, resultsDir = 'audit-results') {
    const domainDir = path.join(resultsDir, domainName);

    if (!fs.existsSync(domainDir)) {
      return [];
    }

    return fs.readdirSync(domainDir)
      .filter(dir => {
        const fullPath = path.join(domainDir, dir);
        return fs.statSync(fullPath).isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(dir);
      })
      .sort()
      .reverse() // Most recent first
      .map(timestamp => ({
        timestamp,
        path: path.join(domainDir, timestamp)
      }));
  }
}

module.exports = { FileManager };
