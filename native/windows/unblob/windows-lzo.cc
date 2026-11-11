#include <cstddef>
#include <cstdint>
#include "lzokay.hpp"

// Fixed caller-owned buffers; no allocation, resizing, paths, or process creation.
extern "C" __declspec(dllexport) int __cdecl rea_lzo_decode(
    const uint8_t *source, size_t source_size, uint8_t *output, size_t output_size,
    size_t *written) noexcept {
  if (!source || !output || !written || source_size > 128ull * 1024 * 1024 ||
      output_size > 128ull * 1024 * 1024) return -5;
  *written = 0;
  return static_cast<int>(lzokay::decompress(source, source_size, output, output_size, *written));
}
