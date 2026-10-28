import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeOptions, profileLabel } from '../src/profiles.js';

test('Chrome profile labels use profile metadata without exposing command lines or account data', async () => {
  assert.deepEqual(chromeOptions('--profile-directory="Profile 1" --user-data-dir="/custom/chrome data"'), { directory: 'Profile 1', userData: '/custom/chrome data' });
  const read = async () => JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work', user_name: 'private@example.test' } } } });
  assert.equal(await profileLabel('chrome', '--profile-directory="Profile 1"', read), 'Work');
  assert.equal(await profileLabel('chrome', '--profile-directory="Profile 2"', read), 'Profile 2');
  assert.equal(await profileLabel('chrome', '--type=renderer', read), undefined);
  assert.equal(await profileLabel('editor', '--profile-directory="Profile 1"', read), undefined);
});
