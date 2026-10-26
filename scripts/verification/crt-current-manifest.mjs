#!/usr/bin/env node
// One fixed GET for a second, independent channel/manifest pair observed on October 26.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.argv.length !== 3) throw new Error('Usage: crt-current-manifest.mjs OUTPUT_DIRECTORY');
const out = resolve(process.argv[2]);
await mkdir(out, { recursive: true });
const url = 'https://download.visualstudio.microsoft.com/download/pr/4bc08c27-bd31-470c-9a30-3b62707fbf0f/5bd3b0b2ae509af2e9559b852f78545df0bf2c081dd850caed76f1dc134c511e/VisualStudio.vsman';
const rawPath = join(out, 'VisualStudio.vsman.raw');
const receiptPath = join(out, 'receipt.json');
const receipt = {
  schema_version: 1, status: 'running', url, raw_path: rawPath,
  expected_bytes: 30443792,
  expected_sha256: '5bd3b0b2ae509af2e9559b852f78545df0bf2c081dd850caed76f1dc134c511e',
  maximum_bytes: 50 * 1024 * 1024, timeout_ms: 60_000, maximum_redirects: 0,
  automatic_decompression: false, request_count: 0,
  request_headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache, no-transform' },
  source_channel_observation: {
    run_id: '40314709940', job_id: '121544281696',
    source_url: 'https://aka.ms/vs/17/release/channel',
    final_url: 'https://download.visualstudio.microsoft.com/download/pr/4bc08c27-bd31-470c-9a30-3b62707fbf0f/1786d42a74c7ba31aa2670316eda6a9c9de755ce1ca87b8f7ed8766dcdf9b4e3/VisualStudio.17.Release.chman',
    bytes: 91744, sha256: '9312f33527b6f89ee6290ac59190584d137959dadd0a3334c40ea3de188ab5c4',
    manifest_id: 'Microsoft.VisualStudio.Manifests.VisualStudio', manifest_version: '17.14.37824.6',
  },
  limitation: 'Second independent pair derived from the October 26 channel observation; this does not change the earlier a871a5ff manifest pair or its failed integrity result.',
  started_at: new Date().toISOString(), http_eof: false, admitted: false, raw_created: false,
  run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  workflow_head: process.env.GITHUB_SHA, node_version: process.version,
  native_os: process.platform, node_arch: process.arch,
};
let handle;
let receivedBytes = 0;
let request;
try {
  handle = await open(rawPath, 'wx');
  receipt.raw_created = true;
  receipt.request_count = 1;
  const response = await new Promise((done, fail) => {
    request = https.get(url, {
      headers: receipt.request_headers, signal: AbortSignal.timeout(receipt.timeout_ms),
    }, done);
    request.once('error', fail);
  });
  Object.assign(receipt, { http_status: response.statusCode, response_url: url, headers: response.headers });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error('HTTP ' + response.statusCode + '; redirects are not followed');
  }
  const declared = response.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > receipt.maximum_bytes)) {
    response.destroy();
    throw new Error('HTTP Content-Length is malformed or exceeds the byte limit');
  }
  for await (const chunk of response) {
    receivedBytes += chunk.length;
    if (receivedBytes > receipt.maximum_bytes) throw new Error('Response exceeds the byte limit');
    await handle.writeFile(chunk);
  }
  receipt.http_eof = response.complete;
  if (!receipt.http_eof) throw new Error('HTTP response did not complete');
} catch (error) {
  request?.destroy();
  receipt.status = 'incomplete-or-failed';
  receipt.error = { name: error.name, message: error.message };
  process.exitCode = 2;
} finally {
  if (handle) {
    try { await handle.close(); }
    catch (error) {
      receipt.close_error = { name: error.name, message: error.message };
    }
  }
  // Hash the closed artifact so its receipt also describes a partial disk write accurately.
  if (receipt.raw_created) {
    try {
      const hash = createHash('sha256');
      let rawBytes = 0;
      for await (const chunk of createReadStream(rawPath)) {
        rawBytes += chunk.length;
        if (rawBytes > receipt.maximum_bytes) throw new Error('Raw artifact exceeds the byte limit');
        hash.update(chunk);
      }
      receipt.bytes = rawBytes;
      const digest = hash.digest('hex');
      if (receipt.http_eof && rawBytes === receivedBytes) receipt.full_sha256 = digest;
      else receipt.retained_prefix_sha256 = digest;
    } catch (error) {
      receipt.raw_hash_error = { name: error.name, message: error.message };
    }
  }
  receipt.http_length_matches = /^\d+$/.test(receipt.headers?.['content-length'] ?? '') && Number(receipt.headers['content-length']) === receipt.bytes;
  receipt.fixed_length_matches = receipt.bytes === receipt.expected_bytes;
  receipt.fixed_sha_matches = receipt.full_sha256 === receipt.expected_sha256;
  const encoding = receipt.headers?.['content-encoding'];
  receipt.identity_encoding = !encoding || encoding.trim().toLowerCase() === 'identity';
  const failed = receipt.error || receipt.close_error || receipt.raw_hash_error;
  receipt.admitted = !failed && receipt.http_eof && receipt.http_length_matches && receipt.fixed_length_matches && receipt.fixed_sha_matches && receipt.identity_encoding;
  receipt.status = failed ? 'incomplete-or-failed' : receipt.admitted ? 'passed-integrity' : 'complete-rejected-integrity';
  if (!receipt.admitted) process.exitCode = 2;
  Object.assign(receipt, { received_bytes: receivedBytes, completed_at: new Date().toISOString() });
  try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    receipt.receipt_write_error = { name: error.name, message: error.message };
    receipt.admitted = false;
    receipt.status = 'failed-to-save-receipt';
    process.exitCode = 2;
  }
  console.log(JSON.stringify(receipt, null, 2));
}
