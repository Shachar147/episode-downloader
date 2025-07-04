import { exec } from 'child_process';
import { promisify } from 'util';
import { formatDuration } from './time-utils';
import { getFileSizeMB } from './file-utils';
import fs from 'fs';
import { sendMessage } from './messaging-utils';

const execAsync = promisify(exec);

export async function muxSubtitles(
  videoPath: string,
  srtPath: string,
  outputPath: string,
  mergeMessage: string,
  MY_NUMBER: string,
  episodeName: string
): Promise<void> {
  const getDurationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
  let totalSeconds = 0;
  try {
    const { stdout } = await execAsync(getDurationCmd);
    totalSeconds = parseFloat(stdout.trim());
  } catch (e) {
    console.warn('Could not determine video duration for progress calculation.');
  }
  const cmd = `ffmpeg -y -i "${videoPath}" -vf subtitles='${srtPath.replace(/'/g, "'\\''")}' -c:v libx264 -c:a copy "${outputPath}"`;
  console.log('Merging video and subtitles using ffmpeg…');
  return new Promise((resolve, reject) => {
    const proc = exec(cmd);
    let startTime = Date.now();
    let lastPercent = '';
    let lastPercentNotified = 0;
    const notifyStep = 20;
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
          process.stdout.write(`\rProgress: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta.toFixed(1)}s | Size: ${currentFileSize}   `);
          lastPercent = percent;
        }
        if (percentInt >= lastPercentNotified + notifyStep) {
          lastPercentNotified += notifyStep;
          if (lastPercentNotified <= 100) {
            await sendMessage(
              `${mergeMessage}\n(${lastPercentNotified}% ,Elapsed: ${formatDuration(elapsed)}, ETA: ${formatDuration(eta)}, Size: ${currentFileSize})`
            );
          }
        }
      }
    });
    proc.on('close', (code: number) => {
      clearInterval(logInterval);
      process.stdout.write('\n');
      if (code === 0) {
        console.log('Muxing complete →', outputPath);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
} 