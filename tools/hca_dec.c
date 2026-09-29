/* hca_dec.c — decode an Our Notes / CRI HCA (or the ACB/AWB containing it) to WAV.
 *
 * Why not vgmstream-cli r2117: on these files it silently emits near-silence while
 * clHCA driven directly decodes the full track (it appears to apply an extra key).
 *
 * Facts this relies on:
 *   - The HCA is a plain standard CRI HCA v3.0; the chunk magics are only |0x80'd,
 *     which clHCA unmasks itself (& 0x7f7f7f7f).  Do NOT "restore" them: the header
 *     carries a CRC16 (poly 0x8005, MSB-first, init 0) over the header AS STORED in
 *     its last two bytes, so touching the header makes clHCA return
 *     HCA_ERROR_CHECKSUM (-3) -> vgmstream's opaque "HCA: unknown format".
 *   - ciph type is 56 with a PER-FILE key derived from the AWB's AFS2 subkey:
 *         eff   = <base key, 见 secrets.json 的 hcaBaseKey> * ((subkey << 16) | ((uint16_t)~subkey + 2))
 *         table = cipher_init56(eff)
 *         plain[i] = table[cipher[i]]      for i >= headerSize
 *     For initialbgm (subkey 0xbd94) this reproduces the live-read table byte-for-byte.
 *   - clHCA_DecodeBlock_unpack() checks the per-block CRC16 BEFORE deciphering, so the
 *     block CRC covers the CIPHERTEXT.  After substituting we rebuild every block's CRC.
 *
 * Usage: hca_dec <in.acb|awb|hca> <out.wav> [subkey_hex] [--float]
 *   Default: 16-bit PCM, peak-normalised to -0.09 dBFS (vgmstream's fixed s16 clips).
 *   Exit code 3 = decoded but some blocks failed (caller should treat as unusable).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include "clhca.c"

/* 基础密钥不写死在源码里：用环境变量 ON_HCA_BASE_KEY（16 进制）传入。
 * 逆向出来的密钥请不要提交进仓库。 */
static uint64_t base_key(void) {
    const char* s = getenv("ON_HCA_BASE_KEY");
    if (!s || !*s) {
        fprintf(stderr, "hca_dec: 缺少环境变量 ON_HCA_BASE_KEY（CRI 基础密钥，16 进制）\n");
        exit(2);
    }
    return strtoull(s, NULL, 16);
}

static long find_afs2(const unsigned char* d, long n) {
    for (long o = 0; o + 16 < n; o++)
        if (memcmp(d + o, "AFS2", 4) == 0) return o;
    return -1;
}

static long find_hca(const unsigned char* d, long n) {
    for (long o = 0; o + 32 < n; o++) {
        if ((d[o] & 0x7F) != 0x48 || (d[o + 1] & 0x7F) != 0x43 ||
            (d[o + 2] & 0x7F) != 0x41 || (d[o + 3] & 0x7F) != 0x00) continue;
        unsigned ver = ((unsigned)d[o + 4] << 8) | d[o + 5];
        unsigned hdr = ((unsigned)d[o + 6] << 8) | d[o + 7];
        if (!(ver == 0x0101 || ver == 0x0102 || ver == 0x0103 || ver == 0x0200 || ver == 0x0300))
            continue;
        if (hdr < 0x20 || hdr > 0x800) continue;
        if ((d[o + 8] & 0x7F) != 0x66 || (d[o + 9] & 0x7F) != 0x6D ||
            (d[o + 10] & 0x7F) != 0x74 || (d[o + 11] & 0x7F) != 0x00) continue;
        return o;
    }
    return -1;
}

static void wav_header(FILE* f, unsigned channels, unsigned rate, unsigned bits, unsigned data_bytes) {
    unsigned byte_rate = rate * channels * bits / 8;
    unsigned short block_align = (unsigned short)(channels * bits / 8);
    unsigned short fmt = (bits == 32) ? 3 : 1;
    unsigned riff = 36 + data_bytes;
    fwrite("RIFF", 1, 4, f);  fwrite(&riff, 4, 1, f);  fwrite("WAVE", 1, 4, f);
    fwrite("fmt ", 1, 4, f);
    { unsigned sz = 16; fwrite(&sz, 4, 1, f); }
    fwrite(&fmt, 2, 1, f);
    fwrite(&channels, 2, 1, f);
    fwrite(&rate, 4, 1, f);
    fwrite(&byte_rate, 4, 1, f);
    fwrite(&block_align, 2, 1, f);
    { unsigned short b = (unsigned short)bits; fwrite(&b, 2, 1, f); }
    fwrite("data", 1, 4, f);  fwrite(&data_bytes, 4, 1, f);
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s <in.acb|awb|hca> <out.wav> [subkey_hex] [--float]\n", argv[0]); return 2; }
    int as_float = 0, have_subkey = 0;
    uint64_t subkey = 0;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--float") == 0) as_float = 1;
        else { subkey = strtoull(argv[i], NULL, 16); have_subkey = (subkey != 0); }
    }

    FILE* f = fopen(argv[1], "rb");
    if (!f) { perror("open"); return 1; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char* file = malloc((size_t)n);
    if (fread(file, 1, (size_t)n, f) != (size_t)n) { perror("read"); return 1; }
    fclose(f);

    long ho = find_hca(file, n);
    if (ho < 0) { fprintf(stderr, "no HCA found in %ld bytes\n", n); return 1; }
    unsigned char* buf = file + ho;
    long hlen = n - ho;

    /* auto-detect the AFS2 subkey when not given */
    if (!have_subkey) {
        long a = find_afs2(file, n);
        if (a >= 0 && a < ho && (ho - a) <= 64) {
            subkey = (uint64_t)buf[a - ho + 0x0E] | ((uint64_t)buf[a - ho + 0x0F] << 8);
            have_subkey = (subkey != 0);
            if (have_subkey) fprintf(stderr, "hca_dec: AFS2 subkey = 0x%04llx\n", (unsigned long long)subkey);
        }
    }

    int hs = clHCA_isOurFile(buf, (unsigned)hlen);
    if (hs <= 0) { fprintf(stderr, "HCA at %ld rejected (isOurFile)\n", ho); return 1; }
    fprintf(stderr, "hca_dec: HCA at offset %ld, header %d\n", ho, hs);

    if (have_subkey) {
        uint64_t eff = base_key() * (((uint64_t)subkey << 16) | ((uint16_t)~subkey + 2u));
        unsigned char tbl[256];
        cipher_init56(tbl, eff);

        unsigned short hdr = (unsigned short)((buf[6] << 8) | buf[7]);
        unsigned short frame_size = (unsigned short)((buf[28] << 8) | buf[29]);
        unsigned int frame_count = ((unsigned)buf[16] << 24) | ((unsigned)buf[17] << 16) |
                                   ((unsigned)buf[18] << 8) | (unsigned)buf[19];
        if (frame_size == 0 || hdr < 8) { fprintf(stderr, "bad header\n"); return 1; }
        long need = (long)hdr + (long)frame_size * frame_count;
        if (need > hlen) { fprintf(stderr, "truncated: need %ld have %ld\n", need, hlen); return 1; }

        for (long i = hdr; i < need; i++) buf[i] = tbl[buf[i]];
        for (unsigned int b = 0; b < frame_count; b++) {
            unsigned char* blk = buf + hdr + (size_t)b * frame_size;
            unsigned short c = crc16_checksum(blk, frame_size - 2);
            blk[frame_size - 2] = (unsigned char)(c >> 8);
            blk[frame_size - 1] = (unsigned char)(c & 0xFF);
        }
        fprintf(stderr, "hca_dec: subkey=0x%04llx eff=0x%016llx  substituted %u blocks\n",
                (unsigned long long)subkey, (unsigned long long)eff, frame_count);
    } else {
        fprintf(stderr, "hca_dec: no subkey -> payload used as-is\n");
    }

    void* h = calloc(1, (size_t)clHCA_sizeof());
    clHCA_clear(h);
    int st = clHCA_DecodeHeader(h, buf, (unsigned)hs);
    if (st < 0) { fprintf(stderr, "DecodeHeader failed: %d\n", st); return 1; }

    clHCA_stInfo info;
    memset(&info, 0, sizeof(info));
    clHCA_getInfo(h, &info);

    unsigned nch = info.channelCount;
    size_t total = (size_t)info.samplesPerBlock * info.blockCount;
    float* all = malloc(sizeof(float) * total * nch);
    float* fbuf = malloc(sizeof(float) * nch * info.samplesPerBlock);
    unsigned off = info.headerSize, bad = 0;

    for (unsigned b = 0; b < info.blockCount; b++) {
        int r = clHCA_DecodeBlock(h, buf + off, info.blockSize);
        if (r < 0) { bad++; if (bad <= 3) fprintf(stderr, "  block %u error %d\n", b, r); }
        clHCA_ReadSamples(h, fbuf);
        memcpy(all + (size_t)b * info.samplesPerBlock * nch, fbuf,
               sizeof(float) * nch * info.samplesPerBlock);
        off += info.blockSize;
    }

    unsigned start = info.encoderDelay;
    unsigned count = (unsigned)total - info.encoderDelay - info.encoderPadding;
    float peak = 0.0f;
    double sumsq = 0.0;
    size_t zc = 0, tot = 0;
    for (size_t i = 0; i < (size_t)count * nch; i++) {
        float v = all[(size_t)start * nch + i];
        float a = fabsf(v);
        if (a > peak) peak = a;
        sumsq += (double)v * v;
        if (v == 0.0f) zc++;
        tot++;
    }
    double rms = sqrt(sumsq / (double)tot);
    fprintf(stderr, "hca_dec: %uch %uHz %u blocks bad=%u  %u frames = %.3f s\n",
            nch, info.samplingRate, info.blockCount, bad, count, (double)count / info.samplingRate);
    fprintf(stderr, "hca_dec: peak=%.4f rms=%.5f exact-zero=%.2f%%\n",
            peak, rms, 100.0 * (double)zc / (double)tot);

    float gain = (peak > 0.99f) ? (0.99f / peak) : 1.0f;
    if (gain != 1.0f) fprintf(stderr, "hca_dec: normalising %.4f (%.2f dB)\n", gain, 20.0 * log10(gain));

    FILE* o = fopen(argv[2], "wb");
    if (!o) { perror("out"); return 1; }
    unsigned bytes = count * nch * (as_float ? 4u : 2u);
    wav_header(o, nch, info.samplingRate, as_float ? 32 : 16, bytes);
    for (size_t i = 0; i < (size_t)count * nch; i++) {
        float v = all[(size_t)start * nch + i] * gain;
        if (as_float) fwrite(&v, 4, 1, o);
        else {
            int s = (int)lrintf(v * 32767.0f);
            if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
            short ss = (short)s;
            fwrite(&ss, 2, 1, o);
        }
    }
    fclose(o);
    free(all); free(fbuf); free(file);
    return bad ? 3 : 0;
}
