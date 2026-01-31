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

    // Multi-file structure paths
    this.pagesDir = path.join(this.runDir, 'pages');
    this.manifestFile = path.join(this.runDir, 'manifest.json.gz');
    this.metadataFile = path.join(this.runDir, 'metadata.json.gz');
    this.analysisFile = path.join(this.runDir, 'analysis.json.gz');
    this.incomingLinksFile = path.join(this.runDir, 'incoming-links.json.gz');
    this.batchSize = 100;
    this.currentBatchNumber = 0;
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
   * Instance method that delegates to static method
   * @param {string} filePath - Path to JSON file
   * @returns {object} Parsed JSON data
   */
  readJsonFile(filePath) {
    return FileManager.readJsonFile(filePath);
  }

  /**
   * Read JSON file (handles both compressed and uncompressed)
   * Static method for use without instantiation
   * @param {string} filePath - Path to JSON file
   * @returns {object} Parsed JSON data
   */
  static readJsonFile(filePath) {
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

  // ==================== Multi-File Methods ====================

  /**
   * Ensure pages subdirectory exists
   */
  ensurePagesDir() {
    if (!fs.existsSync(this.pagesDir)) {
      fs.mkdirSync(this.pagesDir, { recursive: true });
    }
  }

  /**
   * Write manifest file
   * @param {object} data - Manifest data
   * @returns {object} Size statistics
   */
  writeManifest(data) {
    return this.writeJsonFile(this.manifestFile, data);
  }

  /**
   * Read manifest file
   * @returns {object} Manifest data
   */
  readManifest() {
    return this.readJsonFile(this.manifestFile);
  }

  /**
   * Check if manifest file exists
   * @returns {boolean} True if manifest exists
   */
  manifestExists() {
    return fs.existsSync(this.manifestFile);
  }

  /**
   * Write metadata file (robots, sitemaps, timing)
   * @param {object} data - Metadata
   * @returns {object} Size statistics
   */
  writeMetadata(data) {
    return this.writeJsonFile(this.metadataFile, data);
  }

  /**
   * Read metadata file
   * @returns {object} Metadata
   */
  readMetadata() {
    return this.readJsonFile(this.metadataFile);
  }

  /**
   * Write analysis file (issues, summary, quickWins)
   * @param {object} data - Analysis data
   * @returns {object} Size statistics
   */
  writeAnalysis(data) {
    return this.writeJsonFile(this.analysisFile, data);
  }

  /**
   * Read analysis file
   * @returns {object} Analysis data
   */
  readAnalysis() {
    return this.readJsonFile(this.analysisFile);
  }

  /**
   * Write incoming links file
   * @param {object} data - Incoming links data
   * @returns {object} Size statistics
   */
  writeIncomingLinks(data) {
    return this.writeJsonFile(this.incomingLinksFile, data);
  }

  /**
   * Read incoming links file
   * @returns {object} Incoming links data
   */
  readIncomingLinks() {
    return this.readJsonFile(this.incomingLinksFile);
  }

  /**
   * Write a batch of pages
   * @param {number} batchNum - Batch number (1-indexed)
   * @param {object} pages - Pages object { url: pageData }
   * @returns {object} Batch info with file path and stats
   */
  writeBatch(batchNum, pages) {
    this.ensurePagesDir();

    const batchFileName = `batch_${String(batchNum).padStart(4, '0')}.json.gz`;
    const batchFile = path.join(this.pagesDir, batchFileName);

    const batchData = {
      batchIndex: batchNum,
      createdAt: new Date().toISOString(),
      urls: Object.keys(pages),
      pages: pages,
    };

    const stats = this.writeJsonFile(batchFile, batchData);

    return {
      file: `pages/${batchFileName}`,
      batchIndex: batchNum,
      count: Object.keys(pages).length,
      urls: Object.keys(pages),
      stats,
    };
  }

  /**
   * Read a specific batch file
   * @param {number} batchNum - Batch number
   * @returns {object} Batch data with pages
   */
  readBatch(batchNum) {
    const batchFileName = `batch_${String(batchNum).padStart(4, '0')}.json.gz`;
    const batchFile = path.join(this.pagesDir, batchFileName);
    return this.readJsonFile(batchFile);
  }

  /**
   * Read a batch file by its relative path
   * @param {string} relativePath - Relative path like "pages/batch_0001.json.gz"
   * @returns {object} Batch data
   */
  readBatchByPath(relativePath) {
    const fullPath = path.join(this.runDir, relativePath);
    return this.readJsonFile(fullPath);
  }

  /**
   * Get all batch files in pages directory
   * @returns {Array<{file: string, batchIndex: number}>} List of batch files
   */
  getAllBatches() {
    if (!fs.existsSync(this.pagesDir)) {
      return [];
    }

    return fs.readdirSync(this.pagesDir)
      .filter(file => file.startsWith('batch_') && file.endsWith('.json.gz'))
      .sort()
      .map(file => {
        const match = file.match(/batch_(\d+)\.json\.gz/);
        return {
          file: `pages/${file}`,
          batchIndex: match ? parseInt(match[1], 10) : 0,
        };
      });
  }

  /**
   * Get the next batch number
   * @returns {number} Next batch number
   */
  getNextBatchNumber() {
    const batches = this.getAllBatches();
    if (batches.length === 0) {
      return 1;
    }
    return Math.max(...batches.map(b => b.batchIndex)) + 1;
  }

  /**
   * Set current batch number (for resume)
   * @param {number} batchNum - Batch number
   */
  setCurrentBatchNumber(batchNum) {
    this.currentBatchNumber = batchNum;
  }

  /**
   * Get paths for multi-file structure
   * @returns {object} File paths
   */
  getMultiFilePaths() {
    return {
      manifest: this.manifestFile,
      metadata: this.metadataFile,
      analysis: this.analysisFile,
      incomingLinks: this.incomingLinksFile,
      pagesDir: this.pagesDir,
    };
  }
}

module.exports = { FileManager };
