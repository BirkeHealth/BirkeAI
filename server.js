const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  `);
}

app.get('/api/state', async (req, res) => {
  try {
    const memories = await pool.query('SELECT content FROM memories ORDER BY created_at ASC');
    const traits = await pool.query('SELECT name, value FROM traits');
    const traitMap = {};
    traits.rows.forEach(r => traitMap[r.name] = parseInt(r.value));
    res.json({ memories: memories.rows.map(r => r.content), traits: traitMap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message provided' });

  try {
    const memoriesResult = await pool.query('SELECT content FROM memories ORDER BY created_at ASC');
    const traitsResult = await pool.query('SELECT name, value FROM traits');

    const memories = memoriesResult.rows.map(r => r.content);
    const traits = {};
    traitsResult.rows.forEach(r => traits[r.name] = parseInt(r.value));

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
          await pool.query('INSERT INTO memories (content) VALUES ($1)', [parsed.new_memory]);
        }
        if (parsed.trait_updates) {
          for (const [k, v] of Object.entries(parsed.trait_updates)) {
            const delta = Number(v);
            if (delta !== 0) {
              await pool.query(
                'UPDATE traits SET value = GREATEST(0, value + $1) WHERE name = $2',
                [delta, k]
              );
            }
          }
        }
      } catch (e) { }
    }

    const updatedMemories = await pool.query('SELECT content FROM memories ORDER BY created_at ASC');
    const updatedTraits = await pool.query('SELECT name, value FROM traits');
    const updatedTraitMap = {};
    updatedTraits.rows.forEach(r => updatedTraitMap[r.name] = parseInt(r.value));

    res.json({
      reply: visible || '...',
      memories: updatedMemories.rows.map(r => r.content),
      traits: updatedTraitMap
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Birke running on port ${PORT}`));
}).catch(console.error);
