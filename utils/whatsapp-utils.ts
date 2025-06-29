import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
const qrcode = require('qrcode-terminal');
import fs from 'fs';
import path from 'path';

// Use a persistent session folder for WhatsApp authentication
// Do NOT delete the .wwebjs_auth folder if you want to keep your session and avoid scanning the QR code every time
const SESSION_PATH = './.wwebjs_auth';
const CACHE_PATH = './.wwebjs_cache';

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