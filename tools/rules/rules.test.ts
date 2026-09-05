/**
 * What the security rules actually allow, run against the Firestore emulator.
 *
 * Kept out of `npm test` because it needs Java and a running emulator, which
 * the pure suite deliberately does not. Run it with `npm run test:rules`.
 *
 * The rules are the only part of this system that a determined client cannot
 * route around, so they are the part most worth proving rather than reading.
 * Two of the assumptions here are ones I could not settle by reading the
 * documentation — see "the two assumptions" below.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, increment, writeBatch, serverTimestamp } from 'firebase/firestore';

let env: RulesTestEnvironment;

/** A signed-up account. */
const named = (uid: string) =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } }).firestore();

/** Someone who has never signed up. Plays, builds, keeps progress; cannot publish. */
const anon = (uid: string) =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();

const quizBody = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  name: 'Brenta',
  bbox: [10, 46, 11, 47],
  features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16] }],
  ...over,
});

const publishedBody = (ownerId: string, over: Record<string, unknown> = {}) => ({
  ...quizBody(),
  ownerId,
  ownerName: 'Rory',
  version: 1,
  players: 0,
  hidden: false,
  cells: ['x271y181'],
  ...over,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-terrain-nerd',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});

after(async () => env?.cleanup());
beforeEach(async () => env.clearFirestore());

describe('drafts', () => {
  test('are readable and writable only by their owner', async () => {
    const mine = doc(named('alice'), 'users/alice/quizzes/q1');
    await assertSucceeds(setDoc(mine, quizBody()));
    await assertSucceeds(getDoc(mine));

    await assertFails(getDoc(doc(named('mallory'), 'users/alice/quizzes/q1')));
    await assertFails(setDoc(doc(named('mallory'), 'users/alice/quizzes/q2'), quizBody()));
  });

  test('can be built by someone who never signed up', async () => {
    await assertSucceeds(setDoc(doc(anon('ghost'), 'users/ghost/quizzes/q1'), quizBody()));
  });

  test('are refused when the shape is wrong', async () => {
    const db = named('alice');
    await assertFails(setDoc(doc(db, 'users/alice/quizzes/q1'), quizBody({ name: '' })));
    await assertFails(setDoc(doc(db, 'users/alice/quizzes/q1'), quizBody({ name: 'x'.repeat(81) })));
    await assertFails(setDoc(doc(db, 'users/alice/quizzes/q1'), quizBody({ features: [] })));
    await assertFails(setDoc(doc(db, 'users/alice/quizzes/q1'), quizBody({ bbox: [1, 2, 3] })));
  });

  test('accept the anchor shape the codec writes', async () => {
    // An array of maps, each holding an array. Firestore forbids an array
    // directly inside an array, and this is the shape that proves `at` as
    // [lon, lat] is on the right side of that line.
    const db = named('alice');
    await assertSucceeds(setDoc(doc(db, 'users/alice/quizzes/q1'), quizBody({
      features: [
        { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16], wikidata: 'Q7' },
        { id: 'valley/w2', kind: 'valley', name: 'Val Rendena', at: [10.75, 46.1] },
      ],
      // And the builder's map-of-maps-of-pairs, whose keys are feature ids.
      builder: {
        kinds: { peak: true },
        ranges: { peak: { flight: [0.27, 1] } },
        overrides: { 'peak/n1': 'in', 'valley/w2': 'out' },
        spacing: { peak: 3 },
      },
    })));
    const back = await getDoc(doc(db, 'users/alice/quizzes/q1'));
    assert.deepEqual(back.data()?.features[0].at, [10.87, 46.16]);
    assert.equal(back.data()?.builder.overrides['peak/n1'], 'in');
  });
});

describe('progress', () => {
  test('is private, and a score can only go up', async () => {
    const mine = doc(named('alice'), 'users/alice/progress/q1');
    await assertSucceeds(setDoc(mine, { best: 40, rounds: 1 }));
    await assertSucceeds(updateDoc(mine, { best: 90 }));
    await assertFails(updateDoc(mine, { best: 50 }));
    await assertSucceeds(updateDoc(mine, { best: 90 }));

    await assertFails(getDoc(doc(named('mallory'), 'users/alice/progress/q1')));
  });

  test('refuses a score that is not a percentage', async () => {
    const db = named('alice');
    await assertFails(setDoc(doc(db, 'users/alice/progress/q1'), { best: 101 }));
    await assertFails(setDoc(doc(db, 'users/alice/progress/q2'), { best: -1 }));
    await assertFails(setDoc(doc(db, 'users/alice/progress/q3'), { best: 'lots' }));
    await assertFails(setDoc(doc(db, 'users/alice/progress/q4'), { best: 50.5 }));
  });
});

describe('publishing', () => {
  test('needs a real account, not an anonymous one', async () => {
    await assertFails(setDoc(doc(anon('ghost'), 'published/q1'), publishedBody('ghost')));
    await assertSucceeds(setDoc(doc(named('alice'), 'published/q1'), publishedBody('alice')));
  });

  test('is world-readable once published', async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(ctx.firestore(), 'published/q1'), publishedBody('alice')));
    await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'published/q1')));
  });

  test('cannot be created claiming somebody else wrote it', async () => {
    await assertFails(setDoc(doc(named('mallory'), 'published/q1'), publishedBody('alice')));
  });

  test('cannot start with a head start on the counter', async () => {
    await assertFails(setDoc(doc(named('alice'), 'published/q1'), publishedBody('alice', { players: 500 })));
    await assertFails(setDoc(doc(named('alice'), 'published/q2'), publishedBody('alice', { version: 7 })));
  });

  test('is frozen: content cannot change without the version stepping', async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(ctx.firestore(), 'published/q1'), publishedBody('alice')));
    const mine = doc(named('alice'), 'published/q1');

    await assertFails(updateDoc(mine, { name: 'Renamed' }));
    await assertFails(updateDoc(mine, { features: [{ id: 'peak/n9', kind: 'peak' }] }));
    await assertSucceeds(setDoc(mine, publishedBody('alice', { name: 'Renamed', version: 2 })));
  });

  test('cannot be republished by anyone but its author', async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(ctx.firestore(), 'published/q1'), publishedBody('alice')));
    await assertFails(setDoc(doc(named('mallory'), 'published/q1'), publishedBody('mallory', { version: 2 })));
  });
});

describe('the play counter', () => {
  const publish = async () =>
    env.withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(ctx.firestore(), 'published/q1'), publishedBody('alice')));

  /** A first finished round: the marker and the increment, in one commit. */
  const recordPlay = (db: ReturnType<typeof named>, uid: string, delta = 1) => {
    const batch = writeBatch(db);
    batch.set(doc(db, `published/q1/players/${uid}`), { at: serverTimestamp() });
    batch.update(doc(db, 'published/q1'), { players: increment(delta) });
    return batch.commit();
  };

  test('the two assumptions: increment is visible to the rules, and existsAfter sees the batch', async () => {
    // Everything else about this counter rests on these two, and neither was
    // something I was willing to take on trust. If this test ever fails, the
    // fallback is a literal value read from the client's cached snapshot,
    // which loses concurrent updates but stays repairable.
    await publish();
    await assertSucceeds(recordPlay(anon('ghost'), 'ghost'));
    const after = await getDoc(doc(named('alice'), 'published/q1'));
    assert.equal(after.data()?.players, 1);
  });

  test('the same person cannot be counted twice', async () => {
    await publish();
    await assertSucceeds(recordPlay(anon('ghost'), 'ghost'));
    // The marker already exists, so neither the batch nor a bare bump works.
    await assertFails(recordPlay(anon('ghost'), 'ghost'));
    await assertFails(updateDoc(doc(anon('ghost'), 'published/q1'), { players: increment(1) }));
  });

  test('the counter cannot move without the marker being created alongside it', async () => {
    await publish();
    await assertFails(updateDoc(doc(named('bob'), 'published/q1'), { players: increment(1) }));
  });

  test('the counter cannot move by more than one', async () => {
    await publish();
    await assertFails(recordPlay(anon('ghost'), 'ghost', 50));
  });

  test('a play cannot smuggle in a change to anything else', async () => {
    await publish();
    const db = anon('ghost');
    const batch = writeBatch(db);
    batch.set(doc(db, 'published/q1/players/ghost'), { at: serverTimestamp() });
    batch.update(doc(db, 'published/q1'), { players: increment(1), name: 'Mine now' });
    await assertFails(batch.commit());
  });

  test('a marker cannot be deleted and spent again', async () => {
    await publish();
    await assertSucceeds(recordPlay(anon('ghost'), 'ghost'));
    await assertFails(deleteDoc(doc(anon('ghost'), 'published/q1/players/ghost')));
  });

  test('a marker cannot be created on somebody else’s behalf', async () => {
    await publish();
    await assertFails(recordPlay(anon('ghost'), 'someone-else'));
  });

  test('nobody can read who has played, and the roll cannot be listed', async () => {
    await publish();
    await assertSucceeds(recordPlay(anon('ghost'), 'ghost'));
    await assertFails(getDoc(doc(named('alice'), 'published/q1/players/ghost')));
  });
});

describe('profiles', () => {
  test('are public to read and private to write', async () => {
    await assertSucceeds(setDoc(doc(named('alice'), 'users/alice'), { displayName: 'Rory' }));
    await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'users/alice')));
    await assertFails(setDoc(doc(named('mallory'), 'users/alice'), { displayName: 'Not Rory' }));
  });

  test('cannot carry arbitrary fields', async () => {
    await assertFails(setDoc(doc(named('alice'), 'users/alice'), { displayName: 'Rory', admin: true }));
    await assertFails(setDoc(doc(named('alice'), 'users/alice'), { displayName: 'x'.repeat(41) }));
  });
});

describe('frozen versions', () => {
  /** Publishing: the quiz and its first snapshot, in one transaction. */
  const publishV1 = (db: ReturnType<typeof named>, uid: string) => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'published/q1'), publishedBody(uid));
    batch.set(doc(db, 'published/q1/versions/1'), { ...quizBody(), version: 1 });
    return batch.commit();
  };

  test('the first version is written alongside the quiz it belongs to', async () => {
    // The rule has to see the quiz as it *will* be, not as it is: at this
    // moment `published/q1` does not exist yet.
    await assertSucceeds(publishV1(named('alice'), 'alice'));
  });

  test('a snapshot cannot be written for somebody else’s quiz', async () => {
    await assertSucceeds(publishV1(named('alice'), 'alice'));
    await assertFails(setDoc(doc(named('mallory'), 'published/q1/versions/2'), { version: 2 }));
  });

  test('a published version is world-readable and never changes again', async () => {
    await assertSucceeds(publishV1(named('alice'), 'alice'));
    await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'published/q1/versions/1')));
    await assertFails(setDoc(doc(named('alice'), 'published/q1/versions/1'), { version: 1, name: 'Rewritten' }));
    await assertFails(deleteDoc(doc(named('alice'), 'published/q1/versions/1')));
  });
});
