"""Parameterised Rijndael (any block size 128/192/256 bits, any key 128/192/256).

Why this exists: the master data files are all a multiple of 32 bytes with zero
files at (mod 32) == 16, which rules out a 16-byte block. The metadata names the
class `Fwk.UnityCipher.RijndaelEncryption` and its statics are
    s_bufferKeySize = 0x20   (32 bytes)
    s_blockSize     = 0x100  (256 BITS = 32 bytes)
    s_keySize       = 0x100  (256 bits)
so the cipher is very likely Rijndael with a 256-bit BLOCK — which no standard
library implements (AES is the 128-bit-block special case only).

Everything here is validated against `cryptography`'s AES for (Nb=4, Nk=4) and
(Nb=4, Nk=8) before being trusted for Nb=8.
"""

# ---------------------------------------------------------------- tables
SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]
INV_SBOX = [0] * 256
for i, v in enumerate(SBOX):
    INV_SBOX[v] = i

RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d,0x9a]


def _extend_rcon(n):
    """AES ships 15 round constants; a 256-bit BLOCK schedule needs more, so the
    sequence is continued with its own rule (rcon[i] = xtime(rcon[i-1]))."""
    r = list(RCON)
    while len(r) < n:
        prev = r[-1]
        nxt = (prev << 1) & 0xff
        if prev & 0x80:
            nxt ^= 0x1b
        r.append(nxt)
    return r

# Rijndael ShiftRows offsets depend on the block width (Nb words).
SHIFTS = {4: [0, 1, 2, 3], 6: [0, 1, 2, 3], 8: [0, 1, 3, 4]}


def xtime(a):
    a <<= 1
    return (a ^ 0x1b) & 0xff if a & 0x100 else a


def mul(a, b):
    r = 0
    while b:
        if b & 1:
            r ^= a
        a = xtime(a)
        b >>= 1
    return r & 0xff


class Rijndael:
    """block_bits in (128, 192, 256); key_bits in (128, 192, 256)."""

    def __init__(self, key: bytes, block_bits: int = 128):
        self.Nb = block_bits // 32
        self.Nk = len(key) // 4
        if self.Nb not in SHIFTS:
            raise ValueError(f"unsupported block size {block_bits}")
        if self.Nk not in (4, 6, 8):
            raise ValueError(f"unsupported key size {len(key)*8}")
        self.Nr = max(self.Nb, self.Nk) + 6
        self.block = self.Nb * 4
        self.round_keys = self._expand(key)

    # ------------------------------------------------------------ key schedule
    def _expand(self, key: bytes):
        Nk, Nb, Nr = self.Nk, self.Nb, self.Nr
        w = [list(key[4 * i:4 * i + 4]) for i in range(Nk)]
        total = Nb * (Nr + 1)
        rcon = _extend_rcon(total // Nk + 2)
        for i in range(Nk, total):
            temp = list(w[i - 1])
            if i % Nk == 0:
                temp = temp[1:] + temp[:1]                 # RotWord
                temp = [SBOX[b] for b in temp]             # SubWord
                temp[0] ^= rcon[i // Nk - 1]
            elif Nk > 6 and i % Nk == 4:
                temp = [SBOX[b] for b in temp]
            w.append([w[i - Nk][j] ^ temp[j] for j in range(4)])
        # group into round keys of Nb words
        rks = []
        for r in range(Nr + 1):
            rk = []
            for c in range(Nb):
                rk += w[r * Nb + c]
            rks.append(rk)
        return rks

    # ------------------------------------------------------------ round ops
    def _add_round_key(self, state, rk):
        for i in range(len(state)):
            state[i] ^= rk[i]

    def _sub_bytes(self, state):
        for i in range(len(state)):
            state[i] = SBOX[state[i]]

    def _inv_sub_bytes(self, state):
        for i in range(len(state)):
            state[i] = INV_SBOX[state[i]]

    def _shift_rows(self, s):
        Nb = self.Nb
        out = [0] * (4 * Nb)
        for r in range(4):
            off = SHIFTS[Nb][r]
            for c in range(Nb):
                out[4 * ((c - off) % Nb) + r] = s[4 * c + r]
        s[:] = out

    def _inv_shift_rows(self, s):
        Nb = self.Nb
        out = [0] * (4 * Nb)
        for r in range(4):
            off = SHIFTS[Nb][r]
            for c in range(Nb):
                out[4 * ((c + off) % Nb) + r] = s[4 * c + r]
        s[:] = out

    def _mix_columns(self, s):
        for c in range(self.Nb):
            i = 4 * c
            a = s[i:i + 4]
            s[i + 0] = mul(a[0], 2) ^ mul(a[1], 3) ^ a[2] ^ a[3]
            s[i + 1] = a[0] ^ mul(a[1], 2) ^ mul(a[2], 3) ^ a[3]
            s[i + 2] = a[0] ^ a[1] ^ mul(a[2], 2) ^ mul(a[3], 3)
            s[i + 3] = mul(a[0], 3) ^ a[1] ^ a[2] ^ mul(a[3], 2)

    def _inv_mix_columns(self, s):
        for c in range(self.Nb):
            i = 4 * c
            a = s[i:i + 4]
            s[i + 0] = mul(a[0], 14) ^ mul(a[1], 11) ^ mul(a[2], 13) ^ mul(a[3], 9)
            s[i + 1] = mul(a[0], 9) ^ mul(a[1], 14) ^ mul(a[2], 11) ^ mul(a[3], 13)
            s[i + 2] = mul(a[0], 13) ^ mul(a[1], 9) ^ mul(a[2], 14) ^ mul(a[3], 11)
            s[i + 3] = mul(a[0], 11) ^ mul(a[1], 13) ^ mul(a[2], 9) ^ mul(a[3], 14)

    # ------------------------------------------------------------ public API
    def encrypt_block(self, block: bytes) -> bytes:
        if len(block) != self.block:
            raise ValueError(f"block must be {self.block} bytes")
        s = list(block)
        self._add_round_key(s, self.round_keys[0])
        for r in range(1, self.Nr):
            self._sub_bytes(s)
            self._shift_rows(s)
            self._mix_columns(s)
            self._add_round_key(s, self.round_keys[r])
        self._sub_bytes(s)
        self._shift_rows(s)
        self._add_round_key(s, self.round_keys[self.Nr])
        return bytes(s)

    def decrypt_block(self, block: bytes) -> bytes:
        if len(block) != self.block:
            raise ValueError(f"block must be {self.block} bytes")
        s = list(block)
        self._add_round_key(s, self.round_keys[self.Nr])
        for r in range(self.Nr - 1, 0, -1):
            self._inv_shift_rows(s)
            self._inv_sub_bytes(s)
            self._add_round_key(s, self.round_keys[r])
            self._inv_mix_columns(s)
        self._inv_shift_rows(s)
        self._inv_sub_bytes(s)
        self._add_round_key(s, self.round_keys[0])
        return bytes(s)

    # ------------------------------------------------------------ modes
    def encrypt_ecb(self, data: bytes) -> bytes:
        return b"".join(self.encrypt_block(data[i:i + self.block])
                        for i in range(0, len(data) - len(data) % self.block, self.block))

    def decrypt_ecb(self, data: bytes) -> bytes:
        return b"".join(self.decrypt_block(data[i:i + self.block])
                        for i in range(0, len(data) - len(data) % self.block, self.block))

    def decrypt_cbc(self, data: bytes, iv: bytes) -> bytes:
        out = bytearray()
        prev = iv
        for i in range(0, len(data) - len(data) % self.block, self.block):
            blk = data[i:i + self.block]
            dec = self.decrypt_block(blk)
            out += bytes(a ^ b for a, b in zip(dec, prev))
            prev = blk
        return bytes(out)

    def encrypt_cbc(self, data: bytes, iv: bytes) -> bytes:
        out = bytearray()
        prev = iv
        for i in range(0, len(data) - len(data) % self.block, self.block):
            blk = bytes(a ^ b for a, b in zip(data[i:i + self.block], prev))
            enc = self.encrypt_block(blk)
            out += enc
            prev = enc
        return bytes(out)


# ---------------------------------------------------------------- self-test
def self_test():
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    vectors = [
        # FIPS-197 known-answer vectors (AES = the Nb=4 case)
        ("000102030405060708090a0b0c0d0e0f",
         "00112233445566778899aabbccddeeff",
         "69c4e0d86a7b0430d8cdb78070b4c55a", 128),
        ("000102030405060708090a0b0c0d0e0f1011121314151617",
         "00112233445566778899aabbccddeeff",
         "dda97ca4864cdfe06eaf70a0ec0d7191", 128),
        ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
         "00112233445566778899aabbccddeeff",
         "8ea2b7ca516745bfeafc49904b496089", 128),
    ]
    print("=== known-answer tests (must match FIPS-197) ===")
    ok = True
    for key_hex, pt_hex, ct_hex, bits in vectors:
        r = Rijndael(bytes.fromhex(key_hex), bits)
        got = r.encrypt_block(bytes.fromhex(pt_hex)).hex()
        good = got == ct_hex
        ok &= good
        print(f"  Nb={bits//32} Nk={len(key_hex)//8}  {'PASS' if good else 'FAIL'}  got={got} want={ct_hex}")
        back = Rijndael(bytes.fromhex(key_hex), bits).decrypt_block(bytes.fromhex(ct_hex)).hex()
        good2 = back == pt_hex
        ok &= good2
        print(f"      decrypt {'PASS' if good2 else 'FAIL'} got={back} want={pt_hex}")

    print("\n=== cross-check vs cryptography (random data, both key sizes) ===")
    import os as _os
    for bits in (128, 256):
        for klen in (16, 32):
            key = bytes(range(klen))
            plain = bytes((i * 7 + 3) % 256 for i in range(bits // 8 * 4))
            r = Rijndael(key, bits)
            mine = r.encrypt_ecb(plain)
            e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
            if bits == 128:
                ref = e.update(plain) + e.finalize()
            else:
                ref = None
            tag = "n/a (no AES-256-block)" if ref is None else ("PASS" if mine == ref else "FAIL")
            if ref is not None:
                ok &= mine == ref
            print(f"  block={bits} key={klen*8}  {tag}")

    print("\n=== CBC self-consistency at Nb=8 (encrypt then decrypt) ===")
    for klen in (16, 32):
        key = bytes(range(klen))
        iv = bytes(range(32))
        r = Rijndael(key, 256)
        plain = bytes((i * 11 + 5) % 256 for i in range(32 * 5))
        ct = r.encrypt_cbc(plain, iv)
        back = r.decrypt_cbc(ct, iv)
        good = back == plain
        ok &= good
        print(f"  key={klen*8} bit, Nb=8 CBC round-trip: {'PASS' if good else 'FAIL'}")
    print("\nALL OK" if ok else "\nFAILURES PRESENT")
    return ok


if __name__ == "__main__":
    self_test()
