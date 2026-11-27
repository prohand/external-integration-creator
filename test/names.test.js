import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRepoName, isValidRepoName, nameKeys, namesMatch, normalizeName, slugify } from '../src/names.js';

test('normalizeName removes case, accents and punctuation', () => {
  assert.equal(normalizeName('Météo-France (Vigilance)'), 'meteofrancevigilance');
  assert.equal(normalizeName('  Oral-B  '), 'oralb');
});

test('nameKeys ignores noise words like "gladys"', () => {
  assert.ok(nameKeys('gladys-google-cast').includes('googlecast'));
  assert.ok(nameKeys('GladysAirplay').includes('airplay'));
  assert.ok(namesMatch('Gladys AirPlay', 'AirPlay'));
  assert.ok(!namesMatch('Google Cast', 'Google'));
});

test('slugify and defaultRepoName build a clean repository name', () => {
  assert.equal(slugify('Météo France (Vigilance)!'), 'meteo-france-vigilance');
  assert.equal(defaultRepoName('Oral-B'), 'gladys-oral-b');
  assert.equal(defaultRepoName('Gladys Velux'), 'gladys-velux');
});

test('isValidRepoName follows the GitHub rules', () => {
  assert.ok(isValidRepoName('gladys-oral-b'));
  assert.ok(!isValidRepoName('bad name'));
  assert.ok(!isValidRepoName('..'));
  assert.ok(!isValidRepoName('x.git'));
  assert.ok(!isValidRepoName(''));
});
