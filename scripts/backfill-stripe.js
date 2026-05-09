'use strict';

/**
 * One-time backfill: populate stripe_customer_id, stripe_subscription_id,
 * and email for clubs created before those columns existed.
 *
 * Run on the VPS:
 *   node scripts/backfill-stripe.js
 *
 * Reads STRIPE_SECRET_KEY from ecosystem.config.js env, or set it inline:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/backfill-stripe.js
 */

const path     = require('path');
const os       = require('os');
const Database = require('better-sqlite3');
const Stripe   = require('stripe');

// ── Load env from ecosystem.config.js if present ──────────────────────────────
try {
  const eco = require(path.join(__dirname, '..', 'ecosystem.config.js'));
  const env = eco.apps[0].env || {};
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = String(v);
  }
} catch (_) {}

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) { console.error('STRIPE_SECRET_KEY not set'); process.exit(1); }

const stripe = Stripe(stripeKey);
const dbPath = path.join(os.homedir(), '.mfclive-saas', 'saas.db');
const db     = new Database(dbPath);

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function run() {
  console.log(`Using DB: ${dbPath}`);
  const clubs = db.prepare('SELECT * FROM clubs').all();
  console.log(`Clubs in DB: ${clubs.length}`);

  const missing = clubs.filter(c => !c.stripe_customer_id || !c.stripe_subscription_id || !c.email);
  console.log(`Clubs missing Stripe data: ${missing.length}`);
  if (!missing.length) { console.log('Nothing to backfill.'); return; }

  // Build lookup maps for fast matching
  const bySlug  = new Map(missing.map(c => [c.slug, c]));
  const byName  = new Map(missing.map(c => [c.name.toLowerCase().trim(), c]));

  let updated = 0;
  let hasMore = true;
  let startingAfter;

  console.log('\nPaging through Stripe checkout sessions...');

  while (hasMore) {
    const params = { mode: 'subscription', limit: 100, expand: ['data.subscription'] };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripe.checkout.sessions.list(params);

    for (const session of page.data) {
      if (session.payment_status !== 'paid') continue;

      const metaEmail    = (session.metadata && session.metadata.email   || '').trim().toLowerCase();
      const metaClubName = (session.metadata && session.metadata.clubName || '').trim();
      const customerId   = session.customer;
      const sub          = session.subscription;
      const subId        = typeof sub === 'string' ? sub : (sub && sub.id);

      if (!customerId || !subId) continue;

      // Try to match club: by slug derived from clubName, then by name
      const candidateSlug = slugify(metaClubName);
      let club = bySlug.get(candidateSlug);

      // If no direct slug match, try suffixed slugs (e.g. "my-club-2")
      if (!club) {
        for (const [slug, c] of bySlug) {
          if (slug === candidateSlug || slug.startsWith(candidateSlug + '-')) {
            club = c; break;
          }
        }
      }

      // Fall back to name match
      if (!club) club = byName.get(metaClubName.toLowerCase());

      if (!club) {
        console.log(`  [skip] No club found for session ${session.id} (${metaClubName} / ${metaEmail})`);
        continue;
      }

      const customerEmail = metaEmail || (() => {
        try { return session.customer_details && session.customer_details.email || ''; } catch { return ''; }
      })();

      db.prepare(`
        UPDATE clubs SET
          stripe_customer_id     = COALESCE(stripe_customer_id, ?),
          stripe_subscription_id = COALESCE(stripe_subscription_id, ?),
          email                  = COALESCE(email, ?)
        WHERE slug = ?
      `).run(customerId, subId, customerEmail || null, club.slug);

      console.log(`  [ok] ${club.slug} -> customer ${customerId}, sub ${subId}, email ${customerEmail || '(none)'}`);
      bySlug.delete(club.slug);
      byName.delete(club.name.toLowerCase().trim());
      updated++;
    }

    hasMore = page.has_more;
    if (hasMore && page.data.length) {
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  console.log(`\nDone. Updated ${updated} club(s).`);

  const stillMissing = db.prepare("SELECT slug, name FROM clubs WHERE stripe_customer_id IS NULL OR stripe_subscription_id IS NULL").all();
  if (stillMissing.length) {
    console.log(`\nClubs still missing Stripe IDs (created via admin API or no matching session found):`);
    for (const c of stillMissing) console.log(`  ${c.slug} — ${c.name}`);
    console.log(`These clubs have no Stripe subscription. No action needed unless they should be paying.`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });