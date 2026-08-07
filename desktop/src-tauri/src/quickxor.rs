/* QuickXorHash — the content hash OneDrive for Business and SharePoint publish for an item.
 *
 * WHY THIS EXISTS. The cloud export's skip-if-unchanged rule needs a way to prove a local file and
 * the remote copy hold the same bytes. Drive publishes an MD5 and `file_md5` answers it. Graph
 * publishes `file.hashes.quickXorHash`, which is not a general-purpose digest — it is Microsoft's
 * own 160-bit XOR construction, and nothing else computes it. Without it the OneDrive export has
 * only the file size to go on, and size alone is exactly the comparison Drive's uploader already
 * refuses to trust: a re-export would silently keep the client's OLD file whenever an edit happened
 * to preserve the byte count.
 *
 * It is a faithful port of Microsoft's reference implementation (the `QuickXorHash` HashAlgorithm
 * published with the OneDrive API docs). The constants are the format, not tuning: 160 bits wide,
 * an 11-bit rotation per byte position, the last cell only 32 bits wide, and the file length XORed
 * into the trailing 8 bytes at the end. Change any of them and the result is a stable hash of
 * something that is not QuickXorHash — which fails in the safe direction (nothing ever matches, so
 * every file re-uploads) but silently costs the whole optimisation.
 *
 * Streaming, in `update`-sized blocks, because the caller hashes deliverables that run to hundreds
 * of megabytes and must not hold one in memory to decide whether to skip it. `shift_so_far` is what
 * makes that legal: a byte's rotation depends on its position in the WHOLE file, so each block
 * resumes where the last one stopped. `hashes_the_same_whatever_the_block_size` pins it.
 */

const WIDTH_IN_BITS: usize = 160;
const SHIFT: usize = 11;
const BITS_IN_LAST_CELL: usize = 32;
/// 160 bits held as u64s: two full cells and one 32-bit tail.
const CELLS: usize = (WIDTH_IN_BITS - 1) / 64 + 1;
const HASH_BYTES: usize = WIDTH_IN_BITS / 8;

pub struct QuickXorHash {
    data: [u64; CELLS],
    shift_so_far: usize,
    length_so_far: u64,
}

impl Default for QuickXorHash {
    fn default() -> Self {
        Self { data: [0; CELLS], shift_so_far: 0, length_so_far: 0 }
    }
}

impl QuickXorHash {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, block: &[u8]) {
        let mut vector_array_index = self.shift_so_far / 64;
        let mut vector_offset = self.shift_so_far % 64;
        let iterations = block.len().min(WIDTH_IN_BITS);

        for i in 0..iterations {
            let is_last_cell = vector_array_index == CELLS - 1;
            let bits_in_vector_cell = if is_last_cell { BITS_IN_LAST_CELL } else { 64 };

            if vector_offset <= bits_in_vector_cell - 8 {
                // The byte fits inside one cell: fold in every byte of the block at this position.
                let mut j = i;
                while j < block.len() {
                    self.data[vector_array_index] ^= (block[j] as u64) << vector_offset;
                    j += WIDTH_IN_BITS;
                }
            } else {
                // The byte straddles two cells — and wraps to cell 0 from the last one.
                let index2 = if is_last_cell { 0 } else { vector_array_index + 1 };
                let low = (bits_in_vector_cell - vector_offset) as u32;
                let mut xored_byte = 0_u8;
                let mut j = i;
                while j < block.len() {
                    xored_byte ^= block[j];
                    j += WIDTH_IN_BITS;
                }
                self.data[vector_array_index] ^= (xored_byte as u64) << vector_offset;
                self.data[index2] ^= (xored_byte as u64) >> low;
            }

            vector_offset += SHIFT;
            // At most one pass: SHIFT (11) is smaller than the narrowest cell (32), so the offset
            // can never overshoot by a whole cell. `bits_in_vector_cell` is deliberately the width
            // of the cell being LEFT, matching the reference implementation.
            while vector_offset >= bits_in_vector_cell {
                vector_array_index = if is_last_cell { 0 } else { vector_array_index + 1 };
                vector_offset -= bits_in_vector_cell;
            }
        }

        self.shift_so_far =
            (self.shift_so_far + SHIFT * (block.len() % WIDTH_IN_BITS)) % WIDTH_IN_BITS;
        self.length_so_far += block.len() as u64;
    }

    pub fn finalize(self) -> [u8; HASH_BYTES] {
        let mut rgb = [0_u8; HASH_BYTES];
        rgb[0..8].copy_from_slice(&self.data[0].to_le_bytes());
        rgb[8..16].copy_from_slice(&self.data[1].to_le_bytes());
        rgb[16..20].copy_from_slice(&self.data[2].to_le_bytes()[0..4]);

        // The length is XORed into the trailing 8 bytes, so two files that differ only in trailing
        // zero bytes do not collide.
        let length = self.length_so_far.to_le_bytes();
        for (i, byte) in length.iter().enumerate() {
            rgb[HASH_BYTES - length.len() + i] ^= byte;
        }
        rgb
    }
}

/// Graph reports the hash base64-encoded. Written out rather than pulled in as a dependency: it is
/// twelve lines over a fixed 20-byte input, and the alternative is a crate in the bundle for one
/// call site.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Hash a reader in 64 KiB blocks and return the base64 form Graph compares against.
pub fn reader_quick_xor_hash(mut reader: impl std::io::Read) -> Result<String, String> {
    const CHUNK: usize = 64 * 1024;
    let mut hasher = QuickXorHash::new();
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(base64(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::{base64, reader_quick_xor_hash};

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"S"), "Uw==");
        assert_eq!(base64(b"So"), "U28=");
        assert_eq!(base64(b"Sot"), "U290");
        assert_eq!(base64(b"Sotto"), "U290dG8=");
    }

    #[test]
    fn hashes_an_empty_file_as_a_zero_vector() {
        // Nothing folded in and a length of zero: 20 zero bytes.
        assert_eq!(reader_quick_xor_hash(&b""[..]).unwrap(), "AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    }

    #[test]
    fn places_the_first_byte_and_the_length_where_the_format_says() {
        /* Hand-computed rather than copied, because this is the one case small enough to check by
           hand and it pins both halves of the layout at once: a single 0x01 lands in bit 0 of cell
           0 (byte 0 of the digest), and the length 1 is XORed into byte 12 — `WIDTH/8 - 8`. */
        let mut expected = [0_u8; 20];
        expected[0] = 1;
        expected[12] = 1;
        assert_eq!(
            reader_quick_xor_hash(&[0x01_u8][..]).unwrap(),
            super::base64(&expected),
        );
    }

    #[test]
    fn hashes_the_same_whatever_the_block_size() {
        /* The streaming half of the port. A byte's rotation is a function of its offset in the
           whole file, so a `shift_so_far` that did not carry across blocks would give a different
           answer for the same file depending on how the reader happened to chunk it — and the
           reader chunks by 64 KiB, so it would only ever be wrong on files large enough that
           re-uploading them is expensive. Deliberately uses a length that is not a multiple of the
           160-byte period, and blocks that are not either. */
        let data: Vec<u8> = (0..5000_u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        let whole = reader_quick_xor_hash(&data[..]).unwrap();

        for block in [1_usize, 7, 159, 160, 161, 1024] {
            let mut hasher = super::QuickXorHash::new();
            for part in data.chunks(block) {
                hasher.update(part);
            }
            assert_eq!(super::base64(&hasher.finalize()), whole, "block size {block}");
        }
    }

    #[test]
    fn distinguishes_content_of_the_same_length() {
        // The whole point of hashing rather than comparing sizes.
        let a = reader_quick_xor_hash(&b"the same length"[..]).unwrap();
        let b = reader_quick_xor_hash(&b"THE SAME LENGTH"[..]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn distinguishes_reordered_content() {
        // XOR alone is order-blind; the per-position rotation is what stops "ab" and "ba" agreeing.
        assert_ne!(
            reader_quick_xor_hash(&b"ab"[..]).unwrap(),
            reader_quick_xor_hash(&b"ba"[..]).unwrap(),
        );
    }
}
