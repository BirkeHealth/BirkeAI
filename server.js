const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

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

const SESSION_ID_RE = /^[a-f0-9]{32}$/;

async function getOrCreateSession(sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('Invalid session ID');
  await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
    [sessionId, '']
  );
  const result = await pool.query('SELECT id FROM users WHERE username = $1', [sessionId]);
  if (!result.rows.length) throw new Error('Session not found');
  const userId = result.rows[0].id;
  await pool.query(
    `INSERT INTO user_traits (user_id, name, value) VALUES
      ($1, 'curious', 0), ($1, 'warm', 0), ($1, 'witty', 0), ($1, 'direct', 0), ($1, 'thoughtful', 0)
    ON CONFLICT (user_id, name) DO NOTHING`,
    [userId]
  );
  return userId;
}

app.get('/api/state', chatLimiter, async (req, res) => {
  const sessionId = req.headers['x-session-id'] || '';
  try {
    const userId = await getOrCreateSession(sessionId);
    const memories = await pool.query(
      'SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    const traits = await pool.query(
      'SELECT name, value FROM user_traits WHERE user_id = $1',
      [userId]
    );
    const traitMap = {};
    traits.rows.forEach(r => { traitMap[r.name] = parseInt(r.value); });
    res.json({ memories: memories.rows.map(r => r.content), traits: traitMap });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });
  const sessionId = req.headers['x-session-id'] || '';

  try {
    const userId = await getOrCreateSession(sessionId);
    const memoriesResult = await pool.query(
      'SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    const traitsResult = await pool.query(
      'SELECT name, value FROM user_traits WHERE user_id = $1',
      [userId]
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
            [userId, parsed.new_memory]
          );
        }
        if (parsed.trait_updates) {
          for (const [k, v] of Object.entries(parsed.trait_updates)) {
            const delta = Number(v);
            if (delta !== 0) {
              await pool.query(
                'UPDATE user_traits SET value = GREATEST(0, value + $1) WHERE user_id = $2 AND name = $3',
                [delta, userId, k]
              );
            }
          }
        }
      } catch (e) { console.error('Failed to parse AI metadata:', e.message); }
    }

    const updatedMemories = await pool.query(
      'SELECT content FROM user_memories WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    const updatedTraits = await pool.query(
      'SELECT name, value FROM user_traits WHERE user_id = $1',
      [userId]
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

app.get('/', pageLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', pageLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Birke running on port ${PORT}`));
}).catch(console.error);
