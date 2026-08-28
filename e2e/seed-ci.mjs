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
  ];
  for (const title of genericTitles) {
    const s = await post('/session', { title });
    await post(`/session/${s.id}/message`, {
      parts: [{ type: 'text', text: `probe for ${title}` }],
      noReply: true,
    });
    await post(`/session/${s.id}/message`, {
      parts: [{ type: 'text', text: `response for ${title}` }],
      noReply: true,
    });
    console.log(`  seeded: ${title} (${s.id})`);
  }

  // 2. Session with grep tool output (grep-count.test.mjs)
  const grepSess = await post('/session', { title: 'Grep match count in opencode output' });
  await post(`/session/${grepSess.id}/message`, {
    parts: [{ type: 'text', text: 'search for the pattern' }],
    noReply: true,
  });
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
    noReply: true,
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

  // 4. Fake a session with tokens for tokens.test.mjs.
  //    The chatserver computes sidebar tk badges from assistant messages
  //    with positive token sums.  We create a session via the API, then
  //    inject a fake assistant message + token-bearing part directly in
  //    opencode.db — no LLM turn needed.
  const tokSess = await post('/session', { title: 'Tokens probe session' });
  await post(`/session/${tokSess.id}/message`, {
    parts: [{ type: 'text', text: 'token probe' }],
    noReply: true,
  });
  console.log(`  seeded: tokens probe session (${tokSess.id})`);

  // Inject a fake assistant message with token tallies directly in sqlite.
  const DB_PATH = process.env.OPENCODE_DB || '/home/node/.local/share/opencode/opencode.db';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    const fakeMsgId = 'msg_seed_tokens_' + Date.now();
    const fakePartId = 'prt_seed_tokens_' + Date.now();
    const now = Date.now();
    const msgData = JSON.stringify({
      role: 'assistant',
      agent: 'orchestrator',
      model: { providerID: 'opencode-go', modelID: 'mimo-v2.5' },
      tokens: { input: 1500, output: 800, reasoning: 200, cache: { read: 5000, write: 0 } },
    });
    const partData = JSON.stringify({ type: 'text', text: 'fake assistant response for token seeding' });
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)')
      .run(fakeMsgId, tokSess.id, now, now, msgData);
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)')
      .run(fakePartId, fakeMsgId, tokSess.id, now, now, partData);
    console.log(`  injected fake assistant message with tokens (${fakeMsgId})`);
    db.close();
  } catch (e) {
    console.log('  node:sqlite unavailable, trying python3 fallback:', e.message);
    const { execSync } = await import('node:child_process');
    const fakeMsgId = 'msg_seed_tokens_' + Date.now();
    const fakePartId = 'prt_seed_tokens_' + Date.now();
    const now = Date.now();
    execSync(`python3 -c "
import sqlite3, json, time
conn = sqlite3.connect('${DB_PATH}')
cur = conn.cursor()
now = int(time.time()*1000)
msg_id = '${fakeMsgId}'
part_id = '${fakePartId}'
sid = '${tokSess.id}'
msg_data = json.dumps({'role':'assistant','agent':'orchestrator','model':{'providerID':'opencode-go','modelID':'mimo-v2.5'},'tokens':{'input':1500,'output':800,'reasoning':200,'cache':{'read':5000,'write':0}}})
part_data = json.dumps({'type':'text','text':'fake assistant response for token seeding'})
cur.execute('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)', (msg_id,sid,now,now,msg_data))
cur.execute('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)', (part_id,msg_id,sid,now,now,part_data))
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
