import https from 'node:https';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const out=resolve(process.argv[2]);await mkdir(out,{recursive:true});
const url='https://download.visualstudio.microsoft.com/download/pr/c95450be-0a45-4779-b142-33f567ccfd6e/a871a5ff41acebbe5037455fd6f51fcd4907b47d8f3c9860871ea0b222a2fd45/VisualStudio.vsman';
const r={status:'running',url,expected_bytes:30443686,expected_sha256:'a871a5ff41acebbe5037455fd6f51fcd4907b47d8f3c9860871ea0b222a2fd45',maximum_bytes:52428800,timeout_ms:60000,request_headers:{'Accept-Encoding':'identity','Cache-Control':'no-cache, no-transform'},started_at:new Date().toISOString(),http_eof:false,admitted:false,run_id:process.env.GITHUB_RUN_ID,run_attempt:process.env.GITHUB_RUN_ATTEMPT};
const handle=await open(join(out,'VisualStudio.vsman.raw'),'wx'),hash=createHash('sha256');let bytes=0;
try{await new Promise((done,fail)=>{const request=https.get(url,{headers:r.request_headers,signal:AbortSignal.timeout(60000)},response=>{r.http_status=response.statusCode;r.headers=response.headers;if(response.statusCode!==200){response.resume();fail(new Error('HTTP '+response.statusCode));return;}response.on('error',fail);(async()=>{try{for await(const chunk of response){bytes+=chunk.length;if(bytes>r.maximum_bytes)throw new Error('byte-limit');hash.update(chunk);await handle.write(chunk);}r.http_eof=true;done();}catch(e){request.destroy();fail(e);}})();});request.on('error',fail);});r.full_sha256=hash.digest('hex');r.bytes=bytes;r.http_length_matches=Number(r.headers['content-length'])===bytes;r.fixed_length_matches=bytes===r.expected_bytes;r.fixed_sha_matches=r.full_sha256===r.expected_sha256;r.admitted=r.http_eof&&r.http_length_matches&&r.fixed_length_matches&&r.fixed_sha_matches&&!r.headers['content-encoding'];r.status=r.admitted?'passed-integrity':'complete-rejected-integrity';if(!r.admitted)process.exitCode=2;
}catch(e){r.status='incomplete-or-failed';r.error={name:e.name,message:e.message};r.received_prefix_sha256=hash.digest('hex');r.bytes=bytes;process.exitCode=2;}finally{await handle.close();r.completed_at=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(r,null,2));console.log(JSON.stringify(r));}

// This independent channel observation cannot change the fixed manifest result.
await observeLatestChannel();

async function observeLatestChannel() {
  const receipt = {
    status: 'running', source_url: 'https://aka.ms/vs/17/release/channel',
    maximum_bytes: 2 * 1024 * 1024, timeout_ms: 30_000, maximum_redirects: 3,
    request_headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache, no-transform' },
    started_at: new Date().toISOString(), http_eof: false, redirects: [],
    fixed_manifest_admission_changed: false, admitted: false,
    run_id: r.run_id, run_attempt: r.run_attempt,
  };
  const rawPath = join(out, 'latest-channel.chman.raw');
  const receiptPath = join(out, 'latest-channel-receipt.json');
  const chunks = [];
  let receivedBytes = 0;
  let rawSaved = false;
  const validateUrl = (value) => {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        (parsed.port && parsed.port !== '443') ||
        !['aka.ms', 'download.visualstudio.microsoft.com'].includes(parsed.hostname)) {
      throw new Error('Untrusted channel URL');
    }
    return parsed;
  };
  try {
    let current = validateUrl(receipt.source_url);
    const signal = AbortSignal.timeout(receipt.timeout_ms);
    for (;;) {
      const response = await new Promise((done, fail) => {
        const request = https.get(current, { headers: receipt.request_headers, signal }, done);
        request.once('error', fail);
      });
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (receipt.redirects.length >= receipt.maximum_redirects) throw new Error('Channel redirect limit');
        if (typeof response.headers.location !== 'string') throw new Error('Channel redirect has no Location');
        const next = validateUrl(new URL(response.headers.location, current).href);
        receipt.redirects.push({ source_url: current.href, status, final_url: next.href });
        current = next;
        continue;
      }
      Object.assign(receipt, { final_url: current.href, http_status: status, headers: response.headers });
      if (status !== 200) {
        response.destroy();
        throw new Error('Channel HTTP ' + status);
      }
      const declared = response.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > receipt.maximum_bytes)) {
        response.destroy();
        throw new Error('Channel declared length exceeds bound or is malformed');
      }
      for await (const chunk of response) {
        if (receivedBytes + chunk.length > receipt.maximum_bytes) throw new Error('Channel byte limit');
        chunks.push(chunk);
        receivedBytes += chunk.length;
      }
      receipt.http_eof = response.complete;
      if (!receipt.http_eof) throw new Error('Channel HTTP body incomplete');
      const raw = Buffer.concat(chunks, receivedBytes);
      Object.assign(receipt, { bytes: receivedBytes, full_sha256: createHash('sha256').update(raw).digest('hex') });
      await writeFile(rawPath, raw, { flag: 'wx' });
      rawSaved = true;
      receipt.raw_path = rawPath;
      receipt.http_length_matches = declared === undefined ? null : Number(declared) === receivedBytes;
      if (receipt.http_length_matches === false) throw new Error('Channel HTTP length mismatch');
      if (response.headers['content-encoding'] && response.headers['content-encoding'].trim().toLowerCase() !== 'identity') throw new Error('Channel Content-Encoding is not identity');
      const channel = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      receipt.manifest_version = channel.manifestVersion;
      receipt.channel_identity = channel.info;
      if (!Array.isArray(channel.channelItems)) throw new Error('Channel channelItems must be an array');
      const manifests = channel.channelItems.filter((item) => item?.id === 'Microsoft.VisualStudio.Manifests.VisualStudio');
      if (manifests.length !== 1 || !Array.isArray(manifests[0].payloads)) throw new Error('Channel manifest identity is missing or ambiguous');
      const manifest = manifests[0];
      receipt.selected_manifest = {
        id: manifest.id, version: manifest.version,
        payloads: manifest.payloads.filter((payload) => payload?.fileName === 'VisualStudio.vsman').map((payload) => ({
          fileName: payload.fileName, url: payload.url, size: payload.size, sha256: payload.sha256,
        })),
      };
      if (receipt.selected_manifest.payloads.length !== 1) throw new Error('Channel manifest payload is missing or ambiguous');
      const payload = receipt.selected_manifest.payloads[0];
      if (typeof manifest.version !== 'string' || !manifest.version ||
          typeof payload.url !== 'string' || !Number.isSafeInteger(payload.size) || payload.size <= 0 ||
          !/^[a-f0-9]{64}$/.test(payload.sha256 ?? '')) throw new Error('Channel manifest identity or payload fields are malformed');
      validateUrl(payload.url);
      receipt.status = 'observed-latest-channel';
      receipt.limitation = 'Diagnostic channel bytes only; no new manifest or CRT package was downloaded, and the fixed manifest integrity result is unchanged.';
      break;
    }
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = { name: error.name, message: error.message };
    receipt.bytes = receivedBytes;
    if (!receipt.http_eof) receipt.received_prefix_sha256 = createHash('sha256').update(Buffer.concat(chunks, receivedBytes)).digest('hex');
    if (!rawSaved && !receipt.http_eof && chunks.length) {
      try {
        await writeFile(rawPath, Buffer.concat(chunks, receivedBytes), { flag: 'wx' });
        receipt.raw_path = rawPath;
      } catch (saveError) {
        receipt.raw_write_error = { name: saveError.name, message: saveError.message };
      }
    }
  }
  receipt.completed_at = new Date().toISOString();
  try {
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  } catch (error) {
    receipt.receipt_write_error = { name: error.name, message: error.message };
  }
  console.log(JSON.stringify({
    observation: 'latest-channel', status: receipt.status, source_url: receipt.source_url,
    final_url: receipt.final_url, bytes: receipt.bytes, full_sha256: receipt.full_sha256,
    selected_manifest: receipt.selected_manifest, error: receipt.error,
    raw_write_error: receipt.raw_write_error, receipt_write_error: receipt.receipt_write_error,
    receipt_path: receiptPath, fixed_manifest_admission_changed: false,
  }));
}
