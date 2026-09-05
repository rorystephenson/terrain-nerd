import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoute, routeUrl, sameRoute, shareUrl } from './route.ts';

const at = (href: string) => parseRoute('https://terrain.example' + href);

test('a share link reads as the quiz it names', () => {
  assert.deepEqual(at('/q/abc123'), { at: 'quiz', quizId: 'abc123', version: undefined });
});

test('the query form is understood too, so a link works without a host rewrite', () => {
  assert.deepEqual(at('/?q=abc123'), { at: 'quiz', quizId: 'abc123', version: undefined });
  // And it wins where both are present, being the more explicit of the two.
  assert.deepEqual(at('/q/aaa?q=bbb'), { at: 'quiz', quizId: 'bbb', version: undefined });
});

test('an exact version can be addressed', () => {
  assert.deepEqual(at('/q/abc123?v=2'), { at: 'quiz', quizId: 'abc123', version: 2 });
  assert.deepEqual(at('/?q=abc123&v=3'), { at: 'quiz', quizId: 'abc123', version: 3 });
});

test('a nonsense version is no version, not an error', () => {
  for (const v of ['0', '-1', 'two', '1.5', '']) {
    assert.deepEqual(at(`/q/abc123?v=${v}`), { at: 'quiz', quizId: 'abc123', version: undefined }, v);
  }
});

test('the builder has an address, with and without a quiz', () => {
  assert.deepEqual(at('/build'), { at: 'build', quizId: null });
  assert.deepEqual(at('/build/abc123'), { at: 'build', quizId: 'abc123' });
});

test('anything unrecognised is the list, never an error', () => {
  // A URL is the one input that arrives mangled by other people's software.
  for (const href of ['/', '/nope', '/q', '/q/', '/q/a/b/c', '/q/has spaces', '/q/' + 'x'.repeat(100)]) {
    assert.deepEqual(at(href), { at: 'list' }, href);
  }
  assert.deepEqual(parseRoute('not a url at all'), { at: 'list' });
  assert.deepEqual(parseRoute(''), { at: 'list' });
});

test('an id that is not an id is not a quiz', () => {
  // Path traversal and script-ish shapes fall through to the list.
  for (const bad of ['..', '.%2e', '<script>', 'a/b']) {
    assert.equal(at('/q/' + bad).at, 'list', bad);
  }
});

test('every route round-trips through its own URL', () => {
  const routes = [
    { at: 'list' as const },
    { at: 'build' as const, quizId: null },
    { at: 'build' as const, quizId: 'abc123' },
    { at: 'quiz' as const, quizId: 'abc123', version: undefined },
    { at: 'quiz' as const, quizId: 'abc123', version: 4 },
  ];
  for (const route of routes) {
    assert.deepEqual(parseRoute('https://terrain.example' + routeUrl(route)), route, routeUrl(route));
  }
});

test('only the shareable form is ever produced', () => {
  assert.equal(routeUrl({ at: 'quiz', quizId: 'abc' }), '/q/abc');
  assert.equal(routeUrl({ at: 'quiz', quizId: 'abc', version: 2 }), '/q/abc?v=2');
  assert.equal(routeUrl({ at: 'list' }), '/');
});

test('a share link is absolute, and survives a trailing slash on the origin', () => {
  assert.equal(shareUrl('https://terrain.example', 'abc'), 'https://terrain.example/q/abc');
  assert.equal(shareUrl('https://terrain.example/', 'abc'), 'https://terrain.example/q/abc');
  assert.equal(shareUrl('https://terrain.example', 'abc', 2), 'https://terrain.example/q/abc?v=2');
});

test('routes compare by where they point', () => {
  assert.equal(sameRoute({ at: 'quiz', quizId: 'a' }, { at: 'quiz', quizId: 'a' }), true);
  assert.equal(sameRoute({ at: 'quiz', quizId: 'a' }, { at: 'quiz', quizId: 'b' }), false);
  assert.equal(sameRoute({ at: 'list' }, { at: 'build', quizId: null }), false);
});
