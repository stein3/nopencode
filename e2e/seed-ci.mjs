#!/usr/bin/env node
// Seed test sessions via the engine API for CI integration tests.
// Run AFTER the engine is started (needs :4096) and BEFORE the chatserver
// reads opencode.db (chatserver is stateless — it re-reads on each request).
//
// Usage: node e2e/seed-ci.mjs [engine_url]

const ENGINE = process.argv[2] || 'http://127.0.0.1:4096';

const j = (r) => r.json();
const post = async (path, body) => {
  const res = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`POST ${path} failed: ${res.status}`);
  }
  try { return JSON.parse(text); } catch { return text; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  console.log(`seeding from engine at ${ENGINE}`);
  // Check engine is up
  try {
    const r = await fetch(`${ENGINE}/doc`);
    if (!r.ok) throw new Error(`engine /doc returned ${r.status}`);
    console.log('engine reachable');
  } catch (e) {
    console.error('engine not reachable at', ENGINE, e.message);
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
  //    The engine API rejects type:'tool' parts (400), so we create the
  //    session via API then inject the tool-card message directly in sqlite.
  const grepSess = await post('/session', { title: 'Grep match count in opencode output' });
  await post(`/session/${grepSess.id}/message`, {
    parts: [{ type: 'text', text: 'search for the pattern' }],
    noReply: true,
  });
  console.log(`  seeded: grep session base (${grepSess.id})`);

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

  // Inject fake messages directly in sqlite (engine API rejects type:'tool' parts).
  const DB_PATH = process.env.OPENCODE_DB || '/home/node/.local/share/opencode/opencode.db';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    const now = Date.now();

    // Grep session: assistant message with tool card
    const grepMsgId = 'msg_seed_grep_' + now;
    const grepPartText = 'prt_seed_grep_text_' + now;
    const grepPartTool = 'prt_seed_grep_tool_' + now;
    const grepMsgData = JSON.stringify({
      role: 'assistant', agent: 'orchestrator',
      model: { providerID: 'opencode-go', modelID: 'mimo-v2.5' },
    });
    const grepTextData = JSON.stringify({ type: 'text', text: 'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz' });
    const grepToolData = JSON.stringify({
      type: 'tool', tool: 'grep',
      state: { status: 'completed', input: { pattern: 'foo', path: '/workspace' },
               output: 'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz' },
    });
    db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)')
      .run(grepMsgId, grepSess.id, now, now, grepMsgData);
    db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)')
      .run(grepPartText, grepMsgId, grepSess.id, now, now, grepTextData);
    db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)')
      .run(grepPartTool, grepMsgId, grepSess.id, now, now, grepToolData);
    console.log(`  injected grep tool card (${grepMsgId})`);

    // Tokens session: assistant message with fabricated token tallies
    const tokMsgId = 'msg_seed_tokens_' + now;
    const tokPartId = 'prt_seed_tokens_' + now;
    const tokMsgData = JSON.stringify({
      role: 'assistant', agent: 'orchestrator',
      model: { providerID: 'opencode-go', modelID: 'mimo-v2.5' },
      tokens: { input: 1500, output: 800, reasoning: 200, cache: { read: 5000, write: 0 } },
    });
    const tokPartData = JSON.stringify({ type: 'text', text: 'fake assistant response for token seeding' });
    db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)')
      .run(tokMsgId, tokSess.id, now, now, tokMsgData);
    db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)')
      .run(tokPartId, tokMsgId, tokSess.id, now, now, tokPartData);
    console.log(`  injected tokens message (${tokMsgId})`);

    db.close();
  } catch (e) {
    console.log('  node:sqlite unavailable, trying python3 fallback:', e.message);
    const { execSync } = await import('node:child_process');
    const now = Date.now();
    const grepMsgId = 'msg_seed_grep_' + now;
    const tokMsgId = 'msg_seed_tokens_' + now;
    execSync(`python3 -c "
import sqlite3, json, time
conn = sqlite3.connect('${DB_PATH}')
cur = conn.cursor()
now = int(time.time()*1000)

# Grep tool card
grep_msg = '${grepMsgId}'
grep_txt = 'prt_seed_grep_text_${now}'
grep_tool = 'prt_seed_grep_tool_${now}'
grep_sid = '${grepSess.id}'
cur.execute('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)',
  (grep_msg, grep_sid, now, now, json.dumps({'role':'assistant','agent':'orchestrator','model':{'providerID':'opencode-go','modelID':'mimo-v2.5'}})))
cur.execute('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)',
  (grep_txt, grep_msg, grep_sid, now, now, json.dumps({'type':'text','text':'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz'})))
cur.execute('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)',
  (grep_tool, grep_msg, grep_sid, now, now, json.dumps({'type':'tool','tool':'grep','state':{'status':'completed','input':{'pattern':'foo','path':'/workspace'},'output':'Found 3 matches\n  Line 12: foo\n  Line 45: bar\n  Line 78: baz'}})))

# Tokens message
tok_msg = '${tokMsgId}'
tok_part = 'prt_seed_tokens_${now}'
tok_sid = '${tokSess.id}'
cur.execute('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)',
  (tok_msg, tok_sid, now, now, json.dumps({'role':'assistant','agent':'orchestrator','model':{'providerID':'opencode-go','modelID':'mimo-v2.5'},'tokens':{'input':1500,'output':800,'reasoning':200,'cache':{'read':5000,'write':0}}})))
cur.execute('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)',
  (tok_part, tok_msg, tok_sid, now, now, json.dumps({'type':'text','text':'fake assistant response for token seeding'})))

conn.commit()
conn.close()
"`, { stdio: 'pipe' });
  }

  console.log('seeding complete');
}

seed().catch((e) => {
  console.error('SEED FAILED:', e.message);
  process.exit(1);
});
