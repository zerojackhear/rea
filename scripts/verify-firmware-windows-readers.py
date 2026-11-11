"""Deterministic producer-boundary checks; not a substitute for CLI/MCP tests."""
import io
import json
import logging
import random
import struct
from types import SimpleNamespace
import unittest
import zlib
import structlog

from unblob.windows_flash_codecs import MAX_NODE_BYTES, decode_flash_node
from unblob.windows_jffs2 import Inode, _fragments
from unblob.handlers.archive.partclone import PartcloneHandler, partclone_image_layout
from unblob.file_utils import InvalidInputFormat
from unblob.file_utils import File
from unblob.handlers.archive.arc import ARCHandler
from unblob.handlers.filesystem.android.sparse import SparseHandler


class FlashBoundaries(unittest.TestCase):
    def test_sparse_extended_headers_and_all_truncation_boundaries(self):
        raw = b"SOURCE00"
        data = (struct.pack("<IHHHHIIII", 0xED26FF3A, 1, 7, 36, 16, 4, 2, 1, 0)
                + b"FILE-EXT" + struct.pack("<HHII", 0xCAC1, 0, 2, 24)
                + b"CHNK" + raw)
        source = io.BytesIO(data)
        _, chunks = SparseHandler().read_layout(source)
        self.assertEqual([(c.output_offset, c.output_size) for c in chunks], [(0, 8)])
        self.assertEqual(source.tell(), len(data))
        for cut in range(len(data)):
            with self.subTest(cut=cut), self.assertRaises((ValueError, EOFError)):
                _, chunks = SparseHandler().read_layout(io.BytesIO(data[:cut]))
                list(chunks)

    def test_sparse_rejects_ambiguous_lengths_before_materialization(self):
        header = struct.pack("<IHHHHIIII", 0xED26FF3A, 1, 0, 28, 12, 4, 1, 1, 0)
        for kind, blocks, payload in [(0xCAC1, 1, b""), (0xCAC2, 1, b"12345678"),
                (0xCAC3, 1, b"1234"), (0xCAC4, 1, b"1234"),
                (0xCAC3, 2, b""), (0xCAC3, 0, b""), (0xCAFF, 1, b"")]:
            chunk = struct.pack("<HHII", kind, 0, blocks, 12+len(payload))+payload
            with self.subTest(kind=kind, blocks=blocks), self.assertRaises((ValueError, EOFError)):
                _, chunks = SparseHandler().read_layout(io.BytesIO(header+chunk))
                list(chunks)

    def test_arc_method_one_does_not_consume_a_size_word(self):
        entry = b"\x1a\x01"+b"SOURCE.BIN\0\0\0"+struct.pack("<IHHH", 4, 0, 0, 0)+b"data"
        self.assertEqual(len(entry), 29)
        with File.from_bytes(entry+b"\x1a\0") as source:
            chunk = ARCHandler().calculate_chunk(source, 0)
            self.assertEqual(chunk.end_offset, 31)
        for tail in (b"", b"\x1a", b"XX", b"\x1a\xff"):
            with File.from_bytes(entry+tail) as source, self.subTest(tail=tail):
                with self.assertRaises((ValueError, EOFError)):
                    ARCHandler().calculate_chunk(source, 0)

    def partclone_header(self, **changes):
        # Producer structure with deliberately small geometry; no parser copy.
        fields = dict(magic=b"partclone-image\0", image_version_txt=b"0002",
            endian=b"\xde\xc0", image_version=2, feature_size=18,
            number_of_bits_for_CPU=64, reseed_checksum=1, fs_total_block_count=16,
            fs_used_block_count_bitmap=3, fs_block_size=512, fs_size=8192,
            checksum_mode=0x20, checksum_size=4, blocks_per_checksum=2, bitmap_mode=1)
        fields.update(changes)
        return PartcloneHandler().cparser_le.partclone_header_t(**fields)

    def test_partclone_bitmap_crc_is_independent_of_data_checksums(self):
        h = self.partclone_header(checksum_mode=0, checksum_size=0, blocks_per_checksum=0)
        self.assertEqual(partclone_image_layout(h)['image_bytes'], 110 + 2 + 4 + 3 * 512)
        self.assertEqual(partclone_image_layout(self.partclone_header())['image_bytes'],
                         110 + 2 + 4 + 3 * 512 + 2 * 4)

    def test_partclone_invalid_geometry_and_checksum_groups(self):
        for changes in [dict(blocks_per_checksum=0), dict(fs_block_size=0),
                dict(fs_size=0), dict(fs_total_block_count=0), dict(checksum_size=8),
                dict(fs_used_block_count_bitmap=17), dict(bitmap_mode=0), dict(feature_size=4096)]:
            with self.assertRaises(InvalidInputFormat):
                partclone_image_layout(self.partclone_header(**changes))

    def test_journal_ranges_against_bytewise_replay(self):
        rng = random.Random(20261111)
        for trial in range(600):
            expected = []
            nodes = []
            for version in range(1, rng.randrange(3, 40)):
                size = rng.randrange(0, 256)
                expected = expected[:size] + [None] * max(0, size - len(expected))
                offset = rng.randrange(size + 1)
                count = rng.randrange(size - offset + 1)
                data = bytes(rng.randrange(256) for _ in range(count))
                expected[offset:offset + count] = data
                nodes.append(Inode(SimpleNamespace(version=version, isize=size,
                    offset=offset, dsize=count), version, data))
            if None in expected:
                with self.assertRaisesRegex(ValueError, "unproven gap|incomplete"):
                    _fragments(nodes)
            else:
                actual = b"".join(node.encoded[start-node.header.offset:stop-node.header.offset]
                                   for start, stop, node in _fragments(nodes))
                self.assertEqual(actual, bytes(expected), f"trial {trial}")

    def test_flash_size_limit_precedes_allocation(self):
        for codec in ("none", "zero", "rtime", "zlib", "lzo", "lzma", "lzma-no-size", "zstd"):
            with self.assertRaisesRegex(ValueError, "buffer bound"):
                decode_flash_node(b"", MAX_NODE_BYTES + 1, codec)

    def test_rtime_rejects_overrun_and_truncation(self):
        self.assertEqual(decode_flash_node(b"A\x03", 4, "rtime"), b"AAAA")
        for data, size in ((b"A", 4), (b"A\x04", 4), (b"A\0", 4), (b"A\0B\0", 1)):
            with self.assertRaises(ValueError):
                decode_flash_node(data, size, "rtime")

    def test_no_zlib_trailing_truncation_or_length_repair(self):
        data = zlib.compress(b"known bytes")
        self.assertEqual(decode_flash_node(data, 11, "zlib"), b"known bytes")
        for encoded, size in ((data[:-1], 11), (data + b"extra", 11), (data, 10), (data, 12)):
            with self.assertRaises(ValueError):
                decode_flash_node(encoded, size, "zlib")


if __name__ == "__main__":
    structlog.configure(wrapper_class=structlog.make_filtering_bound_logger(logging.ERROR))
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FlashBoundaries))
    print(json.dumps({"status": "passed" if result.wasSuccessful() else "failed",
        "tests": result.testsRun, "journal_replays": 600, "scope": "producer boundaries only"}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
