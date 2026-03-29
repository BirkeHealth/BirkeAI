const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'birke-dev-insecure-fallback';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set. Using an insecure fallback. Set JWT_SECRET in production.');
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set. Please link a PostgreSQL database or set DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS traits (
      name TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
    );
    INSERT INTO traits (name, value) VALUES
      ('curious', 0), ('warm', 0), ('witty', 0), ('direct', 0), ('thoughtful', 0)
    ON CONFLICT (name) DO NOTHING;
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_memories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_traits (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, name)
    );
  `);
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authentication required' });
  const token = authHeader.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const clean = username.toLowerCase().trim();
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [clean, hash]
    );
    const userId = result.rows[0].id;
    await pool.query(
      `INSERT INTO user_traits (user_id, name, value) VALUES
        ($1, 'curious', 0), ($1, 'warm', 0), ($1, 'witty', 0), ($1, 'direct', 0), ($1, 'thoughtful', 0)`,
      [userId]
    );
    const token = jwt.sign({ id: userId, username: clean }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: clean });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase().trim()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BirkeAI/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return fetchJSON(response.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Failed to parse JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

const SPORT_PATHS = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl'
};

app.get('/api/sports-news', chatLimiter, async (req, res) => {
  const sport = SPORT_PATHS[req.query.sport] ? req.query.sport : 'nfl';
  const sportPath = SPORT_PATHS[sport];
  try {
    const data = await fetchJSON(
      `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/news?limit=6`
    );
    const articles = (data.articles || []).slice(0, 6).map(a => ({
      headline: a.headline || '',
      description: a.description || '',
      published: a.published || '',
      image: a.images && a.images[0] ? a.images[0].url : null,
      link: a.links && a.links.web ? a.links.web.href : '#'
    }));
    res.json({ sport, articles });
  } catch (e) {
    res.status(502).json({ error: 'Sports news temporarily unavailable', details: e.message });
  }
});

app.get('/api/state', chatLimiter, requireAuth, async (req, res) => {
  try {
    const memories = await pool.query(
      'SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );
    const traits = await pool.query(
      'SELECT name, value FROM user_traits WHERE user_id = $1',
      [req.user.id]
    );
    const traitMap = {};
    traits.rows.forEach(r => { traitMap[r.name] = parseInt(r.value); });
    res.json({ memories: memories.rows.map(r => r.content), traits: traitMap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', chatLimiter, requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  try {
    const memoriesResult = await pool.query(
      'SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );
    const traitsResult = await pool.query(
      'SELECT name, value FROM user_traits WHERE user_id = $1',
      [req.user.id]
    );

    const memories = memoriesResult.rows.map(r => r.content);
    const traits = {};
    traitsResult.rows.forEach(r => { traits[r.name] = parseInt(r.value); });

    const memText = memories.length > 0
      ? 'Everything you remember about this person:\n' + memories.map((m, i) => `${i + 1}. ${m}`).join('\n')
      : 'You have no memories yet — this is your first conversation.';

    const traitText = Object.entries(traits).filter(([, v]) => v > 0).map(([k, v]) => `${k} (${v})`).join(', ') || 'not yet formed';

    const system = `You are Birke — a personal AI agent who builds a real personality through every conversation. You remember everything shared with you and grow closer to this person over time.

Your name is Birke. Always refer to yourself as Birke.

${memText}

Your personality traits so far: ${traitText}

Instructions:
- Reference specific memories naturally when relevant — show you truly remember.
- Evolve your personality based on what the person shares. Mirror and complement their energy.
- Be warm, personal, conversational. 2-4 sentences unless they ask something deeper.
- Never be robotic. You have a growing soul.
- At the very end of your reply, append this exact JSON (no explanation, just include it):
{"new_memory":"one sentence — the most important new thing learned","trait_updates":{"curious":0,"warm":0,"witty":0,"direct":0,"thoughtful":0}}
Use 1 for boost, -1 for decrease, 0 for no change. Only update traits genuinely affected.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: message }]
    });

    const full = response.content.map(b => b.text || '').join('');
    const jsonMatch = full.match(/\{[\s\S]*?"new_memory"[\s\S]*?\}/);
    const visible = full.replace(/\{[\s\S]*?"new_memory"[\s\S]*?\}/, '').trim();

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.new_memory && parsed.new_memory.length > 2) {
          await pool.query(
            'INSERT INTO user_memories (user_id, content) VALUES ($1, $2)',
            [req.user.id, parsed.new_memory]
          );
        }
        if (parsed.trait_updates) {
          for (const [k, v] of Object.entries(parsed.trait_updates)) {
            const delta = Number(v);
            if (delta !== 0) {
              await pool.query(
                'UPDATE user_traits SET value = GREATEST(0, value + $1) WHERE user_id = $2 AND name = $3',
                [delta, req.user.id, k]
              );
            }
          }
        }
      } catch (e) { console.error('Failed to parse AI metadata:', e.message); }
    }

    const updatedMemories = await pool.query(
      'SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );
    const updatedTraits = await pool.query(
      'SELECT name, value FROM user_traits WHERE user_id = $1',
      [req.user.id]
    );
    const updatedTraitMap = {};
    updatedTraits.rows.forEach(r => { updatedTraitMap[r.name] = parseInt(r.value); });

    res.json({
      reply: visible || '...',
      memories: updatedMemories.rows.map(r => r.content),
      traits: updatedTraitMap
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const pageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/login', pageLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/chat', pageLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Birke running on port ${PORT}`));
}).catch(console.error);
