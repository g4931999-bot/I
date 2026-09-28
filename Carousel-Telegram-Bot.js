
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
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

const userSessions = new Map(); // userId -> { photos, videos, timer, state, title, caption, mediaType }

const DEFAULT_POST_TIME = '18:00'; // 6 PM IST

// --- Helper: Get IST Time ---
function getISTTime() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + istOffset);
}

function parseTimeString(timeStr) {
  // Supports: 18:00, 6:00, 6:00 PM, 18:00 PM, 06:00
  let str = timeStr.trim().toUpperCase();
  let isPM = str.includes('PM');
  let isAM = str.includes('AM');
  str = str.replace(/AM|PM/g, '').trim();
  
  let [h, m] = str.split(':').map(Number);
  if (isNaN(h)) return null;
  if (isNaN(m)) m = 0;
  
  if (isPM && h < 12) h += 12;
  if (isAM && h === 12) h = 0;
  
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  
  return { hour: h, minute: m, formatted: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` };
}

async function getUserPostingTime(userId) {
  try {
    const db = getDb();
    const doc = await db.collection('user_settings').doc(String(userId)).get();
    if (doc.exists && doc.data().postingTime) {
      return doc.data().postingTime;
    }
  } catch(e) { console.log('getUserTime error', e.message); }
  return DEFAULT_POST_TIME;
}

async function setUserPostingTime(userId, timeStr) {
  const db = getDb();
  await db.collection('user_settings').doc(String(userId)).set({
    postingTime: timeStr,
    updatedAt: new Date(),
    timezone: 'Asia/Kolkata'
  }, { merge: true });
}

function getNextScheduledDate(timeStr) {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  
  const nowIST = getISTTime();
  let scheduled = new Date(nowIST);
  scheduled.setHours(parsed.hour, parsed.minute, 0, 0);
  
  // If time already passed today, schedule for tomorrow
  if (scheduled <= nowIST) {
    scheduled.setDate(scheduled.getDate() + 1);
  }
  return scheduled;
}

// --- Commands ---
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  userSessions.delete(userId);
  const postingTime = await getUserPostingTime(userId);
  
  return ctx.reply(
    `🚀 TubePilot 6PM Scheduler Bot Ready!\n\n` +
    `📸 Flow:\n` +
    `1. Photo (2-10) ya Reel (video) bhejo\n` +
    `2. Title bhejoge\n` +
    `3. Caption bhejoge\n` +
    `4. Auto ${postingTime} baje (IST) post hoga! 🕕\n\n` +
    `⚙️ Special Commands:\n` +
    `/settime 18:00 - Posting time change karo\n` +
    `/mytime - Current posting time dekho\n` +
    `/schedule - Pending posts dekho\n` +
    `/postnow - Abhi turant post karo\n` +
    `/immediate - Turant post mode ON/OFF\n` +
    `/cancel - Cancel karo\n\n` +
    `Abhi photo/video bhejo boss!`
  );
});

bot.command('settime', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ');
  if (!args) {
    return ctx.reply('❌ Format: /settime 18:00\nExample: /settime 18:00 ya /settime 6:00 PM\nDefault 6 PM hai');
  }
  
  const parsed = parseTimeString(args);
  if (!parsed) {
    return ctx.reply('❌ Galat time format boss! Sahi format: 18:00 ya 6:00 PM');
  }
  
  await setUserPostingTime(ctx.from.id, parsed.formatted);
  await ctx.reply(`✅ Posting time set ho gaya: ${parsed.formatted} IST (6 baje shaam default tha)\n\nAb se saare posts ${parsed.formatted} baje auto post honge!`);
  console.log(`User ${ctx.from.id} set time to ${parsed.formatted}`);
});

bot.command('mytime', async (ctx) => {
  const time = await getUserPostingTime(ctx.from.id);
  const next = getNextScheduledDate(time);
  await ctx.reply(`🕕 Tumhara posting time: ${time} IST\n📅 Agla post: ${next.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\nChange karna hai to: /settime 18:00`);
});

bot.command('schedule', async (ctx) => {
  try {
    const db = getDb();
    const snap = await db.collection('scheduled_posts').where('userId', '==', ctx.from.id).where('status', '==', 'pending').get();
    
    if (snap.empty) {
      return ctx.reply('📭 Koi pending post nahi hai boss!');
    }
    
    let msg = `📅 Pending Posts (${snap.size}):\n\n`;
    snap.forEach((doc, i) => {
      const d = doc.data();
      const schedDate = d.scheduledAt.toDate ? d.scheduledAt.toDate() : new Date(d.scheduledAt);
      msg += `${i+1}. ${d.title || 'No title'} - ${d.mediaType} - ${schedDate.toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n`;
    });
    msg += '\n/postnow se turant post kar sakte ho';
    ctx.reply(msg);
  } catch(e) {
    ctx.reply('Error: ' + e.message);
  }
});

bot.command('postnow', async (ctx) => {
  await ctx.reply('⚡ Saare pending posts abhi post kar raha hoon...');
  await processPendingPosts(ctx.from.id, ctx);
});

bot.command('cancel', async (ctx) => {
  userSessions.delete(ctx.from.id);
  await ctx.reply('❌ Cancel ho gaya! /start se restart karo');
});

bot.command('immediate', async (ctx) => {
  try {
    const db = getDb();
    const doc = await db.collection('user_settings').doc(String(ctx.from.id)).get();
    const currentMode = doc.exists ? doc.data().immediateMode : false;
    const newMode = !currentMode;
    
    await db.collection('user_settings').doc(String(ctx.from.id)).set({
      immediateMode: newMode,
      updatedAt: new Date()
    }, { merge: true });
    
    if (newMode) {
      ctx.reply('⚡ Immediate Mode ON! Ab photo bhejte hi turant post hoga, 6 PM ka wait nahi karega.\nBand karna hai to fir se /immediate bhejo');
    } else {
      const time = await getUserPostingTime(ctx.from.id);
      ctx.reply(`🕕 Scheduler Mode ON! Ab posts ${time} baje post honge. Turant chahiye to /immediate ya /postnow`);
    }
  } catch(e) { ctx.reply('Error: '+e.message); }
});

// Handle text - for title and caption
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);
  if (!session) return;

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (session.state === 'awaiting_title') {
    session.title = text;
    session.state = 'awaiting_caption';
    console.log(`User ${userId} title: ${text}`);
    await ctx.reply(
      `✅ Title: "${text}"\n\n` +
      `📝 Ab CAPTION bhejo boss:\n` +
      `Example: Ye mera naya design hai #viral`
    );
  } else if (session.state === 'awaiting_caption') {
    session.caption = text;
    console.log(`User ${userId} caption: ${text}`);
    await schedulePost(userId, ctx);
  }
});

async function handleMedia(fileUrl, userId, ctx, mediaType) {
  const existing = userSessions.get(userId);
  if (existing && (existing.state === 'awaiting_title' || existing.state === 'awaiting_caption')) {
    await ctx.reply('⚠️ Pehle title/caption complete karo boss, ya /cancel karo');
    return;
  }

  if (!userSessions.has(userId)) {
    userSessions.set(userId, { photos: [], videos: [], timer: null, state: 'collecting', title: '', caption: '', mediaType: mediaType });
  }
  const session = userSessions.get(userId);
  
  // If switching from photo to video or vice versa, reset
  if (session.mediaType !== mediaType && (session.photos.length > 0 || session.videos.length > 0)) {
    session.photos = [];
    session.videos = [];
  }
  session.mediaType = mediaType;
  
  if (mediaType === 'video') {
    session.videos = [fileUrl]; // only 1 reel at a time
  } else {
    if (session.state !== 'collecting') {
      session.photos = [];
      session.state = 'collecting';
    }
    session.photos.push(fileUrl);
  }

  if (session.timer) clearTimeout(session.timer);

  const mediaGroupId = ctx.message.media_group_id;
  
  if (mediaType === 'video') {
    session.timer = setTimeout(() => askForTitle(userId, ctx), 1000);
    ctx.reply(`🎬 Reel video mil gayi!`);
  } else if (mediaGroupId) {
    session.timer = setTimeout(() => askForTitle(userId, ctx), 3000);
    if (session.photos.length === 1) ctx.reply(`📸 ${session.photos.length} photo mili...`);
  } else {
    if (session.photos.length === 1) ctx.reply(`📸 Photo 1 mili! Aur hai to 10 sec me bhejo`);
    else ctx.reply(`📸 Photo ${session.photos.length} mili!`);
    session.timer = setTimeout(() => askForTitle(userId, ctx), 10000);
  }
}

bot.on('photo', async (ctx) => {
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    await handleMedia(fileLink.href, ctx.from.id, ctx, 'carousel');
  } catch (e) {
    console.error('Photo error:', e);
    ctx.reply('❌ Error: ' + e.message);
  }
});

bot.on('video', async (ctx) => {
  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.video.file_id);
    console.log(`Video received from ${ctx.from.id}: ${fileLink.href}`);
    await handleMedia(fileLink.href, ctx.from.id, ctx, 'reel');
  } catch (e) {
    console.error('Video error:', e);
    ctx.reply('❌ Video Error: ' + e.message);
  }
});

bot.on('document', async (ctx) => {
  // Allow video as document for reels
  if (ctx.message.document.mime_type && ctx.message.document.mime_type.startsWith('video/')) {
    try {
      const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      await handleMedia(fileLink.href, ctx.from.id, ctx, 'reel');
    } catch (e) { ctx.reply('❌ Error: '+e.message); }
  }
});

async function askForTitle(userId, ctx) {
  const session = userSessions.get(userId);
  if (!session) return;
  const count = session.mediaType === 'reel' ? session.videos.length : session.photos.length;
  if (count === 0) return;
  
  session.state = 'awaiting_title';
  await ctx.reply(
    `✅ ${count} ${session.mediaType === 'reel' ? 'Reel video' : 'photos'} collect ho gayi!\n\n` +
    `✏️ TITLE bhejo boss:`
  );
}

async function schedulePost(userId, ctx) {
  const session = userSessions.get(userId);
  if (!session) return;

  const db = getDb();
  const userSettingsDoc = await db.collection('user_settings').doc(String(userId)).get();
  const immediateMode = userSettingsDoc.exists ? userSettingsDoc.data().immediateMode : false;
  const postingTime = await getUserPostingTime(userId);
  
  if (immediateMode) {
    await ctx.reply(`⚡ Immediate Mode ON hai, abhi post kar raha hoon...`);
    await processAndPost(userId, ctx, true);
    return;
  }

  const scheduledDate = getNextScheduledDate(postingTime);
  const photos = [...session.photos];
  const videos = [...session.videos];
  
  // Save to scheduled_posts
  try {
    const safeUsername = ctx.from.username || ctx.from.first_name || String(userId);
    const docRef = await db.collection('scheduled_posts').add({
      userId: userId,
      username: safeUsername,
      title: session.title,
      caption: session.caption,
      photos: photos,
      videos: videos,
      mediaType: session.mediaType,
      postingTime: postingTime,
      scheduledAt: scheduledDate,
      status: 'pending',
      createdAt: new Date()
    });
    
    console.log(`Scheduled post ${docRef.id} for ${scheduledDate} IST`);
    
    userSessions.delete(userId);
    
    await ctx.reply(
      `✅ Schedule ho gaya boss! 🎉\n\n` +
      `📝 Title: ${session.title}\n` +
      `📅 Posting Time: ${scheduledDate.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', hour12: true})} IST\n` +
      `📦 Type: ${session.mediaType}\n\n` +
      `🕕 Roz ${postingTime} baje post hoga!\n` +
      `⚙️ Time change: /settime 19:00\n` +
      `⚡ Abhi post: /postnow\n` +
      `📋 List: /schedule\n\n` +
      `🗑️ Image memory se delete ho gayi, sirf schedule DB me hai!`
    );
    
  } catch(e) {
    console.error('Schedule error:', e);
    await ctx.reply('❌ Schedule fail: ' + e.message);
    userSessions.delete(userId);
  }
}

async function processAndPost(userId, ctxOrBot, isImmediate = false, postData = null) {
  let photos = [];
  let videos = [];
  let title = '';
  let captionInput = '';
  let mediaType = 'carousel';
  let session = null;
  
  if (postData) {
    // From scheduled cron
    photos = postData.photos || [];
    videos = postData.videos || [];
    title = postData.title || '';
    captionInput = postData.caption || '';
    mediaType = postData.mediaType || 'carousel';
  } else {
    session = userSessions.get(userId);
    if (!session) return;
    photos = [...session.photos];
    videos = [...session.videos];
    title = session.title || '';
    captionInput = session.caption || '';
    mediaType = session.mediaType || 'carousel';
    userSessions.delete(userId);
  }

  if (photos.length === 0 && videos.length === 0) {
    if (ctxOrBot && ctxOrBot.reply) await ctxOrBot.reply('❌ Media nahi mili');
    return;
  }

  try {
    const finalCaption = `${title}\n\n${captionInput}\n\n🚀 TubePilot`;
    let creationId;
    let publishId;

    if (mediaType === 'reel') {
      // REEL POSTING
      const videoUrl = videos[0];
      console.log(`Posting REEL: ${videoUrl}`);
      
      if (ctxOrBot && ctxOrBot.reply) await ctxOrBot.reply(`🎬 Reel upload kar raha hoon...`);
      
      const res = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media`, null, {
        params: {
          media_type: 'REELS',
          video_url: videoUrl,
          caption: finalCaption,
          access_token: IG_ACCESS_TOKEN
        }
      });
      creationId = res.data.id;
      console.log('Reel container:', creationId);
      
      if (ctxOrBot && ctxOrBot.reply) await ctxOrBot.reply(`⏳ Reel process ho raha hai, 30 sec lagega...`);
      
      // Wait for reel to be ready
      let ready = false;
      for (let i=0; i<10; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const statusRes = await axios.get(`https://graph.facebook.com/v20.0/${creationId}`, {
            params: { fields: 'status_code', access_token: IG_ACCESS_TOKEN }
          });
          console.log(`Reel status check ${i}:`, statusRes.data.status_code);
          if (statusRes.data.status_code === 'FINISHED') { ready = true; break; }
        } catch(e) { console.log('Status check error', e.message); }
      }
      
      if (!ready) console.log('Reel not finished but trying publish anyway');
      
    } else {
      // CAROUSEL / SINGLE IMAGE
      if (ctxOrBot && ctxOrBot.reply) await ctxOrBot.reply(`🔄 ${photos.length} photos se ${photos.length > 1 ? 'Carousel' : 'Single'} bana raha hoon...`);
      
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
          params: { caption: finalCaption, access_token: IG_ACCESS_TOKEN }
        });
      }
      
      console.log('Creation ID:', creationId);
      if (ctxOrBot && ctxOrBot.reply) await ctxOrBot.reply(`⏳ Publish kar raha hoon...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    // Publish
    const publishRes = await axios.post(`https://graph.facebook.com/v20.0/${IG_USER_ID}/media_publish`, null, {
      params: { creation_id: creationId, access_token: IG_ACCESS_TOKEN }
    });
    
    publishId = publishRes.data.id;
    console.log('Published:', publishRes.data);
    
    const successMsg = `✅ Posted Successfully! 🎉\n\nTitle: ${title}\nType: ${mediaType}\nhttps://www.instagram.com/p/${publishId}/\n\n🗑️ Temp data clear!`;
    
    if (ctxOrBot && ctxOrBot.reply) {
      await ctxOrBot.reply(successMsg);
    } else {
      // From cron - send via bot.telegram
      try {
        await bot.telegram.sendMessage(userId, successMsg);
      } catch(e) { console.log('Failed to notify user', e.message); }
    }

    // Delete temp scheduled doc if from cron
    if (postData && postData.docId) {
      try {
        const db = getDb();
        await db.collection('scheduled_posts').doc(postData.docId).update({ status: 'posted', postedAt: new Date(), igMediaId: publishId });
        // Delete after 5 min - temporary
        setTimeout(async () => {
          try { await db.collection('scheduled_posts').doc(postData.docId).delete(); console.log(`Temp scheduled ${postData.docId} deleted`); } catch(e){}
        }, 5*60*1000);
      } catch(e) { console.log('Update scheduled error', e.message); }
    }

  } catch (e) {
    console.error('Publish error:', e.response?.data || e.message);
    const errMsg = e.response?.data?.error?.message || e.message;
    if (ctxOrBot && ctxOrBot.reply) {
      await ctxOrBot.reply(`❌ Post Fail: ${errMsg}`);
    }
    // Mark failed in DB if scheduled
    if (postData && postData.docId) {
      try {
        const db = getDb();
        await db.collection('scheduled_posts').doc(postData.docId).update({ status: 'failed', error: errMsg });
      } catch(e){}
    }
    if (session) userSessions.delete(userId);
  }
}

// --- Cron Job: Check every minute for scheduled posts at 6 PM IST ---
cron.schedule('* * * * *', async () => {
  try {
    const nowIST = getISTTime();
    const currentHM = `${String(nowIST.getHours()).padStart(2,'0')}:${String(nowIST.getMinutes()).padStart(2,'0')}`;
    const currentDateStr = nowIST.toISOString().split('T')[0];
    
    // Only log every 15 min to avoid spam
    if (nowIST.getMinutes() % 15 === 0) {
      console.log(`[CRON] Checking schedule at ${currentHM} IST, Date: ${currentDateStr}`);
    }
    
    const db = getDb();
    const snap = await db.collection('scheduled_posts').where('status', '==', 'pending').get();
    
    if (snap.empty) return;
    
    for (const doc of snap.docs) {
      const data = doc.data();
      const scheduledAt = data.scheduledAt.toDate ? data.scheduledAt.toDate() : new Date(data.scheduledAt);
      
      // Convert scheduledAt to IST for comparison
      const scheduledIST = new Date(scheduledAt.toLocaleString('en-US', {timeZone: 'Asia/Kolkata'}));
      const scheduledHM = `${String(scheduledIST.getHours()).padStart(2,'0')}:${String(scheduledIST.getMinutes()).padStart(2,'0')}`;
      const scheduledDateStr = scheduledIST.toISOString().split('T')[0];
      
      // Check if scheduled time has passed (within last 10 minutes window to avoid duplicate)
      const diffMs = nowIST - scheduledAt;
      const diffMinutes = diffMs / (1000*60);
      
      if (diffMinutes >= 0 && diffMinutes < 10) {
        console.log(`[CRON] Posting scheduled ${doc.id} - Scheduled: ${scheduledAt}, Now: ${nowIST}, User: ${data.userId}`);
        await processAndPost(data.userId, null, false, { ...data, docId: doc.id });
        await new Promise(r => setTimeout(r, 10000)); // delay between posts
      }
    }
  } catch(e) {
    console.error('[CRON] Error:', e.message);
  }
});

// Also check every minute if any user has posting time = current time and has pending
// Alternative simpler cron: run at every minute but only act if time matches user's postingTime
cron.schedule('* * * * *', async () => {
  // This is handled above - we check scheduledAt
});

async function processPendingPosts(userId, ctx) {
  try {
    const db = getDb();
    const snap = await db.collection('scheduled_posts').where('userId', '==', userId).where('status', '==', 'pending').get();
    if (snap.empty) {
      await ctx.reply('📭 Koi pending post nahi hai!');
      return;
    }
    
    for (const doc of snap.docs) {
      const data = doc.data();
      await ctx.reply(`📤 Posting: ${data.title} (${data.mediaType})...`);
      await processAndPost(userId, ctx, false, { ...data, docId: doc.id });
      await new Promise(r => setTimeout(r, 5000));
    }
  } catch(e) {
    console.error('processPending error', e);
    await ctx.reply('❌ Error: '+e.message);
  }
}

// --- Express ---
app.get('/', (req, res) => res.send('TubePilot Bot Running 🚀 - 6PM Scheduler + Reels + Title/Caption'));
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`Webhook verify: ${mode} ${token}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});
app.post('/webhook', (req, res) => { res.status(200).send('EVENT_RECEIVED'); });
app.get('/auth/instagram/callback', (req, res) => res.send('Instagram Auth Callback OK'));
app.get('/auth/deauthorize', (req, res) => res.send('Deauthorize OK'));
app.get('/auth/data-deletion', (req, res) => res.send('Data Deletion OK'));

app.get('/health', (req, res) => {
  const nowIST = getISTTime();
  res.json({ status: 'ok', timeIST: nowIST.toLocaleString('en-IN', {timeZone:'Asia/Kolkata'}), defaultPostingTime: DEFAULT_POST_TIME });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Express running on ${PORT} - 6PM Scheduler Mode`));

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('Telegram Bot started - 6PM Scheduler + Cron Ready');
}).catch(err => {
  console.error('Bot launch error:', err.message);
  setTimeout(() => bot.launch({ dropPendingUpdates: true }), 5000);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
