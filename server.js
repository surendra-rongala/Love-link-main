// backend/server.js — Love Link Phase 3
// Express + WebSocket signaling server for WebRTC voice/video bubbles
// Push notifications, smart reminders, cron jobs

require('dotenv').config()
const express   = require('express')
const cors      = require('cors')
const http      = require('http')
const { WebSocketServer } = require('ws')
const admin     = require('firebase-admin')

const app    = express()
const server = http.createServer(app)
const wss    = new WebSocketServer({ server })

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }))
app.use(express.json())

// ── Firebase Admin ──────────────────────────────────────────────────
let fbReady = false, db = null
try {
  const sa = require('./serviceAccountKey.json')
  admin.initializeApp({ credential: admin.credential.cert(sa) })
  db = admin.firestore()
  fbReady = true
  console.log('✅ Firebase Admin ready')
} catch {
  console.warn('⚠️  No serviceAccountKey.json — push notifications disabled')
}

// ── WebRTC Signaling (WebSocket) ────────────────────────────────────
// Used for voice/video bubble in Sync Mode
// Rooms keyed by coupleId
const rooms = new Map() // coupleId → Set<ws>

wss.on('connection', (ws) => {
  let coupleId = null

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw)
      // Join a room
      if (msg.type === 'join') {
        coupleId = msg.coupleId
        if (!rooms.has(coupleId)) rooms.set(coupleId, new Set())
        rooms.get(coupleId).add(ws)
        console.log(`[WS] Joined room ${coupleId} (${rooms.get(coupleId).size} peers)`)
        return
      }
      // Relay offer / answer / ice-candidate to the other peer
      if (['offer','answer','ice-candidate'].includes(msg.type) && coupleId) {
        const room = rooms.get(coupleId)
        if (!room) return
        room.forEach(peer => {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify(msg))
          }
        })
      }
    } catch {}
  })

  ws.on('close', () => {
    if (coupleId && rooms.has(coupleId)) {
      rooms.get(coupleId).delete(ws)
      if (rooms.get(coupleId).size === 0) rooms.delete(coupleId)
    }
  })
})

// ── FCM Helper ──────────────────────────────────────────────────────
async function sendFCM(token, title, body, link='/') {
  if (!fbReady || !token) return false
  try {
    await admin.messaging().send({
      token, notification: { title, body },
      webpush: { fcmOptions: { link } },
    })
    return true
  } catch(e) { console.error('FCM:', e.message); return false }
}

// ── REST Endpoints ──────────────────────────────────────────────────
app.get('/health', (_,res) => res.json({ ok:true, firebase:fbReady, phase:3, wsClients:wss.clients.size }))

app.post('/notify-message',    async (req,res) => {
  const { senderName, text, partnerFcmToken } = req.body
  res.json({ ok: await sendFCM(partnerFcmToken, `💌 ${senderName}`, text?.slice(0,80)||'Sent you a message', '/chat') })
})
app.post('/notify-gift',       async (req,res) => {
  const { senderName, emoji, label, partnerFcmToken } = req.body
  res.json({ ok: await sendFCM(partnerFcmToken, `${emoji} ${senderName} sent you a gift!`, `They sent you a ${label} 💕`, '/gifts') })
})
app.post('/notify-snap',       async (req,res) => {
  const { senderName, partnerFcmToken } = req.body
  res.json({ ok: await sendFCM(partnerFcmToken, `📸 ${senderName} sent you a moment!`, 'Tap to see it 💖', '/memories') })
})
app.post('/notify-sync-invite',async (req,res) => {
  const { senderName, partnerFcmToken } = req.body
  res.json({ ok: await sendFCM(partnerFcmToken, `🎬 ${senderName} wants to watch together!`, 'Join Sync Mode 💕', '/sync') })
})
app.post('/notify-draw-invite',async (req,res) => {
  const { senderName, partnerFcmToken } = req.body
  res.json({ ok: await sendFCM(partnerFcmToken, `🎨 ${senderName} started drawing!`, 'Come draw together 💕', '/draw') })
})
app.post('/notify-streak-warning', async (req,res) => {
  const { partnerFcmToken, streakCount } = req.body
  res.json({ ok: await sendFCM(partnerFcmToken, '🔥 Streak at risk!', `${streakCount}-day streak resets tonight! Connect now 💕`, '/daily') })
})
app.post('/notify-inactive',   async (req,res) => {
  const { partnerFcmToken, partnerNickname } = req.body
  const msgs = ['Send something sweet ❤️','Your partner might need you 🥺','A little message goes a long way 💌']
  res.json({ ok: await sendFCM(partnerFcmToken, `💭 ${partnerNickname || 'Your partner'} misses you`, msgs[Math.floor(Math.random()*msgs.length)], '/chat') })
})
app.post('/register-fcm-token',async (req,res) => {
  if (!fbReady) return res.status(503).json({ error:'Firebase not ready' })
  const { uid, token } = req.body
  try { await db.collection('users').doc(uid).set({ fcmToken:token },{ merge:true }); res.json({ ok:true }) }
  catch(e) { res.status(500).json({ error:e.message }) }
})

// ── Cron endpoints (call via cron job at configured times) ──────────
app.get('/cron/daily-question', async (req,res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(401).json({ error:'Unauthorized' })
  if (!fbReady) return res.status(503).json({ error:'Firebase not ready' })
  const usersSnap = await db.collection('users').where('coupleId','!=',null).get()
  let sent = 0
  for (const u of usersSnap.docs) {
    const { fcmToken } = u.data()
    if (fcmToken) { await sendFCM(fcmToken,'💬 Daily Question Ready!','Answer today\'s question with your partner 💕','/daily'); sent++ }
  }
  res.json({ ok:true, sent })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => console.log(`🚀 Love Link Phase 3 backend :${PORT} (HTTP + WebSocket)`))
