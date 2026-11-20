import assert from 'node:assert/strict';
import test from 'node:test';
import { findUrls } from '../src/linkify.mjs';

test('a pipe-separated list of nested query URLs is one link', () => {
  const url = 'https://example.org/?urls=https://one.example/|https://two.example/';
  assert.deepEqual(findUrls(url), [{ start: 0, end: url.length, url }]);
});

test('prose separators split until a nested list starts; offsets use original text', () => {
  const first = 'https://first.example/path';
  const second = 'http://second.example/?q=plain';
  const list = String.raw`https://example.org/#HTTP://one.example/\https://two.example/|https://three.example/`;
  const last = 'https://last.example/';
  const text = `📋 (${first})|${second}\\${list}. Then ${last}!`;
  assert.deepEqual(findUrls(text), [first, second, list, last].map(url => ({
    start: text.indexOf(url), end: text.indexOf(url) + url.length, url,
  })));
});
