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

  // Give the engine a moment to flush to opencode.db
  await sleep(500);
  console.log('seeding complete');
}

seed().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
