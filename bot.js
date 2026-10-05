const fs = require('fs');
const { execSync } = require('child_process');
const http = require('http');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@rexxhayanasi/elaina-baileys');
const pino = require('pino');
const axios = require('axios');

// === Auto-extract session on first run (needed for Render) ===
if (!fs.existsSync('./auth_info') && fs.existsSync('./auth_info.tar.gz')) {
  console.log('📦 Extracting auth_info.tar.gz...');
  try {
    execSync('tar -xzf auth_info.tar.gz');
    console.log('✅ Extracted.');
  } catch (e) {
    console.log('❌ Extract failed:', e.message);
  }
}

// === Health check server (keeps Render happy) ===
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log('✅ Health server on port ' + PORT));

const OWNER_NUMBER = '233206391674';
const awaitingLink = {};
const DELAY = 10000;

function extractChannelLink(msg) {
  const text = msg.message.conversation ||
               (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
  let m = text.match(/(https?:\/\/)?(whatsapp\.com|chat\.whatsapp\.com|wa\.me)\/[^\s]+/i);
  if (m) return { link: m[0].startsWith('http') ? m[0] : 'https://' + m[0], text: text };
  const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
  if (ctx) {
    if (ctx.canonicalUrl) return { link: ctx.canonicalUrl, text: text };
    if (ctx.externalAdReply && ctx.externalAdReply.sourceUrl) return { link: ctx.externalAdReply.sourceUrl, text: text };
  }
  return null;
}

async function fetchChannelPreview(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 20000
    });
    const html = res.data;
    const out = {};
    let m = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (m) out.title = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
    m = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (m) out.description = m[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
    m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (m) out.image = m[1].replace(/&amp;/g, '&');
    return out;
  } catch (e) {
    console.log('Fetch failed: ' + e.message);
    return null;
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  // === PAIRING CODE (only if not registered) ===
  if (!sock.authState.creds.registered) {
    console.log('⏳ Requesting pairing code in 3 seconds...');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log('');
        console.log('========================================');
        console.log('🔑 YOUR PAIRING CODE: ' + code);
        console.log('========================================');
        console.log('👉 Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead');
        console.log('');
      } catch (err) {
        console.log('❌ Error getting code: ' + err.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === 'connecting') console.log('Connecting...');
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
      console.log('Closed. Code: ' + code);
      if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 8000);
    }
    if (connection === 'open') console.log('✅ Bot connected!');
  });

  let cachedPreview = null;

  async function prepareLinkPreview(channelLink) {
    if (cachedPreview && cachedPreview.link === channelLink) return cachedPreview;
    console.log('Fetching preview data...');
    const data = await fetchChannelPreview(channelLink);
    if (!data || !data.title) {
      console.log('No preview data available');
      return null;
    }
    console.log('Title: ' + data.title);

    let thumbBuffer = null;
    if (data.image) {
      try {
        const imgRes = await axios.get(data.image, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        thumbBuffer = Buffer.from(imgRes.data);
        console.log('Thumbnail: ' + thumbBuffer.length + ' bytes');
      } catch (e) {
        console.log('Thumb download failed: ' + e.message);
      }
    }

    cachedPreview = {
      link: channelLink,
      title: data.title,
      description: data.description || '',
      thumb: thumbBuffer
    };
    return cachedPreview;
  }

  // === Send as a REGULAR message (with link preview) ===
  async function sendMessageToGroup(jid, channelLink, extraText, preview) {
    try {
      const fullText = extraText ? (extraText + '\n' + channelLink) : channelLink;
      let options = { text: fullText };

      if (preview && preview.thumb) {
        options.linkPreview = {
          'canonical-url': channelLink,
          'matched-text': channelLink,
          title: preview.title,
          description: preview.description,
          jpegThumbnail: preview.thumb,
          'preview-type': 0
        };
      }

      await sock.sendMessage(jid, options);
      console.log('Message sent to ' + jid);
      return true;
    } catch (e) {
      console.log('Message failed ' + jid + ': ' + e.message);
      return false;
    }
  }

  // === Send as a GROUP STATUS (with preview card via externalAdReply) ===
  async function sendStatusToGroup(jid, channelLink, extraText, preview) {
    try {
      const fullText = extraText ? (extraText + '\n' + channelLink) : channelLink;

      let options = {
        text: fullText,
        groupStatus: true // This wraps the message as a group status
      };

      // Attach the preview card data
      if (preview && preview.thumb) {
        options.externalAdReply = {
          title: preview.title,
          body: preview.description || 'Tap to view channel',
          mediaType: 1,
          thumbnail: preview.thumb, // Must be a Buffer
          sourceUrl: channelLink,
          mediaUrl: channelLink,
          showAdAttribution: false,
          largeThumbnail: false
        };
      }

      await sock.sendMessage(jid, options);
      console.log('Status posted to ' + jid);
      return true;
    } catch (e) {
      console.log('Status failed ' + jid + ': ' + e.message);
      return false;
    }
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    if (!from.endsWith('@g.us')) return;

    const text = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
    const t = text.trim().toLowerCase();

    // === Command handlers ===
    if (t === '.send') {
      if (!msg.key.fromMe) return;
      awaitingLink[from] = 'message-one';
      await sock.sendMessage(from, { text: 'Send your channel link for a single group message.' }, { quoted: msg });
      return;
    }
    if (t === '.sendall') {
      if (!msg.key.fromMe) return;
      awaitingLink[from] = 'message-all';
      await sock.sendMessage(from, { text: 'Send your channel link to broadcast as a message to all groups.' }, { quoted: msg });
      return;
    }
    if (t === '.status') {
      if (!msg.key.fromMe) return;
      awaitingLink[from] = 'status-one';
      await sock.sendMessage(from, { text: 'Send your channel link to post as a status in this group.' }, { quoted: msg });
      return;
    }
    if (t === '.statusall') {
      if (!msg.key.fromMe) return;
      awaitingLink[from] = 'status-all';
      await sock.sendMessage(from, { text: 'Send your channel link to post as a status in all groups.' }, { quoted: msg });
      return;
    }

    // === Handle received link ===
    if (awaitingLink[from]) {
      const mode = awaitingLink[from];
      const info = extractChannelLink(msg);

      if (!info) {
        await sock.sendMessage(from, { text: 'No channel link found. Try again.' }, { quoted: msg });
        return;
      }
      delete awaitingLink[from];
      console.log('Found link: ' + info.link);

      const extraText = info.text.replace(info.link, '').trim();
      const preview = await prepareLinkPreview(info.link);

      // --- Single group ---
      if (mode === 'message-one') {
        const ok = await sendMessageToGroup(from, info.link, extraText, preview);
        await sock.sendMessage(from, { text: ok ? '✅ Sent!' : '❌ Failed.' }, { quoted: msg });
        return;
      }
      if (mode === 'status-one') {
        const ok = await sendStatusToGroup(from, info.link, extraText, preview);
        await sock.sendMessage(from, { text: ok ? '✅ Status posted!' : '❌ Failed.' }, { quoted: msg });
        return;
      }

      // --- All groups ---
      const groups = await sock.groupFetchAllParticipating();
      const ids = Object.keys(groups);
      const isStatus = mode === 'status-all';
      const actionName = isStatus ? 'status' : 'message';
      console.log(`Broadcasting ${actionName} to ${ids.length} groups...`);
      await sock.sendMessage(from, { text: `📤 Posting ${actionName} to ${ids.length} groups...` }, { quoted: msg });

      let s = 0, f = 0;
      for (const g of ids) {
        const ok = isStatus
          ? await sendStatusToGroup(g, info.link, extraText, preview)
          : await sendMessageToGroup(g, info.link, extraText, preview);
        if (ok) s++; else f++;
        if (DELAY > 0) await new Promise(r => setTimeout(r, DELAY));
      }
      await sock.sendMessage(from, { text: `✅ Done. Success: ${s}, Failed: ${f}` }, { quoted: msg });
    }
  });
}

console.log('Starting bot...');
startBot();
