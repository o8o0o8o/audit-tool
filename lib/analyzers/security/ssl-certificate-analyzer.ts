/**
 * SSL Certificate Analyzer
 * Analyzes SSL/TLS certificate configuration, expiry, and security
 */

import type { PageInfo } from '../../types';
import { SEVERITY } from '../../constants';
import type * as tls from 'tls';
import * as https from 'https';

interface CertificateDetails {
  error?: string;
  isValid?: boolean;
  validationError?: string | null;
  validFrom?: string;
  validTo?: string;
  daysUntilExpiry?: number | null;
  issuer?: { CN?: string; O?: string; [key: string]: unknown };
  subject?: { CN?: string; O?: string; [key: string]: unknown };
  altNames?: string[];
  protocol?: string | null;
  cipher?: { name?: string; [key: string]: unknown } | null;
  chainLength?: number;
  fingerprint?: string;
  serialNumber?: string;
}

interface SSLFinding {
  message: string;
  detail: string;
  severity: string;
}

// Days before expiry to warn
const EXPIRY_WARNING_DAYS = 30;
const EXPIRY_CRITICAL_DAYS = 7;

// Weak cipher patterns
const WEAK_CIPHERS = ['RC4', 'DES', 'MD5', 'NULL', 'EXPORT', 'anon', '3DES'];

class SSLCertificateAnalyzer {
  /**
   * Analyze SSL certificate for a URL
   * @param {string} url - URL to analyze
   * @returns {Promise<object>} Analysis results
   */
  static async analyze(url: string) {
    const issues: SSLFinding[] = [];
    const warnings: SSLFinding[] = [];
    const info = {
      hasSSL: false,
      certificate: null,
      protocol: null,
      cipher: null,
      validFrom: null,
      validTo: null,
      daysUntilExpiry: null,
      issuer: null,
      subject: null,
      altNames: [],
      isValid: false,
      chainLength: 0,
    };

    try {
      const parsedUrl = new URL(url);

      // Only analyze HTTPS URLs
      if (parsedUrl.protocol !== 'https:') {
        warnings.push({
          message: 'Page not using HTTPS',
          detail: 'Cannot analyze SSL certificate for HTTP URL. Consider migrating to HTTPS.',
          severity: SEVERITY.HIGH,
        });
        return { issues, warnings, info };
      }

      info.hasSSL = true;

      // Get certificate details
      const certDetails: CertificateDetails = await this.getCertificateDetails(
        parsedUrl.hostname,
        Number(parsedUrl.port) || 443,
      );

      if (certDetails.error) {
        issues.push({
          message: 'SSL certificate error',
          detail: certDetails.error,
          severity: SEVERITY.CRITICAL,
        });
        return { issues, warnings, info };
      }

      // Populate info
      Object.assign(info, certDetails);

      // Check certificate validity
      if (!certDetails.isValid) {
        issues.push({
          message: 'SSL certificate is invalid',
          detail: certDetails.validationError || 'Certificate validation failed',
          severity: SEVERITY.CRITICAL,
        });
      }

      // Check expiry
      if (certDetails.daysUntilExpiry !== null) {
        if (certDetails.daysUntilExpiry! < 0) {
          issues.push({
            message: 'SSL certificate has expired',
            detail: `Certificate expired ${Math.abs(certDetails.daysUntilExpiry!)} days ago on ${certDetails.validTo}`,
            severity: SEVERITY.CRITICAL,
          });
        } else if (certDetails.daysUntilExpiry! <= EXPIRY_CRITICAL_DAYS) {
          issues.push({
            message: 'SSL certificate expiring very soon',
            detail: `Certificate expires in ${certDetails.daysUntilExpiry} days on ${certDetails.validTo}. Renew immediately!`,
            severity: SEVERITY.CRITICAL,
          });
        } else if (certDetails.daysUntilExpiry! <= EXPIRY_WARNING_DAYS) {
          warnings.push({
            message: 'SSL certificate expiring soon',
            detail: `Certificate expires in ${certDetails.daysUntilExpiry} days on ${certDetails.validTo}. Plan renewal.`,
            severity: SEVERITY.MEDIUM,
          });
        }
      }

      // Check TLS version
      if (certDetails.protocol) {
        const version = this.parseTLSVersion(certDetails.protocol);
        if (version < 1.2) {
          issues.push({
            message: 'Outdated TLS version',
            detail: `Server uses ${certDetails.protocol}. TLS 1.2 or higher is recommended for security.`,
            severity: SEVERITY.HIGH,
          });
        } else if (version < 1.3) {
          warnings.push({
            message: 'Consider upgrading to TLS 1.3',
            detail: `Server uses ${certDetails.protocol}. TLS 1.3 offers improved security and performance.`,
            severity: SEVERITY.LOW,
          });
        }
      }

      // Check cipher strength
      if (certDetails.cipher) {
        const isWeak = WEAK_CIPHERS.some((weak) => certDetails.cipher!.name?.toUpperCase().includes(weak));
        if (isWeak) {
          issues.push({
            message: 'Weak cipher suite detected',
            detail: `Cipher "${certDetails.cipher.name}" is considered weak. Configure server to use stronger ciphers.`,
            severity: SEVERITY.HIGH,
          });
        }
      }

      // Check for self-signed certificate
      if (certDetails.issuer && certDetails.subject) {
        const isSelfSigned =
          certDetails.issuer.CN === certDetails.subject.CN && certDetails.issuer.O === certDetails.subject.O;
        if (isSelfSigned) {
          issues.push({
            message: 'Self-signed certificate detected',
            detail: 'Self-signed certificates are not trusted by browsers. Use a certificate from a trusted CA.',
            severity: SEVERITY.HIGH,
          });
        }
      }

      // Check for wildcard certificate
      if (certDetails.subject?.CN?.startsWith('*')) {
        warnings.push({
          message: 'Wildcard certificate in use',
          detail: `Certificate covers ${certDetails.subject.CN}. While valid, consider dedicated certificates for sensitive subdomains.`,
          severity: SEVERITY.LOW,
        });
      }

      // Check chain length
      if (certDetails.chainLength! > 4) {
        warnings.push({
          message: 'Long certificate chain',
          detail: `Certificate chain has ${certDetails.chainLength} certificates. Long chains can slow down TLS handshake.`,
          severity: SEVERITY.LOW,
        });
      }

      // Check if hostname matches certificate
      const hostname = parsedUrl.hostname;
      const certHostnames = [certDetails.subject?.CN, ...(certDetails.altNames ?? [])];
      const hostnameMatches = certHostnames.some((cn) => this.hostnameMatches(hostname, cn!));

      if (!hostnameMatches) {
        issues.push({
          message: 'Hostname mismatch',
          detail: `Certificate is for "${certDetails.subject?.CN}" but site uses "${hostname}"`,
          severity: SEVERITY.CRITICAL,
        });
      }
    } catch (error: unknown) {
      issues.push({
        message: 'Failed to analyze SSL certificate',
        detail: (error as Error).message,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Get certificate details from a hostname
   * @param {string} hostname
   * @param {number} port
   * @returns {Promise<object>}
   */
  static getCertificateDetails(hostname: string, port = 443): Promise<CertificateDetails> {
    return new Promise<CertificateDetails>((resolve) => {
      const options = {
        hostname,
        port,
        method: 'HEAD',
        timeout: 10000,
        rejectUnauthorized: false, // We want to inspect invalid certs too
      };

      const req = https.request(options, (res) => {
        const socket = res.socket as tls.TLSSocket;
        const cert = socket.getPeerCertificate(true);

        if (!cert || Object.keys(cert).length === 0) {
          resolve({ error: 'No certificate received from server' });
          return;
        }

        const now = new Date();
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        // Check if authorized
        const isValid = socket.authorized;
        const validationError = socket.authorizationError;

        // Count chain length
        let chainLength = 1;
        let currentCert = cert;
        while (currentCert.issuerCertificate && currentCert.issuerCertificate !== currentCert) {
          chainLength++;
          currentCert = currentCert.issuerCertificate;
          if (chainLength > 10) break; // Prevent infinite loop
        }

        resolve({
          isValid,
          validationError: (validationError as unknown as string | null) ?? null,
          validFrom: validFrom.toISOString().split('T')[0],
          validTo: validTo.toISOString().split('T')[0],
          daysUntilExpiry,
          issuer: cert.issuer as Record<string, unknown>,
          subject: cert.subject as Record<string, unknown>,
          altNames: cert.subjectaltname ? cert.subjectaltname.split(', ').map((s) => s.replace('DNS:', '')) : [],
          protocol: socket.getProtocol ? socket.getProtocol() : null,
          cipher: socket.getCipher ? (socket.getCipher() as unknown as Record<string, unknown>) : null,
          chainLength,
          fingerprint: cert.fingerprint,
          serialNumber: cert.serialNumber,
        });
      });

      req.on('error', (error) => {
        resolve({ error: `Connection failed: ${error.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'Connection timeout' });
      });

      req.end();
    });
  }

  /**
   * Parse TLS version string to number
   * @param {string} protocol - e.g., "TLSv1.2"
   * @returns {number}
   */
  static parseTLSVersion(protocol: string) {
    const match = protocol.match(/TLSv?(\d+\.?\d*)/i);
    if (match) {
      return parseFloat(match[1]);
    }
    return 0;
  }

  /**
   * Check if hostname matches certificate pattern
   * @param {string} hostname
   * @param {string} pattern
   * @returns {boolean}
   */
  static hostnameMatches(hostname: string, pattern: string) {
    if (!pattern) return false;

    // Exact match
    if (hostname === pattern) return true;

    // Wildcard match
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      const hostParts = hostname.split('.');
      const patternParts = domain.split('.');

      if (hostParts.length !== patternParts.length + 1) return false;

      return hostParts.slice(1).join('.') === domain;
    }

    return false;
  }

  /**
   * Analyze SSL across the site (using first page's connection)
   * @param {object} pages - All pages data
   * @param {string} origin - Site origin
   * @returns {Promise<object>} Site-wide analysis
   */
  static async analyzeSiteWide(pages: Record<string, PageInfo>, origin: string) {
    // Just analyze the origin once
    const result = await this.analyze(origin);

    // Add site context
    const totalPages = Object.keys(pages).length;
    if (result.info.hasSSL && result.info.isValid) {
      result.warnings.push({
        message: 'SSL certificate covers entire site',
        detail: `Valid certificate protecting ${totalPages} pages. Expires: ${result.info.validTo}`,
        severity: SEVERITY.LOW,
      });
    }

    return result;
  }
}

export { SSLCertificateAnalyzer };
