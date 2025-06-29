import { exec } from 'child_process';
import { promisify } from 'util';
import { sendMessage } from './whatsapp-utils';
import { formatDuration } from './time-utils';
import { getFileSizeMB, isFileLargerThan } from './file-utils';
import fs from 'fs';

const execAsync = promisify(exec);

// Compression threshold in MB - files larger than this will be compressed
export const COMPRESSION_THRESHOLD_MB = 110;

/**
 * Check if compression is needed based on file size
 * @param inputPath - Path to the input video file
 * @returns boolean indicating if compression is needed
 */
export const needsCompression = (inputPath: string): boolean => {
  return isFileLargerThan(inputPath, COMPRESSION_THRESHOLD_MB);
};

/**
 * Compress video for WhatsApp with improved quality settings
 * @param inputPath - Path to the input video file
 * @param outputPath - Path for the compressed output file
 * @param progressMessage - Message to show during compression
 * @param episodeName - Name of the episode for WhatsApp messages
 * @param MY_NUMBER - WhatsApp number to send progress updates to
 */
export async function compressForWhatsapp(
  inputPath: string,
  outputPath: string,
  progressMessage: string,
  episodeName: string,
  MY_NUMBER: string
): Promise<void> {
  // Check if compression is needed
  if (!needsCompression(inputPath)) {
    const inputFileInfo = getFileSizeMB(inputPath);
    await sendMessage(MY_NUMBER, episodeName, `File size (${inputFileInfo}) is under ${COMPRESSION_THRESHOLD_MB}MB, skipping compression`);
    // Copy the file instead of compressing
    const copyCmd = `cp "${inputPath}" "${outputPath}"`;
    console.log(`File size under ${COMPRESSION_THRESHOLD_MB}MB, copying without compression...`);
    await execAsync(copyCmd);
    return;
  }

  // Improved compression settings for better quality
  // Using slower preset for better compression efficiency
  // Lower CRF value for better quality (23 is visually lossless, 28 is good quality)
  // Higher bitrate for better quality
  const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -crf 23 -vf scale=720:-2 -b:v 1000k -c:a aac -b:a 128k -ac 2 "${outputPath}"`;
  
  console.log('Compressing video for WhatsApp with improved quality (medium preset, H.264, 720p)...');
  return new Promise((resolve, reject) => {
    const proc = exec(cmd);
    let startTime = Date.now();
    let lastPercent = '';
    let lastPercentNotified = 0;
    const notifyStep = 20;
    let totalSeconds = 0;
    
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`, (err, stdout) => {
      if (!err && stdout) {
        totalSeconds = parseFloat(stdout.trim());
      }
    });
    
    const logInterval = setInterval(() => {}, 1000) as unknown as NodeJS.Timeout;
    proc.stderr?.on('data', async (data: Buffer) => {
      const line = data.toString();
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && totalSeconds > 0) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseFloat(timeMatch[3]);
        const currentSeconds = hours * 3600 + minutes * 60 + seconds;
        const percent = ((currentSeconds / totalSeconds) * 100).toFixed(2);
        const percentInt = Math.floor((currentSeconds / totalSeconds) * 100);
        const elapsed = ((Date.now() - startTime) / 1000);
        const eta = ((totalSeconds - currentSeconds) / (currentSeconds / (elapsed || 1)));
        
        // Get current file size if file exists
        let currentFileSize = 'N/A';
        try {
          if (fs.existsSync(outputPath)) {
            currentFileSize = getFileSizeMB(outputPath);
          }
        } catch (error) {
          // File size check failed, keep as "N/A"
        }
        
        if (percent !== lastPercent) {
          process.stdout.write(`\r[Compression] Progress: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta.toFixed(1)}s | Size: ${currentFileSize}   `);
          lastPercent = percent;
        }
        if (percentInt >= lastPercentNotified + notifyStep) {
          lastPercentNotified += notifyStep;
          if (lastPercentNotified <= 100) {
            await sendMessage(
              MY_NUMBER,
              episodeName,
              `${progressMessage}\n(${lastPercentNotified}%, Elapsed: ${formatDuration(elapsed)}, ETA: ${formatDuration(eta)}, Size: ${currentFileSize})`
            );
          }
        }
      }
    });
    proc.on('close', (code: number) => {
      clearInterval(logInterval);
      process.stdout.write('\n');
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg compression exited with code ${code}`));
      }
    });
  });
} 