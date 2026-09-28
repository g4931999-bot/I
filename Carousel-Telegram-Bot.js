
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const { getDb } = require('./firebase');

const BOT_TOKEN = process.env.BOT_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tubepilot123';

if(!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if(!IG_USER_ID) throw new Error('IG_USER_ID missing');
if(!IG_ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN missing');

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// userId -> { photos: [], timer, state, title, caption }
const userSessions = new Map();

bot.start((ctx) => {
  const userId = ctx.from.id;
  userSessions.delete(userId);
  return ctx.reply(
    `🚀 TubePilot Carousel Bot Ready!\n\n` +
    `📸 Kaise use kare:\n` +
    `1. 2-10 photos ALBUM me bhejo\n` +
    `2. Fir mai TITLE puchunga\n` +
    `3. Fir CAPTION puchunga\n` +
    `4. Fir auto Instagram pe post ho jayega @tubepilot.app pe\n\n` +
    `Abhi 3 photos bhejo boss!`
  );
});

bot.help((ctx) => {
  ctx.reply('Bas photos bhejo, fir mai title aur caption puchunga!');
});

// Handle text - for title and caption
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);
  if (!session) return;

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return; // ignore commands

  if (session.state === 'awaiting_title') {
    session.title = text;
    session.state = 'awaiting_caption';
    console.log(`User ${userId} title: ${text}`);
    await ctx.reply(
      `✅ Title save ho gaya: "${text}"\n\n` +
      `📝 Ab CAPTION bhejo boss (hashtags ke saath):\n` +
      `Example: Ye mera naya design hai #viral #design`
    );
  } else if (session.state === 'awaiting_caption') {
    session.caption = text;
    console.log(`User ${userId} caption: ${text}`);
    await ctx.reply(`✅ Caption save! Ab post kar raha hoon...\n\nTitle: ${session.title}\nCaption: ${text}`);
    // Now post
    await processAndPost(userId, ctx);
  }
});

bot.on('photo', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const existing = userSessions.get(userId);
    
    // If already in title/caption flow, don't accept new photos
    if (existing && (existing.state === 'awaiting_title' || existing.state === 'awaiting_caption')) {
      await ctx.reply('⚠️ Pehle title/caption complete karo boss, ya /start se restart karo');
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const fileUrl = fileLink.href;

    console.log(`Photo received from ${userId}: ${fileUrl}`);

    if (!userSessions.has(userId)) {
      userSessions.set(userId, { photos: [], timer: null, state: 'collecting', title: '', caption: '' });
    }
    const session = userSessions.get(userId);
    if (session.state !== 'collecting') {
      session.photos = [];
      session.state = 'collecting';
    }
    session.photos.push(fileUrl);

    if (session.timer) clearTimeout(session.timer);

    const mediaGroupId = ctx.message.media_group_id;
    
    if (mediaGroupId) {
      session.timer = setTimeout(() => askForTitle(userId, ctx), 3000);
      if (session.photos.length === 1) {
        ctx.reply(`📸 ${session.photos.length} photo mili, aur bhejo...`);
      }
    } else {
      if (session.photos.length === 1) {
        ctx.reply(`📸 Photo 1 mili! Aur photos hai to 10 sec me bhejo`);
      } else {
        ctx.reply(`📸 Photo ${session.photos.length} mili!`);
      }
      session.timer = setTimeout(() => askForTitle(userId, ctx), 10000);
    }

  } catch (e) {
    console.error('Photo handler error:', e);
    ctx.reply('❌ Error: ' + e.message);
  }
});

async function askForTitle(userId, ctx) {
  const session = userSessions.get(userId);
  if (!session || session.photos.length === 0) return;
  
  session.state = 'awaiting_title';
  console.log(`Asking title for user ${userId}, ${session.photos.length} photos`);
  
  await ctx.reply(
    `✅ ${session.photos.length} photos collect ho gayi!\n\n` +
    `✏️ Ab TITLE bhejo boss:\n` +
    `Example: My New Design`
  );
}

async function processAndPost(userId, ctx) {
  const session = userSessions.get(userId);
  if (!session) return;

  const photos = [...session.photos];
  const title = session.title || '';
  const captionInput = session.caption || '';
  
  // Clear session immediately - temporary storage
  userSessions.delete(userId);

  if (photos.length === 0) {
    await ctx.reply('❌ Photos nahi mili, /start se fir se bhejo');
    return;
  }

  try {
    const finalCaption = `${title}\n\n${captionInput}\n\n🚀 Posted via TubePilot Bot`;

    await ctx.reply(`🔄 ${photos.length} photos se ${photos.length > 1 ? 'Carousel' : 'Single'} bana raha hoon...`);

    // Step 1: Create containers
    const containerIds = [];
    for (let i = 0; i < photos.length; i++) {
      const url = photos[i];
      console.log(`Creating container ${i+1}/${photos.length}: ${url}`);
      
      const res = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, null, {
        params: {
          image_url: url,
          is_carousel_item: photos.length > 1 ? true : undefined,
          access_token: IG_ACCESS_TOKEN
        }
      });
      console.log(`Container ${i+1} created:`, res.data.id);
      containerIds.push(res.data.id);
      
      await new Promise(r => setTimeout(r, 1500));
    }

    // Step 2: Create carousel or single
    let creationId;
    if (photos.length > 1) {
      const res = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, null, {
        params: {
          media_type: 'CAROUSEL',
          children: containerIds.join(','),
          caption: finalCaption,
          access_token: IG_ACCESS_TOKEN
        }
      });
      creationId = res.data.id;
    } else {
      creationId = containerIds[0];
      await axios.post(`https://graph.facebook.com/v20.0/${creationId}`, null, {
        params: {
          caption: finalCaption,
          access_token: IG_ACCESS_TOKEN
        }
      });
    }

    console.log('Creation ID:', creationId);
    await ctx.reply(`⏳ Container ban gaya, publish kar raha hoon...`);
    await new Promise(r => setTimeout(r, 5000));

    // Step 3: Publish
    const publishRes = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media_publish`, null, {
      params: {
        creation_id: creationId,
        access_token: IG_ACCESS_TOKEN
      }
    });

    console.log('Published:', publishRes.data);
    await ctx.reply(`✅ Posted Successfully! 🎉\n\nTitle: ${title}\nhttps://www.instagram.com/p/${publishRes.data.id}/\n\n🗑️ Images delete ho gayi, temporary storage clear!`);

    // Save to Firebase TEMPORARILY then delete after 2 minutes
    try {
      const db = getDb();
      const safeUsername = ctx.from.username || ctx.from.first_name || String(userId);
      const docRef = await db.collection('telegram_uploads').add({
        userId: userId,
        username: safeUsername,
        firstName: ctx.from.first_name || '',
        title: title,
        caption: captionInput,
        photoCount: photos.length,
        // Don't save actual URLs permanently - only temporary
        igMediaId: publishRes.data.id,
        status: 'posted',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 2*60*1000) // 2 min expiry marker
      });
      console.log('Temp Firebase saved:', docRef.id);
      
      // Auto delete after 2 minutes - temporary only
      setTimeout(async () => {
        try {
          await docRef.delete();
          console.log(`Temp doc ${docRef.id} deleted after post`);
        } catch (e) {
          console.log('Temp delete error:', e.message);
        }
      }, 2*60*1000);

    } catch (fbErr) {
      console.error('Firebase save error:', fbErr.message);
    }

    // Clear photos from memory - already deleted via userSessions.delete

  } catch (e) {
    console.error('Publish error:', e.response?.data || e.message);
    const errMsg = e.response?.data?.error?.message || e.message;
    await ctx.reply(`❌ Post Fail: ${errMsg}\n\nFir se /start karke try karo boss`);
    userSessions.delete(userId); // cleanup on error too
  }
}

// --- Express ---
app.get('/', (req, res) => {
  res.send('TubePilot Bot Running 🚀 - Title+Caption Mode');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`Webhook verify: ${mode} ${token}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  console.log('Webhook POST:', JSON.stringify(req.body).substring(0, 200));
  res.status(200).send('EVENT_RECEIVED');
});

app.get('/auth/instagram/callback', (req, res) => res.send('Instagram Auth Callback OK'));
app.get('/auth/deauthorize', (req, res) => res.send('Deauthorize OK'));
app.get('/auth/data-deletion', (req, res) => res.send('Data Deletion OK'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Express running on ${PORT}`);
});

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('Telegram Bot started - Title+Caption Mode Ready');
}).catch(err => {
  console.error('Bot launch error:', err.message);
  setTimeout(() => bot.launch({ dropPendingUpdates: true }), 5000);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
