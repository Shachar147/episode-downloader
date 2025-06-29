import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
const qrcode = require('qrcode-terminal');
import fs from 'fs';
import fsSync from 'fs';
import { getFileInfo, isFileLargerThan } from './file-utils';

// Use a persistent session folder for WhatsApp authentication
// Do NOT delete the .wwebjs_auth folder if you want to keep your session and avoid scanning the QR code every time
const SESSION_PATH = './.wwebjs_auth';

// Check if session files exist
function sessionExists(): boolean {
  try {
    return fs.existsSync(SESSION_PATH) && fs.readdirSync(SESSION_PATH).length > 0;
  } catch (error) {
    console.log('Session check failed:', error);
    return false;
  }
}

// Try to restore existing session
async function tryRestoreSession(): Promise<boolean> {
  if (!sessionExists()) {
    console.log('📁 No session files found, cannot restore');
    return false;
  }

  try {
    console.log('🔄 Attempting to restore existing session...');
    
    // Check if session files are valid
    const sessionFiles = fs.readdirSync(SESSION_PATH);
    console.log('📄 Found session files:', sessionFiles);
    
    // Check for key session files
    const hasSessionData = sessionFiles.some(file => 
      file.includes('session') || file.includes('auth') || file.includes('state')
    );
    
    if (!hasSessionData) {
      console.log('⚠️ Session files exist but appear to be invalid');
      return false;
    }
    
    console.log('✅ Session files appear valid, proceeding with restoration');
    return true;
  } catch (error) {
    console.log('❌ Error checking session files:', error);
    return false;
  }
}

export const whatsappClient = new Client({ 
  authStrategy: new LocalAuth({ 
    dataPath: SESSION_PATH,
    clientId: 'episode-downloader'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

let whatsappReady = false;
let messageQueue: { number: string, message: string }[] = [];

whatsappClient.on('qr', (qr: string) => {
    console.log('Scan this QR code to connect WhatsApp:');
    if (sessionExists()) {
      console.log('⚠️  Session files exist but QR code requested - session may have expired');
    }
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    whatsappReady = true;
    console.log('✅ WhatsApp client is ready!');
    console.log('📱 Session saved to:', SESSION_PATH);
    
    // Send any queued messages
    for (const { number, message } of messageQueue) {
        whatsappClient.sendMessage(`${number}@c.us`, message);
    }
    messageQueue = [];
});

whatsappClient.on('auth_failure', (msg: string) => {
    console.log('❌ WhatsApp authentication failed:', msg);
    console.log('🗑️  Consider deleting the session folder and trying again');
    whatsappReady = false;
});

whatsappClient.on('disconnected', (reason: string) => {
    console.log('🔌 WhatsApp client disconnected:', reason);
    whatsappReady = false;
});

whatsappClient.on('loading_screen', (percent: string, message: string) => {
    console.log(`📱 Loading WhatsApp: ${percent}% - ${message}`);
});

// Initialize WhatsApp client with session restoration
async function initializeWhatsApp() {
  console.log('🚀 Initializing WhatsApp client...');
  
  const canRestore = await tryRestoreSession();
  
  if (canRestore) {
    console.log('📁 Found existing session files, attempting to restore...');
  } else {
    console.log('📁 No existing session found, will require QR code scan');
  }
  
  whatsappClient.initialize();
}

// Start the initialization
initializeWhatsApp();

export const sendMessage = async (MY_NUMBER: string | undefined, episodeName: string, message:string) => MY_NUMBER && await sendWhatsAppMessage(MY_NUMBER, `*[${episodeName}]*\n${message}`);

export async function sendWhatsAppMessage(number: string, message: string): Promise<any> {
    if (!whatsappReady) {
        messageQueue.push({ number, message });
        console.log('⏳ WhatsApp client not ready yet. Queuing message:', message);
        return;
    }
    try {
        console.log(`📤 Attempting to send WhatsApp message to ${number}@c.us:`, message);
        const result = await whatsappClient.sendMessage(`${number}@c.us`, message);
        console.log('✅ WhatsApp message sent successfully. Message ID:', result.id._serialized);
        return result;
    } catch (error: any) {
        console.error('❌ Failed to send WhatsApp message:', error.message);
        console.error('Error details:', error);
        throw error;
    }
}

export async function waitForWhatsAppReady(timeout = 60000): Promise<boolean> {
    const startTime = Date.now();
    while (!whatsappReady && (Date.now() - startTime) < timeout) {
        console.log('⏳ Waiting for WhatsApp client to be ready...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!whatsappReady) {
        console.log('⏰ WhatsApp client not ready after timeout, continuing anyway...');
    }
    return whatsappReady;
}

export async function checkWhatsAppSession(): Promise<boolean> {
    try {
        console.log('🔍 Checking WhatsApp Web session status...');
        const info = await whatsappClient.getState();
        console.log('📊 WhatsApp session state:', info);
        return info === 'CONNECTED';
    } catch (error) {
        console.error('❌ Error checking WhatsApp session:', error);
        return false;
    }
}

export async function refreshWhatsAppSession(): Promise<boolean> {
    try {
        console.log('🔄 Attempting to refresh WhatsApp Web session...');
        await whatsappClient.logout();
        await new Promise(resolve => setTimeout(resolve, 2000));
        await whatsappClient.initialize();
        console.log('✅ WhatsApp session refresh initiated');
        return true;
    } catch (error) {
        console.error('❌ Failed to refresh WhatsApp session:', error);
        return false;
    }
}

export async function sendVideoViaWhatsApp(
  compressedPath: string, 
  episodeName: string, 
  MY_NUMBER: string
): Promise<void> {
  try {
    const fileInfo = getFileInfo(compressedPath);
    
    if (isFileLargerThan(compressedPath, 95)) { // WhatsApp limit is ~100MB, use 95MB for safety
      await sendMessage(MY_NUMBER, episodeName, `Compressed file is too big to send on WhatsApp:\n📁 File: ${fileInfo.name}\n📊 Size: ${fileInfo.size}\n⚠️ WhatsApp limit: ~100MB`);
      return;
    }
    
    // Add retry logic for WhatsApp media sending
    let retryCount = 0;
    const maxRetries = 3;
    let success = false;
    
    while (retryCount < maxRetries && !success) {
      try {
        if (retryCount > 0) {
          console.log(`Retry attempt ${retryCount} for WhatsApp media sending...`);
          await sendMessage(MY_NUMBER, episodeName, `Retry attempt ${retryCount} for sending video...`);
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        else {
            await sendMessage(MY_NUMBER, episodeName, `Sending compressed video via WhatsApp (size: ${fileInfo.size})...`);
        }
        
        // Check if file still exists and is readable
        if (!fsSync.existsSync(compressedPath)) {
          throw new Error('Compressed file no longer exists');
        }
        
        // Check WhatsApp session status before attempting to send
        const sessionValid = await checkWhatsAppSession();
        if (!sessionValid && retryCount === 1) {
          console.log('Session appears invalid, attempting to refresh...');
          await refreshWhatsAppSession();
          // Wait for session to be ready again
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
        
        console.log('Creating MessageMedia object...');
        const media = await MessageMedia.fromFilePath(compressedPath);
        console.log('MessageMedia created successfully, mimeType:', media.mimetype, 'data length:', media.data.length);
        
        // Try different approaches for sending
        let result;
        if (retryCount === 0) {
          // First attempt: standard method
          console.log('Attempting standard media send...');
          result = await whatsappClient.sendMessage(`${MY_NUMBER}@c.us`, media, { caption: `[${episodeName}] Compressed video` });
        } else if (retryCount === 1) {
          // Second attempt: without caption
          console.log('Attempting media send without caption...');
          result = await whatsappClient.sendMessage(`${MY_NUMBER}@c.us`, media);
        } else {
          // Third attempt: send as document
          console.log('Attempting to send as document...');
          result = await whatsappClient.sendMessage(`${MY_NUMBER}@c.us`, media, { 
            sendMediaAsDocument: true,
            caption: `[${episodeName}] Compressed video`
          });
        }
        
        console.log('WhatsApp media sent successfully:', result.id._serialized);
        success = true;
        
      } catch (sendError: any) {
        retryCount++;
        console.error(`WhatsApp send attempt ${retryCount} failed:`);
        console.error('Error name:', sendError.name);
        console.error('Error message:', sendError.message);
        console.error('Error stack:', sendError.stack);
        
        // Try to get more details about the error
        if (sendError.message && sendError.message.includes('Evaluation failed')) {
          console.error('This appears to be a browser evaluation error - possible causes:');
          console.error('- WhatsApp Web session expired');
          console.error('- File too large or corrupted');
          console.error('- Network connectivity issues');
          console.error('- Browser automation timeout');
        }
        
        if (retryCount >= maxRetries) {
          throw new Error(`Failed to send media after ${maxRetries} attempts. Last error: ${sendError.name}: ${sendError.message}`);
        }
        
        // Wait longer between retries
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  } catch (err: any) {
    console.error('WhatsApp send error:', err);
    await sendMessage(MY_NUMBER, episodeName, `WhatsApp sending failed: ${err.message || err}`);
    
    // Try to send a fallback message with file info
    try {
      const fileInfo = getFileInfo(compressedPath);
      await sendMessage(MY_NUMBER, episodeName, `Video file ready but couldn't send via WhatsApp:\n📁 File: ${fileInfo.name}\n📊 Size: ${fileInfo.size}\n📂 Location: ${compressedPath}`);
    } catch (fallbackErr) {
      console.error('Fallback message also failed:', fallbackErr);
    }
  }
} 