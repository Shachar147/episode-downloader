import path from 'path';
import fsSync from 'fs';

export interface FileInfo {
  name: string;
  size: string;
  path: string;
}

/**
 * Get file information including name, size, and path
 * @param filePath - Path to the file
 * @returns FileInfo object with name, size in MB, and full path
 */
export const getFileInfo = (filePath: string): FileInfo => {
  try {
    const stats = fsSync.statSync(filePath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    return {
      name: path.basename(filePath),
      size: `${sizeMB} MB`,
      path: filePath
    };
  } catch (error) {
    return {
      name: path.basename(filePath),
      size: 'Unknown size',
      path: filePath
    };
  }
};

/**
 * Check if a file exists and is readable
 * @param filePath - Path to the file
 * @returns boolean indicating if file exists and is readable
 */
export const fileExists = (filePath: string): boolean => {
  try {
    return fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
};

/**
 * Get file size in bytes
 * @param filePath - Path to the file
 * @returns File size in bytes, or 0 if file doesn't exist
 */
export const getFileSize = (filePath: string): number => {
  try {
    return fsSync.statSync(filePath).size;
  } catch (error) {
    return 0;
  }
};

/**
 * Get file size in MB as a formatted string
 * @param filePath - Path to the file
 * @returns File size in MB as string, or "Unknown size" if error
 */
export const getFileSizeMB = (filePath: string): string => {
  try {
    const sizeBytes = fsSync.statSync(filePath).size;
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
    return `${sizeMB} MB`;
  } catch (error) {
    return 'Unknown size';
  }
};

/**
 * Check if file is larger than specified size in MB
 * @param filePath - Path to the file
 * @param maxSizeMB - Maximum size in MB
 * @returns boolean indicating if file is larger than maxSizeMB
 */
export const isFileLargerThan = (filePath: string, maxSizeMB: number): boolean => {
  try {
    const sizeBytes = fsSync.statSync(filePath).size;
    const sizeMB = sizeBytes / (1024 * 1024);
    return sizeMB > maxSizeMB;
  } catch (error) {
    return false;
  }
}; 