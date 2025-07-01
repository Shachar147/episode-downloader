import { sendTelegramMessage } from './telegram-utils';
import { sendWhatsAppMessage } from './whatsapp-utils';

export enum MessageTunnel {
  WHATSAPP = 'whatsapp',
  TELEGRAM = 'telegram',
}

export const MESSAGE_TUNNEL = (process.env.MESSAGE_TUNNEL as MessageTunnel) || MessageTunnel.TELEGRAM;

/**
 * Unified sendMessage function for all messaging tunnels.
 * @param message - The message to send
 * @param numberOrChatId - WhatsApp number or Telegram chat ID (optional, for future extensibility)
 */
export async function sendMessage(message: string): Promise<void> {
  if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
    const MY_NUMBER = process.env.MY_WHATSAPP_NUMBER;

    // If WhatsApp, require a number
    if (!MY_NUMBER) throw new Error('WhatsApp number is required for WhatsApp tunnel');
    await sendWhatsAppMessage(MY_NUMBER, message);
  } else if (MESSAGE_TUNNEL === MessageTunnel.TELEGRAM) {
    await sendTelegramMessage(message);
  } else {
    throw new Error(`Unknown MESSAGE_TUNNEL: ${MESSAGE_TUNNEL}`);
  }
} 