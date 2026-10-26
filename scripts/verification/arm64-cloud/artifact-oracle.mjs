import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

// Independent small-format oracle for these new linked ARM64 ELF/PE fixtures.
// Extended ELF section numbering and every other format are rejected.
const range = (b, offset, size) => {
  assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset <= b.length && size <= b.length - offset, 'Out-of-file oracle range');
  return b.subarray(offset, offset + size);
};
const u64 = (b, at) => {
  const n = b.readBigUInt64LE(at);
  assert.ok(n <= BigInt(Number.MAX_SAFE_INTEGER), '64-bit offset exceeds safe integer');
  return Number(n);
};
const cstring = b => {
  const end = b.indexOf(0);
  assert.ok(end >= 0, 'Unterminated section name');
  return b.toString('latin1', 0, end);
};
export function arm64ImageOracle(b) {
  assert.ok(b.length >= 64 && b.length <= 256 * 1024 * 1024, 'Fixture file bounds');
  const sections = [];
  let format, machine;
  if (b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    format = 'elf';
    assert.equal(b[4], 2, 'ELF must be ELF64');
    assert.equal(b[5], 1, 'ELF must be little endian');
    machine = b.readUInt16LE(18);
    assert.equal(machine, 183, 'ELF e_machine must be EM_AARCH64');
    const start = u64(b, 40), width = b.readUInt16LE(58), count = b.readUInt16LE(60), namesIndex = b.readUInt16LE(62);
    assert.equal(width, 64); assert.ok(count > 0 && count <= 4096 && namesIndex < count);
    range(b, start, count * width);
    const nameHeader = start + namesIndex * width;
    const names = range(b, u64(b, nameHeader + 24), u64(b, nameHeader + 32));
    for (let i = 0; i < count; i++) {
      const h = start + i * width, type = b.readUInt32LE(h + 4), flags = b.readBigUInt64LE(h + 8);
      const nameAt = b.readUInt32LE(h);
      assert.ok(nameAt < names.length || (i === 0 && nameAt === 0));
      const name = cstring(names.subarray(nameAt));
      const offset = u64(b, h + 24), size = u64(b, h + 32);
      if (type !== 8) range(b, offset, size);
      sections.push({name, offset, size, file_backed:type !== 8,
        read_only:type === 1 && !(flags & 1n) && !(flags & 4n) && !!(flags & 2n) && !(flags & 0x800n)});
    }
  } else {
    format = 'pe';
    assert.equal(b.toString('latin1', 0, 2), 'MZ', 'Expected ELF or PE');
    const pe = b.readUInt32LE(0x3c);
    range(b, pe, 24);
    assert.equal(b.toString('latin1', pe, pe + 4), 'PE\0\0');
    machine = b.readUInt16LE(pe + 4);
    assert.equal(machine, 0xaa64, 'PE COFF machine must be ARM64');
    const count = b.readUInt16LE(pe + 6), optionalSize = b.readUInt16LE(pe + 20);
    assert.ok(count > 0 && count <= 4096);
    range(b, pe + 24, optionalSize); assert.equal(b.readUInt16LE(pe + 24), 0x20b, 'Expected PE32+');
    const start = pe + 24 + optionalSize; range(b, start, count * 40);
    for (let i = 0; i < count; i++) {
      const h = start + i * 40, nameBytes = range(b, h, 8), end = nameBytes.indexOf(0);
      const name = nameBytes.toString('latin1', 0, end < 0 ? 8 : end);
      const virtualSize = b.readUInt32LE(h + 8), rawSize = b.readUInt32LE(h + 16), offset = b.readUInt32LE(h + 20), flags = b.readUInt32LE(h + 36);
      range(b, offset, rawSize);
      const size = virtualSize === 0 ? rawSize : Math.min(virtualSize, rawSize);
      sections.push({name,offset,size,raw_size:rawSize,file_backed:true,
        read_only:!!(flags & 0x40000000) && !(flags & 0x80000000) && !(flags & 0x20000000) && !!(flags & 0x40)});
    }
  }
  return {format,machine,architecture:'arm64',bits:64,byte_order:'little',sections};
}
export function rustOracle(b, image) {
  const matches = image.sections.filter(s => s.name === '.dep-v0');
  assert.equal(matches.length, 1, 'Exactly one embedded .dep-v0 section is required');
  const section = matches[0];
  assert.ok(section.file_backed && section.size > 0 && section.size <= 1024 * 1024);
  const compressed = range(b, section.offset, section.size);
  const uncompressed = inflateSync(compressed, {maxOutputLength:Math.min(8 * 1024 * 1024, section.size * 64)});
  const embedded = JSON.parse(uncompressed.toString('utf8'));
  // This exact three-local-package closure was read from the existing real
  // cargo-auditable 0.7.7 producer fixture; indices and edges are intentional.
  const packages = embedded.packages.map(p => ({name:p.name,version:p.version,source:p.source,kind:p.kind ?? null,dependencies:p.dependencies ?? [],root:p.root ?? false}));
  assert.deepEqual(packages, [
    {name:'local-bytes',version:'1.4.2',source:'local',kind:null,dependencies:[],root:false},
    {name:'local-protocol',version:'0.2.3',source:'local',kind:null,dependencies:[0],root:false},
    {name:'rea-producer-fixture',version:'0.1.0',source:'local',kind:null,dependencies:[1],root:true}
  ]);
  assert.equal(embedded.format, 1, 'cargo-auditable 0.7.7 fixture format');
  const ranges = image.sections.filter(s=>s.read_only && s.size > 0)
    .map(s=>({offset:s.offset,end:s.offset+s.size})).sort((a,b)=>a.offset-b.offset);
  const merged=[];
  for (const r of ranges) {
    const last=merged.at(-1);
    if (last && r.offset <= last.end) last.end=Math.max(last.end,r.end);
    else merged.push({...r});
  }
  const hashes=[],seen=new Set();
  for (const r of merged) {
    const data=range(b,r.offset,r.end-r.offset).toString('latin1');
    for (const m of data.matchAll(/\/rustc\/([0-9a-f]{40})\//g)) {
      if (seen.has(m[1])) continue;
      assert.ok(hashes.length < 64); seen.add(m[1]); hashes.push({hash:m[1],file_offset:r.offset+m.index});
    }
  }
  return {section,metadata:{section_name:'.dep-v0',file_offset:section.offset,section_bytes:section.size,compressed_bytes:section.size,uncompressed_bytes:uncompressed.length,format_version:embedded.format,packages,root_package_index:2,dependency_edges:[{from_index:1,to_index:0},{from_index:2,to_index:1}],cyclic_dependency_indices:[]},rustc_commit:hashes.length ? {evidence_kind:'inferred',hashes} : null};
}
