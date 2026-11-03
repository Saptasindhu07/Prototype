import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import mongoose from 'mongoose';
import express from 'express';
import routes from '../src/routes/index.js';
import { errorHandler, notFound } from '../src/middlewares/error.middleware.js';
import { Researcher } from '../src/models/researcher.model.js';

test('researcher HTTP endpoints', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(notFound);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/researchers`;
  const id = new mongoose.Types.ObjectId().toString();
  const sample = { _id: id, name: 'Test Researcher' };
  const post = (body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  await t.test('POST creates researcher and excludes server-managed fields', async (t) => {
    t.mock.method(Researcher, 'create', async (input) => {
      assert.equal(input.name, sample.name);
      assert.equal(input._id, undefined);
      assert.equal(input.createdAt, undefined);
      assert.equal(input.lastSyncedAt, undefined);
      return sample;
    });
    const response = await post({ ...sample, createdAt: '2000-01-01', lastSyncedAt: '2000-01-01' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/researchers/${id}`);
    assert.deepEqual(await response.json(), { data: sample });
  });

  await t.test('GET lists with bounded pagination', async (t) => {
    const query = {
      sort(value) { assert.deepEqual(value, { createdAt: -1, _id: -1 }); return this; },
      skip(value) { assert.equal(value, 2); return this; },
      limit(value) { assert.equal(value, 2); return this; },
      async lean() { return [sample]; },
    };
    t.mock.method(Researcher, 'find', () => query);
    const response = await fetch(`${url}?page=2&limit=2`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [sample], page: 2, limit: 2 });
  });

  await t.test('GET returns one researcher or 404', async (t) => {
    t.mock.method(Researcher, 'findById', (value) => ({
      async lean() { return value === id ? sample : null; },
    }));
    const response = await fetch(`${url}/${id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: sample });
    assert.equal((await fetch(`${url}/${new mongoose.Types.ObjectId()}`)).status, 404);
  });

  await t.test('bad IDs, pagination, bodies and malformed JSON return 400', async () => {
    assert.equal((await fetch(`${url}/bad-id`)).status, 400);
    for (const query of ['page=0', 'page=1.5', 'limit=101', 'limit=nope']) {
      assert.equal((await fetch(`${url}?${query}`)).status, 400);
    }
    for (const body of [{}, [], { name: ' ' }, { name: 123 }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal((await fetch(url, { method: 'POST' })).status, 400);
    assert.equal((await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })).status, 400);
  });

  await t.test('schema validation errors return 400 with field paths', async (t) => {
    t.mock.method(Researcher, 'create', async (input) => {
      await new Researcher(input).validate();
    });
    const response = await post({ name: 'Test', affiliations: [{}] });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.fields.includes('affiliations.0.institution'));
  });

  await t.test('duplicate external IDs return 409', async (t) => {
    t.mock.method(Researcher, 'create', async () => { throw Object.assign(new Error(), { code: 11000 }); });
    assert.equal((await post({ name: 'Test' })).status, 409);
  });

  await t.test('database failures do not leak internal details', async (t) => {
    t.mock.method(Researcher, 'create', async () => { throw new Error('private database details'); });
    const response = await post({ name: 'Test' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { message: 'Internal server error.' } });
  });
});
