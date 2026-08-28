#!/usr/bin/env node
// Seed test sessions via the engine API for CI integration tests.
// Run AFTER the engine is started (needs :4096) and BEFORE the chatserver
// reads opencode.db (chatserver is stateless — it re-reads on each request).
//
// Usage: node e2e/seed-ci.mjs [engine_url]

const ENGINE = process.argv[2] || 'http://127.0.0.1:4096';

const j = (r) => r.json();
const post = (path, body) =>
  fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  // Check engine is up
  try {
    await fetch(`${ENGINE}/doc`);
  } catch {
    console.error('engine not reachable at', ENGINE);
    process.exit(1);
  }

  // 1. Generic sessions for sidebar visibility tests (subs, nest, settings, etc.)
  const genericTitles = [
    'Test session alpha',
    'Test session beta',
    'Healthscape dark and light theme options', // needed by tokens.test.mjs
  ];
  for (const title of genericTitles) {
    const s = await post('/session', { title });
    // Add a user + assistant message so message_count > 0 and sidebar shows them
    await post(`/session/${s.id}/message`, {
      parts: [{ type: 'text', text: `probe for ${title}` }],
      noReply: true,
    });
    await post(`/session/${s.id}/message`, {
      parts: [{ type: 'text', text: `response for ${title}` }],
      model: { providerID: 'opencode', modelID: 'x-preview-f-free' },
    });
    console.log(`  seeded: ${title} (${s.id})`);
  }

  // 2. Session with grep tool output (grep-count.test.mjs)
  const grepSess = await post('/session', { title: 'Grep match count in opencode output' });
  await post(`/session/${grepSess.id}/message`, {
    parts: [{ type: 'text', text: 'search for the pattern' }],
    noReply: true,
  });
  // Assistant message with a grep tool card containing "Found N matches"
  await post(`/session/${grepSess.id}/message`, {
    parts: [
      {
        type: 'text',
        text: 'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz',
      },
      {
        type: 'tool',
        tool: 'grep',
        state: {
          status: 'completed',
          input: { pattern: 'foo', path: '/workspace' },
          output: 'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz',
        },
      },
    ],
    model: { providerID: 'opencode', modelID: 'x-preview-f-free' },
  });
  console.log(`  seeded: grep session (${grepSess.id})`);

  // 3. Subagent sessions for subs2.test.mjs (need parent_id to show as .sub-row)
  const parentSess = await post('/session', { title: 'Parent session for subagent test' });
  await post(`/session/${parentSess.id}/message`, {
    parts: [{ type: 'text', text: 'parent probe message' }],
    noReply: true,
  });
  const subSess = await post('/session', {
    title: 'Subagent probe (@explore subagent)',
    parentID: parentSess.id,
    agent: 'explore',
  });
  await post(`/session/${subSess.id}/message`, {
    parts: [{ type: 'text', text: 'subagent probe message' }],
    noReply: true,
  });
  console.log(`  seeded: subagent sessions (parent=${parentSess.id}, sub=${subSess.id})`);

  // Give the engine a moment to flush to opencode.db
  await sleep(500);

  // 4. Write token tallies directly to opencode.db for tokens.test.mjs
  //    The engine API doesn't support setting tokens on messages, so we
  //    update the assistant messages' data JSON directly in sqlite.
  const DB_PATH = process.env.OPENCODE_DB || '/home/node/.local/share/opencode/opencode.db';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    // Find the "Healthscape dark and light theme options" session's assistant message
    const rows = db.prepare(
      `SELECT m.id, m.data FROM message m
       JOIN session s ON s.id = m.session_id
       WHERE s.title LIKE '%Healthscape dark%'
         AND json_extract(m.data, '$.role') = 'assistant'`
    ).all();
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (!data.tokens || (data.tokens.input === 0 && data.tokens.output === 0)) {
        data.tokens = { input: 1500, output: 800, reasoning: 200, cache: { read: 5000, write: 0 } };
        db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
        console.log(`  seeded tokens on message ${row.id}`);
      }
    }
    db.close();
  } catch (e) {
    // node:sqlite may not be available; fall back to python3
    console.log('  node:sqlite unavailable, trying python3 fallback:', e.message);
    const { execSync } = await import('node:child_process');
    execSync(`python3 -c "
import sqlite3, json
conn = sqlite3.connect('${DB_PATH}')
cur = conn.cursor()
cur.execute('''SELECT m.id, m.data FROM message m
  JOIN session s ON s.id = m.session_id
  WHERE s.title LIKE '%Healthscape dark%'
    AND json_extract(m.data, '$.role') = 'assistant' ''')
for row in cur.fetchall():
    data = json.loads(row[1])
    if not data.get('tokens') or (data['tokens'].get('input',0)==0 and data['tokens'].get('output',0)==0):
        data['tokens'] = {'input':1500,'output':800,'reasoning':200,'cache':{'read':5000,'write':0}}
        cur.execute('UPDATE message SET data=? WHERE id=?', (json.dumps(data), row[0]))
conn.commit()
conn.close()
"`, { stdio: 'pipe' });
  }

  console.log('seeding complete');
}

seed().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
