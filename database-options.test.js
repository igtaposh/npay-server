import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseOptions, shouldMigrateOnStartup } from './config/databaseOptions.js';
const pooled = 'postgresql://test:fake@ep-test-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const direct = pooled.replace('-pooler.', '.');
test('Neon verifies TLS, enables channel binding, and ignores legacy DB fields', () => {
 const options = databaseOptions({DATABASE_URL:pooled, DB_HOST:'localhost'});
 const client = new pg.Client(options);
 assert.equal(client.host,'ep-test-pooler.us-east-1.aws.neon.tech');
 assert.equal(client.ssl.rejectUnauthorized,true);
 assert.equal(client.enableChannelBinding,true);
 assert.equal(options.max,10);
});
test('session and migration pool requires a direct URL', () => {
 assert.throws(()=>databaseOptions({DATABASE_URL:pooled},{direct:true}),/direct endpoint/);
 const options = databaseOptions({DATABASE_URL:pooled,DATABASE_URL_UNPOOLED:direct},{direct:true});
 assert.equal(new pg.Client(options).host,'ep-test.us-east-1.aws.neon.tech');
 assert.equal(options.max,3);
});
test('local development retains pg configuration', () => {
 assert.equal(databaseOptions({DB_HOST:'127.0.0.1',DB_NAME:'test'}).database,'test');
 assert.throws(()=>databaseOptions({NODE_ENV:'production'}),/DATABASE_URL/);
});
test('invalid URLs and unbounded pool values fail safely', () => {
 assert.throws(()=>databaseOptions({DATABASE_URL:'secret-invalid'}),/^Error: Invalid database connection URL\.$/);
 for (const value of ['0','-1','NaN','1.5']) assert.throws(()=>databaseOptions({DB_POOL_MAX:value}),/positive integer/);
});
test('production and Neon startup never implicitly migrate', () => {
 assert.equal(shouldMigrateOnStartup({NODE_ENV:'production'}),false);
 assert.equal(shouldMigrateOnStartup({DATABASE_URL:pooled}),false);
 assert.equal(shouldMigrateOnStartup({}),true);
 assert.equal(shouldMigrateOnStartup({NODE_ENV:'production',RUN_DB_MIGRATIONS:'true'}),true);
 assert.equal(shouldMigrateOnStartup({RUN_DB_MIGRATIONS:'false'}),false);
 assert.throws(()=>shouldMigrateOnStartup({RUN_DB_MIGRATIONS:'yes'}),/true or false/);
});
