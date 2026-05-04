#!/usr/bin/env node
/**
 * Demo: print which shard a series of user IDs would be routed to.
 *
 * Usage:
 *   node scripts/demo-distribution.mjs                     # 10 random snowflakes, 4 shards
 *   node scripts/demo-distribution.mjs 16 8                # 16 ids across 8 shards
 *   node scripts/demo-distribution.mjs --ids 123,456,789 4 # specific ids, 4 shards
 *
 * The hash function matches the spec: shard_id = (BigInt(user_id) >> 22n) % BigInt(num_shards).
 */

const argv = process.argv.slice(2);
let count = 10;
let numShards = 4;
let explicitIds = null;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ids' && argv[i + 1]) {
    explicitIds = argv[i + 1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    i++;
    continue;
  }
  if (!Number.isNaN(Number(argv[i]))) {
    if (i === 0 || argv[i - 1] !== '--ids') {
      if (count === 10) count = Number(argv[i]);
      else numShards = Number(argv[i]);
    }
  }
}

function shardFor(userId, shards) {
  if (shards <= 1) return 0;
  let id;
  try {
    id = BigInt(String(userId));
  } catch {
    return 0;
  }
  if (id < 0n) id = -id;
  return Number((id >> 22n) % BigInt(shards));
}

let _msOffset = 0;
function randomSnowflake() {
  // Discord-style: 41 bits of timestamp + 22 bits worker/incr.
  // Bump the timestamp on each call so the demo spans multiple ms — otherwise
  // all ids generated within one ms hash to the same shard (since the lower
  // 22 bits are masked away by the spec hash).
  _msOffset += 1 + Math.floor(Math.random() * 7);
  const ts = BigInt(Date.now() - 1_420_070_400_000 + _msOffset);
  const incr = BigInt(Math.floor(Math.random() * 0x3fffff));
  return ((ts << 22n) | incr).toString();
}

const ids = explicitIds ?? Array.from({ length: count }, () => randomSnowflake());

const counts = new Array(numShards).fill(0);
console.log(`\nDistribution across ${numShards} shards (${ids.length} ids):\n`);
console.log('user_id'.padEnd(24), '→ shard');
console.log('-'.repeat(36));
for (const id of ids) {
  const s = shardFor(id, numShards);
  counts[s]++;
  console.log(id.padEnd(24), `→ ${s}`);
}
console.log('-'.repeat(36));
console.log('\nPer-shard counts:');
for (let i = 0; i < numShards; i++) {
  const bar = '#'.repeat(counts[i]);
  console.log(`  shard ${i}: ${counts[i].toString().padStart(4)} ${bar}`);
}
console.log();
